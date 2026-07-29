// ─────────────────────────────────────────────────────────────────────────────
// Polar sandbox credit probe — answers the migration gate question:
//   "When a proration CREDIT exceeds the next invoice, does Polar carry it
//    forward as a customer balance (A), refund it to the card (B), or drop it (C)?"
//
// See BILLING_POLAR_CREDIT_SANDBOX_TEST.md for the full plan. This script automates
// the API steps; only the one-time CARD ENTRY is interactive (Polar hosts that).
//
// Usage (run from clickshq-backend/, sandbox only). The repo loads env via Node's
// built-in --env-file (no dotenv dependency), so pass --env-file=.env:
//   npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts env
//   npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts checkout --ext probe-1 --email probe1@example.com --interval year --seats 10
//      → open the printed URL, pay with test card 4242 4242 4242 4242, then:
//   npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts resolve --ext probe-1
//   npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts inspect --ext probe-1          # T0 baseline
//   npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts switch  --sub <sub_id> --to month --behavior prorate   # T2
//   npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts inspect --ext probe-1          # where did the credit land?
//   npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts seats   --sub <sub_id> --seats 6 --behavior next_period # T1/T4
//
// Reuses the repo's env-aware Polar config (POLAR_SERVER, POLAR_SANDBOX_* keys,
// product ids) from server/services/polarService.
// ─────────────────────────────────────────────────────────────────────────────
import { Polar } from "@polar-sh/sdk";
import {
  getPolarServer,
  polarAccessToken,
  isPolarConfigured,
  configuredProductIds,
  teamsRecurringProductId,
} from "../server/services/polarService";

// ── tiny arg parser: `--key value` / `--flag` ────────────────────────────────
function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean> } {
  const [cmd = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { cmd, flags };
}

const { cmd, flags } = parseArgs(process.argv.slice(2));
const str = (k: string): string | undefined => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

// ── formatting helpers ───────────────────────────────────────────────────────
const money = (cents: number | null | undefined, ccy = "usd") =>
  cents == null ? "—" : `${(cents / 100).toFixed(2)} ${ccy.toUpperCase()}`;
const line = (c = "─") => console.log(c.repeat(78));
const H = (t: string) => {
  line();
  console.log(t);
  line();
};

// ── Polar client + REST (sandbox by default) ─────────────────────────────────
function apiBase(): string {
  return getPolarServer() === "production" ? "https://api.polar.sh" : "https://sandbox-api.polar.sh";
}
let _client: Polar | null = null;
function client(): Polar {
  if (!_client) _client = new Polar({ accessToken: polarAccessToken()!, server: getPolarServer() });
  return _client;
}
async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Bearer ${polarAccessToken()}` },
  });
  if (!res.ok) {
    return { __error: `HTTP ${res.status}`, __body: await res.text().catch(() => "") };
  }
  return res.json();
}

/** Hard guard: never create subscriptions / move money against production by accident. */
function assertSafe() {
  if (!isPolarConfigured()) {
    console.error("✗ Polar is not configured. Set POLAR_SANDBOX_ACCESS_TOKEN (+ product ids) in .env.");
    process.exit(1);
  }
  if (getPolarServer() === "production" && flags["allow-production"] !== true) {
    console.error("✗ POLAR_SERVER=production. This probe creates subscriptions and moves money.");
    console.error("  Refusing to run against production. Re-run with --allow-production only if you REALLY mean it.");
    process.exit(1);
  }
}

// ── Polar customer id for an external id (= our user id) ──────────────────────
async function customerIdForExternal(ext: string): Promise<string | null> {
  try {
    const c: any = await client().customers.getExternal({ externalId: ext });
    return c?.id ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────
async function cmdEnv() {
  H("ENV");
  const tok = polarAccessToken();
  console.log(`POLAR_SERVER            : ${getPolarServer()}`);
  console.log(`API base                : ${apiBase()}`);
  console.log(`Access token            : ${tok ? tok.slice(0, 10) + "…(set)" : "MISSING"}`);
  console.log(`Configured?             : ${isPolarConfigured()}`);
  console.log(`Teams MONTHLY product   : ${teamsRecurringProductId("month") ?? "MISSING"}`);
  console.log(`Teams YEARLY product    : ${teamsRecurringProductId("year") ?? "MISSING"}`);
  console.log(`configuredProductIds()  : ${configuredProductIds().join(", ") || "(none)"}`);
}

async function cmdCheckout() {
  assertSafe();
  const ext = str("ext") ?? "probe-1";
  const email = str("email");
  if (!email) {
    console.error("✗ --email <address> required. Polar validates the domain's MX records, so");
    console.error("  reserved domains (example.com/test.com) are rejected. Use a real address,");
    console.error("  e.g. --email you@gmail.com (sandbox receipts go there).");
    process.exit(1);
  }
  const interval = str("interval") === "month" ? "month" : "year";
  // Seat fields are sent ONLY when --seats is passed AND the product is seat-based.
  // Flat-price products reject `min_seats`/`seats`, so default to a plain checkout.
  const seats = str("seats") ? Number(str("seats")) : undefined;
  // --product overrides the env product id (use a throwaway FIXED-price product;
  // Polar can't prorate/switch custom-priced PWYW products).
  const productId = str("product") ?? teamsRecurringProductId(interval);
  if (!productId) {
    console.error(`✗ No product. Pass --product <id> or set POLAR_SANDBOX_PRODUCT_TEAMS_${interval === "year" ? "YEARLY" : "MONTHLY"}.`);
    process.exit(1);
  }
  H(`CHECKOUT — ${interval}${seats ? `, ${seats} seat(s)` : " (flat price)"}, externalCustomerId="${ext}"`);
  const checkout: any = await client().checkouts.create({
    products: [productId],
    successUrl: "http://localhost:5173/billing?status=success&checkout_id={CHECKOUT_ID}",
    customerEmail: email,
    customerName: ext,
    externalCustomerId: ext,
    metadata: { userId: ext, probe: "credit-test" },
    ...(seats && seats > 0 ? { seats, minSeats: 1 } : {}),
  } as any);
  const id = checkout.id;
  const url = checkout.url;
  console.log(`checkout id : ${id}`);
  console.log(`\n  >> OPEN THIS URL and pay with test card 4242 4242 4242 4242 (any future expiry/CVC):\n`);
  console.log(`     ${url}\n`);
  console.log(`Then run:  npx tsx scripts/polar-credit-sandbox-probe.ts resolve --ext ${ext}`);
}

async function cmdResolve() {
  assertSafe();
  const ext = str("ext");
  if (!ext) return console.error("✗ --ext <externalCustomerId> required");
  H(`RESOLVE — subscriptions for externalCustomerId="${ext}"`);
  const result = await client().subscriptions.list({ externalCustomerId: ext } as any);
  let found = 0;
  for await (const page of result as any) {
    const items: any[] = page?.result?.items ?? [];
    for (const s of items) {
      found++;
      console.log(
        `• sub ${s.id}\n` +
          `    status=${s.status} interval=${s.recurringInterval ?? s.recurring_interval} ` +
          `seats=${s.seats ?? 1} amount=${money(s.amount, s.currency)}\n` +
          `    period: ${s.currentPeriodStart ?? s.current_period_start} → ${s.currentPeriodEnd ?? s.current_period_end}\n` +
          `    product=${s.productId ?? s.product?.id} pendingUpdate=${JSON.stringify(s.pendingUpdate ?? s.pending_update ?? null)}`,
      );
    }
  }
  if (!found) console.log("(none yet — has the checkout been paid? give it a few seconds and retry)");
}

async function cmdSwitch() {
  assertSafe();
  const subId = str("sub");
  const to = str("to") === "year" ? "year" : "month";
  const behavior = (str("behavior") ?? "prorate") as "prorate" | "invoice" | "next_period" | "reset";
  const seats = str("seats") ? Number(str("seats")) : undefined;
  if (!subId) return console.error("✗ --sub <subscriptionId> required");
  // --to-product overrides the env target (use a FIXED-price product).
  const productId = str("to-product") ?? teamsRecurringProductId(to);
  if (!productId) return console.error(`✗ No target product. Pass --to-product <id> or set the env product.`);

  H(`SWITCH — sub ${subId} → ${to} product, prorationBehavior="${behavior}"${seats ? `, seats=${seats}` : ""}`);
  try {
    const updated: any = await client().subscriptions.update({
      id: subId,
      subscriptionUpdate: {
        productId,
        prorationBehavior: behavior,
        ...(seats ? { seats } : {}),
      } as any,
    });
    console.log(`✓ updated: status=${updated.status} interval=${updated.recurringInterval ?? updated.recurring_interval} ` +
      `seats=${updated.seats ?? 1} amount=${money(updated.amount, updated.currency)}`);
    console.log(`  pendingUpdate=${JSON.stringify(updated.pendingUpdate ?? updated.pending_update ?? null)}`);
    console.log(`\nNow inspect where any credit landed:  --ext <externalCustomerId>`);
  } catch (err: any) {
    console.error(`✗ update failed: ${err?.message ?? err}`);
    if (err?.body) console.error(JSON.stringify(err.body, null, 2));
  }
}

async function cmdSeats() {
  assertSafe();
  const subId = str("sub");
  const seats = Number(str("seats") ?? "");
  const behavior = (str("behavior") ?? "prorate") as "prorate" | "invoice" | "next_period";
  if (!subId || !Number.isInteger(seats)) return console.error("✗ --sub <id> --seats <int> required");
  H(`SEATS — sub ${subId} → ${seats} seat(s), prorationBehavior="${behavior}"`);
  try {
    const updated: any = await client().subscriptions.update({
      id: subId,
      subscriptionUpdate: { seats, prorationBehavior: behavior } as any,
    });
    console.log(`✓ updated: status=${updated.status} seats=${updated.seats ?? 1} amount=${money(updated.amount, updated.currency)}`);
    console.log(`  pendingUpdate=${JSON.stringify(updated.pendingUpdate ?? updated.pending_update ?? null)}`);
  } catch (err: any) {
    console.error(`✗ update failed: ${err?.message ?? err}`);
    if (err?.body) console.error(JSON.stringify(err.body, null, 2));
  }
}

// The core detector. Dumps orders / refunds / customer / state and prints a
// heuristic A/B/C verdict for "where did the credit go".
async function cmdInspect() {
  assertSafe();
  const ext = str("ext");
  const directCustomer = str("customer-id");
  if (!ext && !directCustomer) return console.error("✗ --ext <externalCustomerId> (or --customer-id) required");

  const customerId = directCustomer ?? (ext ? await customerIdForExternal(ext) : null);
  H(`INSPECT — ext="${ext ?? "—"}" polarCustomerId="${customerId ?? "(none yet)"}"`);
  if (!customerId) {
    console.log("No Polar customer found — has the checkout been completed/paid?");
    return;
  }

  // 1) Orders (invoices) ------------------------------------------------------
  const ordersResp = ext
    ? await apiGet(`/v1/orders/?external_customer_id=${encodeURIComponent(ext)}&limit=50&sorting=-created_at`)
    : await apiGet(`/v1/orders/?customer_id=${customerId}&limit=50&sorting=-created_at`);
  const orders: any[] = ordersResp?.items ?? [];
  console.log(`\nORDERS (${orders.length}):`);
  let negativeOrders = 0;
  for (const o of orders) {
    const amt = o.total_amount ?? o.net_amount ?? o.amount ?? null;
    if (typeof amt === "number" && amt < 0) negativeOrders++;
    console.log(
      `  • ${o.created_at}  ${money(amt, o.currency)}  status=${o.status}  ` +
        `${o.billing_reason ?? ""} ${o.product?.name ?? o.product_id ?? ""}`.trim(),
    );
  }

  // 2) Refunds (card give-backs) ---------------------------------------------
  const refundsResp = await apiGet(`/v1/refunds/?customer_id=${customerId}&limit=50`);
  const refunds: any[] = refundsResp?.items ?? [];
  console.log(`\nREFUNDS (${refunds.length}):`);
  let refundTotal = 0;
  for (const r of refunds) {
    refundTotal += r.amount ?? 0;
    console.log(`  • ${r.created_at}  ${money(r.amount, r.currency)}  status=${r.status}  reason=${r.reason ?? ""}`);
  }

  // 3) Customer + state — hunt for any balance/credit field -------------------
  const customer = await apiGet(`/v1/customers/${customerId}`);
  const state = await apiGet(`/v1/customers/${customerId}/state`);
  const creditHits = findKeys({ customer, state }, /balance|credit/i);
  console.log(`\nCREDIT / BALANCE FIELDS (matching /balance|credit/i):`);
  if (creditHits.length === 0) console.log("  (none found on customer or customer state)");
  else creditHits.forEach((h) => console.log(`  • ${h.path} = ${JSON.stringify(h.value)}`));

  // 4) Heuristic verdict ------------------------------------------------------
  H("VERDICT (heuristic — confirm against the raw dumps below)");
  if (refundTotal > 0) {
    console.log(`⚠  Answer looks like (B): a CARD REFUND of ${money(refundTotal)} was issued.`);
    console.log("   → Violates the 'no cash refund' rule. Migrate only with next_period forced.");
  } else if (creditHits.some((h) => typeof h.value === "number" && h.value !== 0) || negativeOrders > 0) {
    console.log("✓  Answer looks like (A): credit retained in-system (customer balance and/or credit order),");
    console.log("   no card refund. Run the multi-invoice test (T3) to confirm it drains across renewals.");
  } else {
    console.log("?  Inconclusive. No refund, but no obvious carried balance either — could be (C) forfeit,");
    console.log("   or the credit only sits on the next invoice. Inspect the raw dumps + the next renewal.");
  }

  // 5) Raw dumps for manual review -------------------------------------------
  H("RAW: customer");
  console.log(JSON.stringify(customer, null, 2));
  H("RAW: customer state");
  console.log(JSON.stringify(state, null, 2));
}

/** Recursively collect {path,value} for keys matching `re` (skips huge blobs). */
function findKeys(obj: any, re: RegExp, path = "", out: { path: string; value: any }[] = []): { path: string; value: any }[] {
  if (obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (re.test(k) && (typeof v !== "object" || v === null)) out.push({ path: p, value: v });
    if (v && typeof v === "object") findKeys(v, re, p, out);
  }
  return out;
}

function cmdHelp() {
  console.log(`Polar sandbox credit probe — see BILLING_POLAR_CREDIT_SANDBOX_TEST.md

Commands:
  env                                              show resolved Polar config
  checkout --ext <id> --email <e> --interval year|month [--product <id>] [--seats <n>]
                                                   create a subscription checkout (open URL, pay 4242…)
                                                   --product overrides env (use a FIXED-price product)
  resolve  --ext <id>                              list subscriptions for the external customer
  inspect  --ext <id> | --customer-id <id>         dump orders/refunds/balance + A/B/C verdict
  switch   --sub <id> --to month|year [--to-product <id>] --behavior prorate|invoice|next_period [--seats <n>]
  seats    --sub <id> --seats <n> --behavior prorate|next_period

Note: Polar can't prorate/switch CUSTOM-priced (PWYW) products. Create two FIXED-price
recurring products in the sandbox and pass --product / --to-product to test proration.

Safety: refuses to run when POLAR_SERVER=production unless --allow-production.`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────
(async () => {
  try {
    switch (cmd) {
      case "env": await cmdEnv(); break;
      case "checkout": await cmdCheckout(); break;
      case "resolve": await cmdResolve(); break;
      case "switch": await cmdSwitch(); break;
      case "seats": await cmdSeats(); break;
      case "inspect": await cmdInspect(); break;
      default: cmdHelp(); break;
    }
  } catch (err: any) {
    console.error(`\n✗ probe error: ${err?.message ?? err}`);
    if (err?.body) console.error(JSON.stringify(err.body, null, 2));
    process.exit(1);
  }
  process.exit(0);
})();

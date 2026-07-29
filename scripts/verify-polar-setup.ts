// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight check for the Polar billing setup. Polar computes all money, so the
// only things that can be wrong are credentials and product configuration — this
// verifies both against the LIVE Polar API before a deploy.
//
//   npx tsx --env-file=.env scripts/verify-polar-setup.ts
//
// Read-only: it lists and reads products, never creates or charges anything.
// Exits non-zero if anything would break billing in the configured environment.
// ─────────────────────────────────────────────────────────────────────────────
const SERVER = process.env.POLAR_SERVER === "production" ? "production" : "sandbox";
const SANDBOX = SERVER === "sandbox";
const API = SANDBOX ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";

// Same env-resolution rules as server/services/polarService.ts.
const token = SANDBOX
  ? process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN
  : process.env.POLAR_ACCESS_TOKEN;
const webhookSecret = SANDBOX
  ? process.env.POLAR_SANDBOX_WEBHOOK_SECRET || process.env.POLAR_WEBHOOK_SECRET
  : process.env.POLAR_WEBHOOK_SECRET;
const products = {
  monthly: (SANDBOX ? process.env.POLAR_SANDBOX_PRODUCT_TEAMS_MONTHLY : "") || process.env.POLAR_PRODUCT_TEAMS_MONTHLY,
  yearly: (SANDBOX ? process.env.POLAR_SANDBOX_PRODUCT_TEAMS_YEARLY : "") || process.env.POLAR_PRODUCT_TEAMS_YEARLY,
};

// Must match the per-seat prices the pricing UI advertises
// (clickshq-frontend/src/components/ui/BillingSubscription.tsx).
const EXPECTED_CENTS = { monthly: 1200, yearly: 10000 };

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`✗ ${msg}`); };
const pass = (msg: string) => console.log(`✓ ${msg}`);

console.log(`\nPolar setup check — POLAR_SERVER=${SERVER} (${API})\n${"─".repeat(64)}`);

// ── Credentials ───────────────────────────────────────────────────────────────
if (!token) {
  fail(`no access token (set ${SANDBOX ? "POLAR_SANDBOX_ACCESS_TOKEN" : "POLAR_ACCESS_TOKEN"})`);
} else {
  const res = await fetch(`${API}/v1/products/?limit=1`, { headers: { Authorization: `Bearer ${token.trim()}` } });
  if (res.ok) {
    pass("access token accepted by Polar");
  } else {
    const body = await res.text();
    fail(`access token rejected — HTTP ${res.status} ${body.slice(0, 140)}`);
    console.log(`\n  Fix: create a new Organization Access Token at ` +
      `${SANDBOX ? "https://sandbox.polar.sh" : "https://polar.sh"} → Settings → Developers,\n` +
      `  then set ${SANDBOX ? "POLAR_SANDBOX_ACCESS_TOKEN" : "POLAR_ACCESS_TOKEN"} in .env.`);
  }
}

if (!webhookSecret) {
  fail(`no webhook secret (set ${SANDBOX ? "POLAR_SANDBOX_WEBHOOK_SECRET" : "POLAR_WEBHOOK_SECRET"}) — ` +
    `subscription state will never sync; every delivery is rejected with 503`);
} else {
  pass("webhook signing secret present");
}

// ── Products ──────────────────────────────────────────────────────────────────
// Seat changes can only prorate on a RECURRING product with a deterministic price:
// `seat_based` (per-seat tiers — what the Teams plans use) or `fixed`. A
// pay-what-you-want (`custom`) price has no per-seat amount to prorate against, so
// seat and plan changes would silently produce wrong amounts. This is the check
// that matters most.
for (const [interval, id] of Object.entries(products) as ["monthly" | "yearly", string | undefined][]) {
  const varName = SANDBOX ? `POLAR_SANDBOX_PRODUCT_TEAMS_${interval.toUpperCase()}` : `POLAR_PRODUCT_TEAMS_${interval.toUpperCase()}`;
  if (!id) { fail(`${interval}: not configured (${varName})`); continue; }
  if (!token) continue;

  const res = await fetch(`${API}/v1/products/${id}`, { headers: { Authorization: `Bearer ${token.trim()}` } });
  if (!res.ok) { fail(`${interval}: product ${id} unreadable — HTTP ${res.status}`); continue; }

  const p: any = await res.json();
  const wantInterval = interval === "monthly" ? "month" : "year";
  const prices: any[] = (p.prices ?? []).filter((pr: any) => !pr.is_archived);
  const priceKinds = prices.map((pr) => pr.amount_type);
  // seat_based exposes price_per_seat; fixed exposes price_amount. Either prorates.
  const priced = prices.find((pr) => pr.amount_type === "seat_based" || pr.amount_type === "fixed");
  const perSeat = priced?.price_per_seat ?? priced?.price_amount ?? null;

  if (p.is_archived) fail(`${interval}: product "${p.name}" is ARCHIVED`);
  if (!p.is_recurring) fail(`${interval}: "${p.name}" is one-time, not a subscription product`);
  else if (p.recurring_interval !== wantInterval) {
    fail(`${interval}: "${p.name}" renews per ${p.recurring_interval}, expected ${wantInterval}`);
  }

  if (!priced || perSeat == null) {
    fail(`${interval}: "${p.name}" has no seat_based or fixed price (found: ${priceKinds.join(", ") || "none"}). ` +
      `A pay-what-you-want price cannot prorate seat or plan changes.`);
  } else {
    const want = EXPECTED_CENTS[interval];
    if (perSeat !== want) {
      fail(`${interval}: "${p.name}" costs $${(perSeat / 100).toFixed(2)} ${priced.price_currency ?? ""} per seat, ` +
        `but the pricing page advertises $${(want / 100).toFixed(0)} — customers would be charged a different amount than shown`);
    } else {
      pass(`${interval}: "${p.name}" — recurring/${p.recurring_interval}, ${priced.amount_type} $${(perSeat / 100).toFixed(2)}/seat`);
    }
    // Volume tiers beyond the first would make the advertised flat per-seat price wrong.
    const tiers = priced.seat_tiers?.tiers ?? [];
    if (tiers.length > 1) {
      fail(`${interval}: "${p.name}" has ${tiers.length} volume tiers, but the pricing page shows one flat per-seat price`);
    }
  }
}

// ── Deploy-time env sanity ────────────────────────────────────────────────────
const returnUrl = process.env.BILLING_RETURN_URL ?? "";
if (!returnUrl) fail("BILLING_RETURN_URL not set — customers return to http://localhost:5173/billing after paying");
else if (SERVER === "production" && /localhost|127\.0\.0\.1/.test(returnUrl)) {
  fail(`BILLING_RETURN_URL points at localhost (${returnUrl}) while POLAR_SERVER=production`);
} else pass(`return URL: ${returnUrl}`);

// Left over from the retired Clics billing engine — Polar owns renewals now, so
// these no longer do anything and should be deleted from .env to avoid confusion.
const dead = ["BILLING_OFF_SESSION", "BILLING_CRON_SECRET", "POLAR_CHARGE_PRODUCT_ID", "POLAR_SANDBOX_CHARGE_PRODUCT_ID"]
  .filter((k) => process.env[k]);
if (dead.length) console.log(`\nnote: unused since the billing engine was retired — safe to delete: ${dead.join(", ")}`);

console.log("─".repeat(64));
console.log(failures === 0 ? "READY — Polar billing is correctly configured\n" : `NOT READY — ${failures} problem(s) above\n`);
process.exit(failures === 0 ? 0 : 1);

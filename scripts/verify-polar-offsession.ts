// Verify that REAL off-session charging works against Polar before going live.
//
// It resolves the Polar customer for one of our user ids (= externalCustomerId),
// then performs an actual off-session charge (orders.create → orders.finalize)
// against the PWYW charge product — the exact path the renewal/dunning engine
// uses. Use it to prove two things that can ONLY be confirmed against a live Polar
// account:
//   1. off-session charges are ENABLED on the organization, and
//   2. the customer has a SAVED, reusable card (from a prior hosted checkout).
//
// It charges real (sandbox) money, so it defaults to the sandbox server and
// refuses production unless --prod is passed. Run from clickshq-backend:
//   npx tsx scripts/verify-polar-offsession.ts <userId> [--amount=100] [--currency=usd] [--prod]
import fs from "fs";
import path from "path";

// Load .env into process.env (same loader as smoke-billing.ts).
for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const { Polar } = await import("@polar-sh/sdk");
const { polarAccessToken, getPolarServer, chargeProductId, isPolarConfigured } = await import(
  "../server/services/polarService"
);

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const getFlag = (name: string, def: string) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
};

const externalCustomerId = positional[0];
const amountCents = parseInt(getFlag("amount", "100"), 10);
const currency = getFlag("currency", "usd");
const allowProd = flags.has("--prod");

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

if (!externalCustomerId) {
  fail("Usage: tsx scripts/verify-polar-offsession.ts <userId> [--amount=100] [--currency=usd] [--prod]");
}

// ── Diagnostics ─────────────────────────────────────────────────────────────
const server = getPolarServer();
console.log("── Polar off-session verification ──");
console.log(`server:            ${server}`);
console.log(`polar configured:  ${isPolarConfigured()}`);
console.log(`charge product id: ${chargeProductId() ?? "(none — set POLAR_CHARGE_PRODUCT_ID)"}`);
console.log(`external customer: ${externalCustomerId}`);
console.log(`amount:            ${amountCents} ${currency}`);
console.log(`BILLING_OFF_SESSION=${process.env.BILLING_OFF_SESSION ?? "(unset)"}\n`);

if (!isPolarConfigured()) fail("Polar is not configured — set POLAR_ACCESS_TOKEN (or POLAR_SANDBOX_ACCESS_TOKEN).");
const product = chargeProductId();
if (!product) fail("No charge product — set POLAR_CHARGE_PRODUCT_ID (or POLAR_SANDBOX_CHARGE_PRODUCT_ID).");
if (server === "production" && !allowProd) {
  fail("Refusing to charge a REAL card on production. Re-run with --prod if you truly intend to.");
}

const polar = new Polar({ accessToken: polarAccessToken()!, server });

try {
  // 1) Resolve the Polar customer. No customer ⇒ no saved card ⇒ they must
  //    complete a hosted checkout first.
  console.log("→ Resolving Polar customer by external id…");
  let customerId: string;
  try {
    const customer: any = await polar.customers.getExternal({ externalId: externalCustomerId });
    customerId = customer.id;
    console.log(`  ✓ customer ${customerId} (${customer.email ?? "no email"})`);
  } catch {
    fail(
      "No Polar customer for that user id. They have never completed a checkout, so there is no saved card. " +
        "Run a subscribe-checkout first, then re-run this script.",
    );
  }

  // 2) Real off-session charge: create the draft order, then finalize to capture.
  console.log("→ Creating draft order (off-session)…");
  const draft: any = await polar.orders.create({
    customerId,
    productId: product,
    amount: amountCents,
    currency,
    metadata: { source: "verify-polar-offsession" },
  });
  console.log(`  ✓ draft order ${draft.id}`);

  console.log("→ Finalizing order (charging the saved card)…");
  const finalized: any = await polar.orders.finalize({ id: draft.id });
  const status = String(finalized.status ?? "unknown");

  if (status === "paid") {
    console.log(`\n✅ SUCCESS — order ${finalized.id} status="${status}".`);
    console.log("   Off-session charges are ENABLED and the saved card is reusable. You're ready to go live.");
    console.log("   (Refund this test order in the Polar dashboard if needed.)");
    process.exit(0);
  }
  console.log(`\n⚠️  Order finalized but status="${status}" (not "paid"). Inspect it in the Polar dashboard.`);
  process.exit(2);
} catch (err: any) {
  const raw = `${err?.message ?? ""} ${JSON.stringify(err?.body ?? err?.data ?? "")}`.toLowerCase();
  console.error(`\n❌ Charge failed: ${err?.message ?? err}`);
  if (raw.includes("off_session") || raw.includes("off-session") || raw.includes("not ready") || raw.includes("cannot currently accept")) {
    console.error(
      "   → Off-session charges are NOT enabled for this organization. They are a PREVIEW feature available " +
        "only on a PAID Polar plan (Pro/Growth/Scale) and need the org ready for payments. Upgrade the Polar " +
        "org and/or contact Polar support.",
    );
  } else if (raw.includes("payment method") || raw.includes("no card")) {
    console.error("   → The customer has no saved payment method. Complete a hosted checkout first.");
  }
  process.exit(1);
}

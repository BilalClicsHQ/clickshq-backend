// Tests whether a FIXED-price product allows off-session charging of an ARBITRARY
// amount (via the orders.create `amount` override). Creates a one-time fixed-price
// product at $1, then off-session charges $12 against the saved-card customer and
// reports what was actually charged. Run: node scripts/test-fixed-offsession.cjs
const fs = require("fs");
const path = require("path");

for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const EXTERNAL_ID = process.argv[2] || "7533207e-5c75-4a65-8a89-7944d6454a05";
const OVERRIDE = 1200; // try to charge $12 against a $1 fixed product

(async () => {
  const { Polar } = await import("@polar-sh/sdk");
  const accessToken = process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN;
  const polar = new Polar({ accessToken, server: "sandbox" });

  console.log("→ Creating a one-time FIXED-price product ($1)…");
  const product = await polar.products.create({
    name: "Clics off-session charge (fixed $1)",
    prices: [{ amountType: "fixed", priceAmount: 100, priceCurrency: "usd" }],
  });
  console.log(`  ✓ product ${product.id}`);

  console.log("→ Resolving saved-card customer…");
  const customer = await polar.customers.getExternal({ externalId: EXTERNAL_ID });
  console.log(`  ✓ customer ${customer.id} (${customer.email})`);

  console.log(`→ orders.create with amount override = ${OVERRIDE} (product is $100)…`);
  try {
    const draft = await polar.orders.create({ customerId: customer.id, productId: product.id, amount: OVERRIDE, currency: "usd" });
    console.log(`  ✓ draft ${draft.id} (draft amount: ${draft.totalAmount ?? draft.netAmount ?? draft.amount})`);
    const finalized = await polar.orders.finalize({ id: draft.id });
    console.log(`  finalized: status=${finalized.status} charged=${finalized.totalAmount ?? finalized.netAmount ?? finalized.amount}`);
    const charged = finalized.totalAmount ?? finalized.netAmount ?? finalized.amount;
    console.log(
      charged === OVERRIDE
        ? `\n✅ amount OVERRIDE WORKS — charged ${charged}. We can charge arbitrary off-session amounts via a fixed product.`
        : `\n⚠️ amount override IGNORED — charged ${charged} (the product's fixed price). Arbitrary amounts need another approach.`,
    );
  } catch (e) {
    console.error(`  ✗ failed: ${e?.message ?? e}`);
    if (e?.body) console.error("  body:", typeof e.body === "string" ? e.body : JSON.stringify(e.body));
  }
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });

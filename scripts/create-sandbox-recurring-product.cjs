// Creates two RECURRING, pay-what-you-want products in the Polar SANDBOX (monthly
// + yearly) for initial card capture. A recurring product makes Polar SAVE the
// card; the custom price lets us charge the exact seats × per-seat amount. Prints
// the ids + the .env lines to add. Run ONCE: node scripts/create-sandbox-recurring-product.cjs
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

(async () => {
  const { Polar } = await import("@polar-sh/sdk");
  const sb = process.env.POLAR_SERVER !== "production";
  if (!sb) {
    console.error("Refusing to run against production. This script is sandbox-only.");
    process.exit(1);
  }
  const accessToken = process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN;
  const polar = new Polar({ accessToken, server: "sandbox" });

  async function createRecurring(interval) {
    const product = await polar.products.create({
      name: `Clics Teams — ${interval}ly (card capture)`,
      recurringInterval: interval, // "month" | "year"
      prices: [
        {
          amountType: "custom", // pay-what-you-want → we pass the exact amount at checkout
          priceCurrency: "usd",
          minimumAmount: 100, // $1 floor (our real amounts are far higher)
        },
      ],
    });
    return product;
  }

  try {
    console.log("Creating recurring PWYW products in sandbox…\n");
    const monthly = await createRecurring("month");
    console.log(`✓ monthly: ${monthly.id}  ("${monthly.name}")`);
    const yearly = await createRecurring("year");
    console.log(`✓ yearly:  ${yearly.id}  ("${yearly.name}")`);

    console.log("\nAdd these to clickshq-backend/.env:");
    console.log(`POLAR_SANDBOX_PRODUCT_TEAMS_MONTHLY=${monthly.id}`);
    console.log(`POLAR_SANDBOX_PRODUCT_TEAMS_YEARLY=${yearly.id}`);
  } catch (e) {
    console.error("Failed to create products:", e?.message ?? e);
    if (e?.body) console.error("body:", typeof e.body === "string" ? e.body : JSON.stringify(e.body));
    process.exit(1);
  }
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });

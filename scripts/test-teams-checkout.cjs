// Diagnoses why /subscribe-checkout fails: resolves the recurring Teams product
// (env-aware), checks it exists in the active Polar env, and attempts a real
// checkout create with the same params the app uses. Prints the exact error.
// Run: node scripts/test-teams-checkout.cjs
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
  const server = sb ? "sandbox" : "production";
  const accessToken = sb ? process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN : process.env.POLAR_ACCESS_TOKEN;
  const productId =
    ((sb ? process.env.POLAR_SANDBOX_PRODUCT_TEAMS_MONTHLY : "") || process.env.POLAR_PRODUCT_TEAMS_MONTHLY || "").trim();

  console.log(`server: ${server}`);
  console.log(`teams monthly product id: ${productId || "(none)"}\n`);
  if (!productId) {
    console.error("No Teams monthly product id resolved — set POLAR_SANDBOX_PRODUCT_TEAMS_MONTHLY for sandbox.");
    process.exit(1);
  }

  const polar = new Polar({ accessToken, server });

  console.log("→ Fetching product…");
  try {
    const p = await polar.products.get({ id: productId });
    console.log(`  ✓ found: "${p.name}" recurring=${p.isRecurring} interval=${p.recurringInterval ?? "—"} archived=${p.isArchived}`);
    const prices = (p.prices ?? []).map((pr) => ({ type: pr.amountType, amount: pr.priceAmount, interval: pr.recurringInterval }));
    console.table(prices);
  } catch (e) {
    console.error(`  ✗ products.get failed: ${e?.message ?? e}`);
    console.error("  → This product id likely doesn't exist in this Polar environment (production id used in sandbox?).");
  }

  console.log("\n→ Attempting checkout create (same params as the app)…");
  try {
    const checkout = await polar.checkouts.create({
      products: [productId],
      amount: 2400, // 2 seats × $12 (PWYW recurring product)
      requireBillingAddress: true,
      successUrl: "http://localhost:5173/billing?status=success&checkout_id={CHECKOUT_ID}",
      customerEmail: "asadaslam7652@gmail.com",
      externalCustomerId: "diagnostic-user",
      metadata: { kind: "new_subscription", companyId: "diag", userId: "diag", planKey: "teams", interval: "month", seats: 2 },
    });
    console.log(`  ✅ checkout created: ${checkout.url}`);
  } catch (e) {
    console.error(`  ✗ checkouts.create failed: ${e?.message ?? e}`);
    if (e?.body) console.error("  body:", typeof e.body === "string" ? e.body : JSON.stringify(e.body));
    if (e?.error) console.error("  error:", JSON.stringify(e.error));
  }
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });

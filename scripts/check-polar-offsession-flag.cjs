// Read-only probe: does the connected Polar (sandbox) org have off-session charges
// enabled? Reads organization.featureSettings.offSessionChargesEnabled directly,
// and reports saved-card status for existing customers. No charges, no writes.
// Run: node scripts/check-polar-offsession-flag.cjs
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
  const server = process.env.POLAR_SERVER === "production" ? "production" : "sandbox";
  const accessToken =
    server === "sandbox"
      ? process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN
      : process.env.POLAR_ACCESS_TOKEN;
  if (!accessToken) {
    console.error("No Polar access token in .env");
    process.exit(1);
  }
  const polar = new Polar({ accessToken, server });
  console.log(`Polar server: ${server}\n`);

  // ── Organization feature flags ──
  try {
    const res = await polar.organizations.listOrganizations({});
    let printed = 0;
    for await (const page of res) {
      const items = page?.result?.items ?? [];
      for (const org of items) {
        printed++;
        const f = org.featureSettings ?? {};
        console.log(`Organization: ${org.name} (${org.id})`);
        console.table({
          offSessionChargesEnabled: f.offSessionChargesEnabled ?? false,
          resetProrationBehaviorEnabled: f.resetProrationBehaviorEnabled ?? false,
          slackBenefitEnabled: f.slackBenefitEnabled ?? false,
          billingEnabled: f.billingEnabled ?? false,
          seatBasedPricingEnabled: f.seatBasedPricingEnabled ?? false,
        });
        console.log(
          f.offSessionChargesEnabled
            ? "✅ Off-session charges ARE enabled — real renewals/seat-adds can charge the saved card."
            : "⚠️  Off-session charges are NOT enabled — charges (renewals/seat-adds/upgrades) will fail.\n" +
                "   It's a preview feature requiring a PAID Polar plan + payments-ready org.",
        );
      }
      break; // first page is enough
    }
    if (!printed) console.log("No organizations returned for this token.");
  } catch (e) {
    console.error("Could not read organization feature settings:", e?.message ?? e);
  }

  // ── Existing customers + saved cards (proves checkout card-capture) ──
  try {
    console.log("\nCustomers + saved payment methods:");
    const res = await polar.customers.list({ limit: 10 });
    let any = false;
    for await (const page of res) {
      const items = page?.result?.items ?? [];
      for (const c of items) {
        any = true;
        let pmCount = 0;
        try {
          const pmRes = await polar.customers.listPaymentMethods({ id: c.id });
          for await (const pmPage of pmRes) {
            pmCount += (pmPage?.result?.items ?? []).length;
            break;
          }
        } catch {
          pmCount = -1;
        }
        console.log(
          `  • ${c.email ?? c.id} (ext: ${c.externalId ?? "—"}) — saved cards: ${pmCount === -1 ? "n/a" : pmCount}`,
        );
      }
      break;
    }
    if (!any) console.log("  (no customers yet — complete a checkout first to capture a card)");
  } catch (e) {
    console.error("Could not list customers:", e?.message ?? e);
  }
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });

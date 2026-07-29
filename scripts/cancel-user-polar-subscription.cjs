// Cancels (revokes, immediately) all Polar subscriptions for a user's external
// customer id. Default: the asad user. Sandbox-aware. Run:
//   node scripts/cancel-user-polar-subscription.cjs [externalCustomerId]
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

const EXTERNAL_ID = process.argv[2] || "7533207e-5c75-4a65-8a89-7944d6454a05"; // asadaslam7652@gmail.com

(async () => {
  const { Polar } = await import("@polar-sh/sdk");
  const sb = process.env.POLAR_SERVER !== "production";
  const server = sb ? "sandbox" : "production";
  const accessToken = sb ? process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN : process.env.POLAR_ACCESS_TOKEN;
  const polar = new Polar({ accessToken, server });
  console.log(`Polar server: ${server}`);
  console.log(`external customer: ${EXTERNAL_ID}\n`);

  // Collect all subscriptions for this external customer.
  const subs = [];
  const res = await polar.subscriptions.list({ externalCustomerId: EXTERNAL_ID });
  for await (const page of res) {
    for (const s of page?.result?.items ?? []) subs.push(s);
  }

  if (!subs.length) {
    console.log("No Polar subscriptions found for this customer.");
    return;
  }

  console.log(`Found ${subs.length} subscription(s):`);
  for (const s of subs) {
    console.log(`  • ${s.id} status=${s.status} product=${s.product?.name ?? s.productId}`);
  }

  const cancellable = subs.filter((s) => !["canceled", "revoked"].includes(String(s.status)));
  if (!cancellable.length) {
    console.log("\nAll already canceled/revoked — nothing to do.");
    return;
  }

  console.log(`\nRevoking ${cancellable.length} active subscription(s)…`);
  for (const s of cancellable) {
    try {
      const updated = await polar.subscriptions.revoke({ id: s.id });
      console.log(`  ✓ ${s.id} → ${updated.status}`);
    } catch (e) {
      console.error(`  ✗ ${s.id} failed: ${e?.message ?? e}`);
    }
  }
  console.log("\nDone.");
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });

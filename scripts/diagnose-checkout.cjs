// Read-only: lists recent Polar checkouts + orders for the connected org so we can
// tell whether a purchase actually completed (paid order) vs. an abandoned checkout.
// Run: node scripts/diagnose-checkout.cjs
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
    server === "sandbox" ? process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN : process.env.POLAR_ACCESS_TOKEN;
  const polar = new Polar({ accessToken, server });
  console.log(`Polar server: ${server}\n`);

  console.log("Recent CHECKOUTS:");
  try {
    const res = await polar.checkouts.list({ limit: 10 });
    let n = 0;
    for await (const page of res) {
      for (const c of page?.result?.items ?? []) {
        n++;
        console.log(
          `  • ${c.id} status=${c.status} amount=${c.totalAmount ?? c.amount} ext=${c.externalCustomerId ?? "—"} meta.kind=${c.metadata?.kind ?? "—"} created=${c.createdAt ?? "—"}`,
        );
      }
      break;
    }
    if (!n) console.log("  (none)");
  } catch (e) {
    console.error("  checkouts.list failed:", e?.message ?? e);
  }

  console.log("\nRecent ORDERS (paid = a real charge happened):");
  try {
    const res = await polar.orders.list({ limit: 10 });
    let n = 0;
    for await (const page of res) {
      for (const o of page?.result?.items ?? []) {
        n++;
        console.log(
          `  • ${o.id} status=${o.status} paid=${o.paid} amount=${o.totalAmount ?? o.netAmount ?? o.amount} product=${o.product?.name ?? o.productId} created=${o.createdAt ?? "—"}`,
        );
      }
      break;
    }
    if (!n) console.log("  (none — no charge has completed)");
  } catch (e) {
    console.error("  orders.list failed:", e?.message ?? e);
  }
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });

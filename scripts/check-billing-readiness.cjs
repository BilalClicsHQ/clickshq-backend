// Read-only billing readiness check: reports which Polar/billing env vars are set
// (WITHOUT printing secret values), whether real off-session charging would be
// active, and the current row counts in the billing tables. Run:
//   node scripts/check-billing-readiness.cjs
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function readAllEnv() {
  const env = {};
  const lines = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[m[1]] = v;
    }
  }
  return env;
}

const env = readAllEnv();
const isSandbox = env.POLAR_SERVER !== "production";
const accessToken = isSandbox ? env.POLAR_SANDBOX_ACCESS_TOKEN || env.POLAR_ACCESS_TOKEN : env.POLAR_ACCESS_TOKEN;
const chargeProduct = isSandbox
  ? env.POLAR_SANDBOX_CHARGE_PRODUCT_ID || env.POLAR_CHARGE_PRODUCT_ID
  : env.POLAR_CHARGE_PRODUCT_ID;
const offSessionEnabled = Boolean(accessToken) && env.BILLING_OFF_SESSION === "true" && Boolean(chargeProduct);

const mark = (v) => (v ? "✓ set" : "✗ empty");
console.log(`Polar environment: ${isSandbox ? "sandbox" : "production"}\n`);
console.log("Env vars:");
console.table({
  POLAR_SERVER: env.POLAR_SERVER || "(default sandbox)",
  [isSandbox ? "POLAR_SANDBOX_ACCESS_TOKEN" : "POLAR_ACCESS_TOKEN"]: mark(accessToken),
  [isSandbox ? "POLAR_SANDBOX_WEBHOOK_SECRET" : "POLAR_WEBHOOK_SECRET"]: mark(
    isSandbox ? env.POLAR_SANDBOX_WEBHOOK_SECRET || env.POLAR_WEBHOOK_SECRET : env.POLAR_WEBHOOK_SECRET,
  ),
  [isSandbox ? "POLAR_SANDBOX_CHARGE_PRODUCT_ID" : "POLAR_CHARGE_PRODUCT_ID"]: mark(chargeProduct),
  BILLING_OFF_SESSION: env.BILLING_OFF_SESSION || "(unset)",
  BILLING_RETURN_URL: env.BILLING_RETURN_URL || "(unset → http://localhost:5173/billing)",
});

console.log(
  `\nReal off-session charging (chargesLive): ${offSessionEnabled ? "✅ ON — UI uses hosted checkout + real charges" : "⚠️  OFF — UI uses the simulated/direct path"}`,
);

(async () => {
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) return;
  let host = "";
  try { host = new URL(dbUrl).hostname; } catch {}
  const isLocal = ["localhost", "127.0.0.1"].includes(host);
  const pool = new Pool({ connectionString: dbUrl, ssl: isLocal ? false : { rejectUnauthorized: false } });
  try {
    const counts = {};
    for (const t of ["workspace_subscriptions", "billing_invoices", "billing_credit_ledger", "account_credit", "subscriptions"]) {
      try {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
        counts[t] = rows[0].n;
      } catch {
        counts[t] = "(no table)";
      }
    }
    console.log("\nBilling table row counts:");
    console.table(counts);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });

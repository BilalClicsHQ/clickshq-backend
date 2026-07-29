// Wipes the Clics billing-engine tables (test data): subscription/plan, credit
// ledger, invoices, and credit balance. Prints counts BEFORE and AFTER. Touches
// ONLY the 4 engine tables — nothing else. Run: node scripts/clear-billing.cjs
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const TABLES = ["billing_credit_ledger", "billing_invoices", "account_credit", "workspace_subscriptions"];

function readEnv(key) {
  const lines = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && m[1] === key) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  }
}

async function counts(pool) {
  const out = {};
  for (const t of TABLES) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
    out[t] = rows[0].n;
  }
  return out;
}

(async () => {
  const dbUrl = readEnv("DATABASE_URL");
  if (!dbUrl) throw new Error("DATABASE_URL not found in .env");
  let host = "";
  try { host = new URL(dbUrl).hostname; } catch {}
  const isLocal = ["localhost", "127.0.0.1"].includes(host);
  const pool = new Pool({ connectionString: dbUrl, ssl: isLocal ? false : { rejectUnauthorized: false } });

  try {
    console.log("BEFORE:");
    console.table(await counts(pool));

    await pool.query("BEGIN");
    for (const t of TABLES) {
      const res = await pool.query(`DELETE FROM ${t}`);
      console.log(`deleted ${res.rowCount} row(s) from ${t}`);
    }
    await pool.query("COMMIT");

    console.log("\nAFTER:");
    console.table(await counts(pool));
    console.log("Billing data cleared. The workspace is now back to the free plan.");
  } catch (e) {
    await pool.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });

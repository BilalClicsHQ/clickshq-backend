// Deletes the workspace plan/subscription + billing rows for a specific user's
// company (default: the "asad" user). Scoped — touches only that company's rows.
// Run: node scripts/clear-user-billing.cjs [emailLike]
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const EMAIL_LIKE = process.argv[2] || "asad";
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

(async () => {
  const dbUrl = readEnv("DATABASE_URL");
  if (!dbUrl) throw new Error("DATABASE_URL not found in .env");
  let host = "";
  try { host = new URL(dbUrl).hostname; } catch {}
  const isLocal = ["localhost", "127.0.0.1"].includes(host);
  const pool = new Pool({ connectionString: dbUrl, ssl: isLocal ? false : { rejectUnauthorized: false } });

  try {
    const { rows: users } = await pool.query(
      `SELECT id, email, company_id FROM users WHERE email ILIKE $1`,
      [`%${EMAIL_LIKE}%`],
    );
    if (!users.length) {
      console.log(`No users match email ILIKE '%${EMAIL_LIKE}%'.`);
      return;
    }
    console.log("Matched user(s):");
    console.table(users);

    const companyIds = [...new Set(users.map((u) => u.company_id).filter(Boolean))];
    if (!companyIds.length) {
      console.log("Those user(s) have no company_id — nothing to clear.");
      return;
    }

    await pool.query("BEGIN");
    let total = 0;
    for (const t of TABLES) {
      const res = await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::text[])`, [companyIds]);
      total += res.rowCount;
      console.log(`deleted ${res.rowCount} row(s) from ${t}`);
    }
    await pool.query("COMMIT");
    console.log(`\nDone — cleared ${total} billing row(s) for company(ies): ${companyIds.join(", ")}.`);
    console.log("The user's workspace is back to the free plan.");
  } catch (e) {
    await pool.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });

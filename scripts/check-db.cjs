// READ-ONLY DB connectivity check. Proves the Postgres database is reachable and
// lists the billing tables + row counts. No writes. Run: node scripts/check-db.cjs
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

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
  console.log("DB host:", host, isLocal ? "(local)" : "(remote)");
  const pool = new Pool({ connectionString: dbUrl, ssl: isLocal ? false : { rejectUnauthorized: false } });

  try {
    const ping = await pool.query("SELECT 1 AS ok, now() AS server_time");
    console.log("Connection OK. Server time:", ping.rows[0].server_time);

    const tables = ["workspace_subscriptions", "billing_credit_ledger", "billing_invoices", "account_credit"];
    const out = [];
    for (const t of tables) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
      out.push({ table: t, rows: rows[0].n });
    }
    console.table(out);
    console.log("Database is working.");
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error("DB ERROR:", e.message); process.exit(1); });

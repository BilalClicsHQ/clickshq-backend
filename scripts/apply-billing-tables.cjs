// Surgically create ONLY the 4 Clics billing tables — additive, idempotent
// (CREATE TABLE IF NOT EXISTS), no drops, no constraints on existing tables.
// This avoids drizzle-kit push's full-schema diff, which wanted to drop the
// runtime-managed `session` table. Run: `node scripts/apply-billing-tables.cjs`.
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

const SQL = `
CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id varchar NOT NULL,
  plan_key text NOT NULL,
  billing_interval text NOT NULL,
  seats integer NOT NULL DEFAULT 1,
  per_seat_amount integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'active',
  current_period_start timestamp NOT NULL,
  current_period_end timestamp NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamp,
  polar_customer_id text,
  polar_charge_product_id text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_credit_ledger (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id varchar NOT NULL,
  direction text NOT NULL,
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  reason text NOT NULL,
  description text,
  related_invoice_id varchar,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id varchar NOT NULL,
  type text NOT NULL,
  period_start timestamp,
  period_end timestamp,
  plan_key text NOT NULL,
  billing_interval text NOT NULL,
  seats integer NOT NULL,
  subtotal_cents integer NOT NULL,
  credit_applied_cents integer NOT NULL DEFAULT 0,
  total_charged_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'open',
  polar_order_id text,
  period_key text UNIQUE,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_credit (
  company_id varchar PRIMARY KEY,
  balance_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  updated_at timestamp DEFAULT now()
);
`;

(async () => {
  const dbUrl = readEnv("DATABASE_URL");
  if (!dbUrl) throw new Error("DATABASE_URL not found in .env");
  let host = "";
  try { host = new URL(dbUrl).hostname; } catch {}
  const isLocal = ["localhost", "127.0.0.1"].includes(host);
  const pool = new Pool({ connectionString: dbUrl, ssl: isLocal ? false : { rejectUnauthorized: false } });

  try {
    await pool.query(SQL);
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('workspace_subscriptions','billing_credit_ledger','billing_invoices','account_credit')
       ORDER BY table_name`,
    );
    console.log("Billing tables present:");
    console.table(rows);
    console.log(rows.length === 4 ? "OK — all 4 billing tables exist." : `WARNING — expected 4, found ${rows.length}.`);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });

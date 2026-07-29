// Surgically add the dunning/retry columns to workspace_subscriptions and the
// period_key unique constraint to billing_invoices — additive, idempotent, no
// drops. Avoids drizzle-kit push's full-schema diff (which trips on unrelated
// pre-existing drift: "column id is in a primary key"). Run:
//   node scripts/apply-dunning-columns.cjs
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

const ADD_COLUMNS = `
ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS failed_payment_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_payment_error text,
  ADD COLUMN IF NOT EXISTS last_payment_attempt_at timestamp,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamp,
  ADD COLUMN IF NOT EXISTS grace_period_ends_at timestamp;
`;

(async () => {
  const dbUrl = readEnv("DATABASE_URL");
  if (!dbUrl) throw new Error("DATABASE_URL not found in .env");
  let host = "";
  try { host = new URL(dbUrl).hostname; } catch {}
  const isLocal = ["localhost", "127.0.0.1"].includes(host);
  const pool = new Pool({ connectionString: dbUrl, ssl: isLocal ? false : { rejectUnauthorized: false } });

  try {
    // 1) Dunning columns.
    await pool.query(ADD_COLUMNS);
    console.log("✓ dunning columns ensured on workspace_subscriptions");

    // 2) period_key unique constraint — only if absent AND no duplicates exist.
    const existing = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'billing_invoices_period_key_unique'`,
    );
    if (existing.rowCount > 0) {
      console.log("✓ billing_invoices_period_key_unique already present");
    } else {
      const dups = await pool.query(
        `SELECT period_key, count(*) AS n FROM billing_invoices
         WHERE period_key IS NOT NULL GROUP BY period_key HAVING count(*) > 1`,
      );
      if (dups.rowCount > 0) {
        console.warn("⚠ skipping unique constraint — duplicate period_key values exist:");
        console.table(dups.rows);
      } else {
        await pool.query(
          `ALTER TABLE billing_invoices ADD CONSTRAINT billing_invoices_period_key_unique UNIQUE (period_key)`,
        );
        console.log("✓ added billing_invoices_period_key_unique");
      }
    }

    // 3) Verify the columns landed.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'workspace_subscriptions'
         AND column_name IN ('failed_payment_count','last_payment_error','last_payment_attempt_at','next_retry_at','grace_period_ends_at')
       ORDER BY column_name`,
    );
    console.log("\nDunning columns present:");
    console.table(rows);
    console.log(rows.length === 5 ? "OK — all 5 dunning columns exist." : `WARNING — expected 5, found ${rows.length}.`);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });

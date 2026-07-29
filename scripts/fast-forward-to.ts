// Repositions a workspace subscription so a given number of DAYS REMAIN in the
// current 30-day period, then previews a seat add/remove at that point.
// PREVIEW ONLY — no charge. Run:
//   npx tsx scripts/fast-forward-to.ts [daysRemaining=1] [emailLike]
import fs from "fs";
import path from "path";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const DAYS_REMAINING = Number(process.argv[2] ?? 1);
const EMAIL_LIKE = process.argv[3] || "asadaslam7652";
const PERIOD_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const $ = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`;

const { billingStorage } = await import("../server/storage/billingStorage");
const { preview } = await import("../server/services/billingEngineService");
const { pool } = await import("../server/db");

try {
  const { rows } = await pool.query(
    `SELECT email, company_id FROM users WHERE email ILIKE $1 AND company_id IS NOT NULL LIMIT 1`,
    [`%${EMAIL_LIKE}%`],
  );
  const companyId = rows[0]?.company_id;
  if (!companyId) { console.log(`No company for '%${EMAIL_LIKE}%'.`); process.exit(1); }
  const sub = await billingStorage.getActiveWorkspaceSubscription(companyId);
  if (!sub) { console.log("No active subscription."); process.exit(1); }

  const now = new Date();
  const start = new Date(now.getTime() - (PERIOD_DAYS - DAYS_REMAINING) * DAY);
  const end = new Date(now.getTime() + DAYS_REMAINING * DAY);
  await billingStorage.updateWorkspaceSubscription(sub.id, { currentPeriodStart: start, currentPeriodEnd: end });

  const remFrac = DAYS_REMAINING / PERIOD_DAYS;
  console.log(`user: ${rows[0].email}  seats: ${sub.seats}  perSeat: ${$(sub.perSeatAmount)}`);
  console.log(`→ Period ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}  (${DAYS_REMAINING}/${PERIOD_DAYS} days left, remFrac ≈ ${remFrac.toFixed(4)})\n`);

  const addQ = await preview(companyId, { kind: "seats", seats: sub.seats + 1 });
  const remQ = await preview(companyId, { kind: "seats", seats: Math.max(1, sub.seats - 1) });

  console.log("End-of-cycle previews (NOT applied — no charge):");
  console.table([
    { change: `add 1 seat (→ ${sub.seats + 1})`, direction: addQ.direction, gross: $(addQ.grossCents), netCharge: $(addQ.netChargeCents) },
    { change: `remove 1 seat (→ ${Math.max(1, sub.seats - 1)})`, direction: remQ.direction, gross: $(remQ.grossCents), netCharge: $(remQ.netChargeCents) },
  ]);
  console.log(
    `\nWith ${DAYS_REMAINING} day left, a mid-cycle seat change is tiny (perSeat × ${remFrac.toFixed(4)} = ${$(Math.round(sub.perSeatAmount * remFrac))}). ` +
      `The full price kicks in at the next renewal (${end.toISOString().slice(0, 10)}).`,
  );
} catch (e: any) {
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
} finally {
  await pool.end();
}

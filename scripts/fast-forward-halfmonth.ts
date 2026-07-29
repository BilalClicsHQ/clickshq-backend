// Repositions a workspace subscription so "now" is the MIDPOINT of the current
// billing period (15 of 30 days elapsed → proration ≈ 0.5), then previews what a
// seat add/remove would charge/credit at that point. PREVIEW ONLY — no charge.
// Run: npx tsx scripts/fast-forward-halfmonth.ts [emailLike]
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

const EMAIL_LIKE = process.argv[2] || "asadaslam7652";
const $ = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`;
const DAY = 24 * 60 * 60 * 1000;

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

  console.log(`user: ${rows[0].email}  seats: ${sub.seats}  perSeat: ${$(sub.perSeatAmount)}\n`);

  // Position now at the midpoint of a 30-day period.
  const now = new Date();
  const start = new Date(now.getTime() - 15 * DAY);
  const end = new Date(now.getTime() + 15 * DAY);
  await billingStorage.updateWorkspaceSubscription(sub.id, { currentPeriodStart: start, currentPeriodEnd: end });
  console.log(`→ Period set to ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)} (now = midpoint, ~50% remaining)\n`);

  const addQ = await preview(companyId, { kind: "seats", seats: sub.seats + 1 });
  const remQ = await preview(companyId, { kind: "seats", seats: Math.max(1, sub.seats - 1) });

  console.log("Mid-cycle previews (NOT applied — no charge):");
  console.table([
    { change: `add 1 seat (→ ${sub.seats + 1})`, direction: addQ.direction, gross: $(addQ.grossCents), creditApplied: $(addQ.creditAppliedCents), netCharge: $(addQ.netChargeCents) },
    { change: `remove 1 seat (→ ${Math.max(1, sub.seats - 1)})`, direction: remQ.direction, gross: $(remQ.grossCents), creditApplied: $(remQ.creditAppliedCents), netCharge: $(remQ.netChargeCents) },
  ]);
  console.log(
    `\nAt 50% remaining: add 1 seat ≈ ${$(sub.perSeatAmount)} × 0.5 = ${$(Math.round(sub.perSeatAmount * 0.5))} charge; ` +
      `remove 1 seat ≈ ${$(Math.round(sub.perSeatAmount * 0.5))} credit.`,
  );
  console.log("Refresh the billing page — the Seats panel preview will now show these mid-cycle amounts.");
} catch (e: any) {
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
} finally {
  await pool.end();
}

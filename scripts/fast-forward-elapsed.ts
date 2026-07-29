// Positions the active subscription so N days have ELAPSED in the current period
// (default 30 = "1 month in"), respecting the interval (annual period = 1 year).
// Then previews the key mid-cycle operations. PREVIEW ONLY — no charge. Run:
//   npx tsx scripts/fast-forward-elapsed.ts [daysElapsed=30] [emailLike]
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

const DAYS_ELAPSED = Number(process.argv[2] ?? 30);
const EMAIL_LIKE = process.argv[3] || "asadaslam7652";
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
  const start = new Date(now.getTime() - DAYS_ELAPSED * DAY);
  const end = new Date(start);
  if (sub.billingInterval === "year") end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);

  await billingStorage.updateWorkspaceSubscription(sub.id, { currentPeriodStart: start, currentPeriodEnd: end });
  const totalDays = Math.round((end.getTime() - start.getTime()) / DAY);
  const remainingDays = Math.round((end.getTime() - now.getTime()) / DAY);
  const bal = await billingStorage.getCreditBalance(companyId);

  console.log(`user: ${rows[0].email}`);
  console.log(`plan: ${sub.planKey} ${sub.billingInterval} · ${sub.seats} seats · ${$(sub.perSeatAmount)}/seat · credit ${$(bal)}`);
  console.log(`period: ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}  (${DAYS_ELAPSED}d elapsed, ${remainingDays}/${totalDays}d left)`);
  console.log(`renewal due? ${end <= now ? "YES" : "no — " + remainingDays + " days away"}\n`);

  const other = sub.billingInterval === "year" ? "month" : "year";
  const switchQ = await preview(companyId, { kind: "interval", interval: other as any });
  const addQ = await preview(companyId, { kind: "seats", seats: sub.seats + 1 });
  const remQ = await preview(companyId, { kind: "seats", seats: Math.max(1, sub.seats - 1) });

  console.log("Mid-cycle previews (NOT applied — no charge):");
  console.table([
    { op: `switch to ${other}ly`, direction: switchQ.direction, gross: $(switchQ.grossCents), netCharge: $(switchQ.netChargeCents), result: `${switchQ.resulting.seats} seat(s) ${switchQ.resulting.interval}ly` },
    { op: `add 1 seat (→ ${sub.seats + 1})`, direction: addQ.direction, gross: $(addQ.grossCents), netCharge: $(addQ.netChargeCents), result: "" },
    { op: `remove 1 seat (→ ${Math.max(1, sub.seats - 1)})`, direction: remQ.direction, gross: $(remQ.grossCents), netCharge: $(remQ.netChargeCents), result: "" },
  ]);
  console.log(`\n${switchQ.description}`);
} catch (e: any) {
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
} finally {
  await pool.end();
}

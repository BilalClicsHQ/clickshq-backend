// Fast-forwards a workspace subscription's period end to NOW and runs the real
// renewal cron, so you can watch the off-session charge happen in sandbox. Charges
// REAL (sandbox) money on the saved card. Run:
//   npx tsx scripts/fast-forward-renewal.ts [emailLike]
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

const { billingStorage } = await import("../server/storage/billingStorage");
const { runBillingRenewalCron } = await import("../server/services/billingRenewalService");
const { pool } = await import("../server/db");

try {
  const { rows } = await pool.query(
    `SELECT id, email, company_id FROM users WHERE email ILIKE $1 AND company_id IS NOT NULL LIMIT 1`,
    [`%${EMAIL_LIKE}%`],
  );
  const companyId = rows[0]?.company_id;
  if (!companyId) {
    console.log(`No company found for a user matching '%${EMAIL_LIKE}%'.`);
    process.exit(1);
  }
  console.log(`user: ${rows[0].email}  company: ${companyId}\n`);

  const sub = await billingStorage.getActiveWorkspaceSubscription(companyId);
  if (!sub) {
    console.log("No active workspace subscription — nothing to renew.");
    process.exit(1);
  }

  const balBefore = await billingStorage.getCreditBalance(companyId);
  const invBefore = await billingStorage.getInvoices(companyId, 50);
  console.log("BEFORE:");
  console.log(`  plan=${sub.planKey} seats=${sub.seats} perSeat=${$(sub.perSeatAmount)} interval=${sub.billingInterval} status=${sub.status}`);
  console.log(`  periodEnd=${new Date(sub.currentPeriodEnd).toISOString()}  credit=${$(balBefore)}  invoices=${invBefore.length}`);

  console.log("\n→ Backdating currentPeriodEnd to now so the cron sees it as due…");
  await billingStorage.updateWorkspaceSubscription(sub.id, { currentPeriodEnd: new Date() });

  console.log("→ Running runBillingRenewalCron() (real off-session charge in sandbox)…\n");
  const result = await runBillingRenewalCron();
  console.log("cron result:", result);

  const subAfter = await billingStorage.getWorkspaceSubscriptionById(sub.id);
  const balAfter = await billingStorage.getCreditBalance(companyId);
  const invAfter = await billingStorage.getInvoices(companyId, 50);
  const renewal = invAfter.find((i) => i.type === "renewal" && !invBefore.some((b) => b.id === i.id));

  console.log("\nAFTER:");
  console.log(`  status=${subAfter?.status}  periodStart=${subAfter && new Date(subAfter.currentPeriodStart).toISOString()}  periodEnd=${subAfter && new Date(subAfter.currentPeriodEnd).toISOString()}`);
  console.log(`  credit=${$(balAfter)} (was ${$(balBefore)})`);
  if (renewal) {
    console.log("\nNew RENEWAL invoice:");
    console.table([{
      type: renewal.type,
      subtotal: $(renewal.subtotalCents),
      credit: $(renewal.creditAppliedCents),
      charged: $(renewal.totalChargedCents),
      status: renewal.status,
      polarOrderId: renewal.polarOrderId ?? "(simulated)",
    }]);
    console.log(
      renewal.status === "paid"
        ? `\n✅ Renewal charged ${$(renewal.totalChargedCents)} off-session (subtotal ${$(renewal.subtotalCents)} − credit ${$(renewal.creditAppliedCents)}).`
        : `\n⚠️ Renewal invoice status = ${renewal.status}.`,
    );
  } else {
    console.log("\n⚠️ No new renewal invoice was created — check the cron output above.");
  }
} catch (e: any) {
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
} finally {
  await pool.end();
}

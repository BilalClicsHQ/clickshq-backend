// Billing renewal cron — drives recurring charges ourselves (Polar's auto-renew
// is not used, since it cannot net account credit or reprice cycle switches).
//
// Runs in the standalone server only (setInterval in server/index.ts); on Vercel
// it is invoked via the secret-guarded POST /api/billing/cron/renew endpoint
// (cron does not run in the serverless runtime). Idempotent: renewSubscription()
// guards each period with a unique periodKey, so re-runs never double-charge.
import { billingStorage } from "../storage/billingStorage";
import { renewSubscription, retrySubscription, downgradeExpiredSubscription } from "./billingEngineService";

export interface RenewalCronResult {
  processed: number; // new renewals attempted
  retried: number; // past-due retries attempted
  downgraded: number; // grace-expired subscriptions moved to free
  failed: number; // unexpected errors
}

export async function runBillingRenewalCron(): Promise<RenewalCronResult> {
  const now = new Date();
  let failed = 0;

  // 1) Grace period elapsed → downgrade to free. Do this FIRST so we never retry a
  //    subscription that should already be canceled.
  const expired = await billingStorage.getGraceExpiredSubscriptions(now);
  for (const sub of expired) {
    try {
      await downgradeExpiredSubscription(sub);
    } catch (err: any) {
      failed++;
      console.error(`[billing] downgrade failed for subscription ${sub.id}:`, err?.message ?? err);
    }
  }

  // 2) New renewals (active subscriptions whose period has ended).
  const due = await billingStorage.getDueSubscriptions(now);
  for (const sub of due) {
    try {
      const ownerId = (await billingStorage.getCompanyOwnerUserId(sub.companyId)) ?? "";
      await renewSubscription(sub, ownerId);
    } catch (err: any) {
      failed++;
      console.error(`[billing] renewal failed for subscription ${sub.id}:`, err?.message ?? err);
    }
  }

  // 3) Dunning retries (past_due subscriptions whose next retry is due).
  const retryable = await billingStorage.getRetryableSubscriptions(now);
  for (const sub of retryable) {
    try {
      const ownerId = (await billingStorage.getCompanyOwnerUserId(sub.companyId)) ?? "";
      await retrySubscription(sub, ownerId);
    } catch (err: any) {
      failed++;
      console.error(`[billing] retry failed for subscription ${sub.id}:`, err?.message ?? err);
    }
  }

  if (due.length || retryable.length || expired.length) {
    console.log(
      `[billing] renewal cron: ${due.length} due, ${retryable.length} retried, ${expired.length} downgraded`,
    );
  }
  return { processed: due.length, retried: retryable.length, downgraded: expired.length, failed };
}

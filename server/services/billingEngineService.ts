// ─────────────────────────────────────────────────────────────────────────────
// Billing engine — orchestrates the Clics Billing Logic Brief.
//
// Flow for every operation: read the workspace subscription → compute amounts
// with the pure `shared/billing-math` functions → for charges, apply account
// credit then charge the remainder via the payment gateway → write the invoice +
// ledger and update subscription state. Downgrades NEVER refund — they grant
// account credit that the credit ledger carries to future invoices.
//
// `preview*` returns the quote WITHOUT side effects (drives the UI confirm step);
// `apply*` executes. Pricing here is AUTHORITATIVE (Clics owns the math), unlike
// the display-only prices in shared/entitlements.ts.
// ─────────────────────────────────────────────────────────────────────────────
import {
  prorationFraction,
  monthsUsedCeil,
  seatAddCharge,
  seatRemoveCredit,
  planUpgradeCharge,
  planDowngradeCredit,
  monthlyToAnnualCharge,
  annualToMonthlyCredit,
  applyCredit,
  periodSubtotal,
} from "@shared/billing-math";
import type { WorkspaceSubscription } from "@shared/schema";
import { billingStorage } from "../storage/billingStorage";
import { chargeOffSession, offSessionEnabled } from "./paymentGateway";
import { chargeProductId } from "./polarService";
import { sendPaymentFailedEmail, sendSubscriptionDowngradedEmail } from "../email";

export type BillingInterval = "month" | "year";

// ── Dunning policy ────────────────────────────────────────────────────────────
// On a failed renewal the workspace goes past_due but KEEPS its plan until the
// grace period ends; we retry the off-session charge on a backoff in between.
const GRACE_PERIOD_DAYS = 7;
const RETRY_BACKOFF_DAYS = [1, 2, 2]; // days until next retry, indexed by attempt

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function nextRetryFrom(now: Date, attempt: number): Date {
  const idx = Math.min(Math.max(attempt - 1, 0), RETRY_BACKOFF_DAYS.length - 1);
  return addDays(now, RETRY_BACKOFF_DAYS[idx]);
}

// ── Authoritative seat pricing (cents per seat per interval) ──────────────────
// Teams: $12/seat/mo, $100/seat/yr. Only self-serve paid plans appear here;
// "free"/Individuals has no subscription and "enterprise" is contact-sales
// (handled outside the self-serve engine).
const SEAT_PRICING: Record<string, { month: number; year: number }> = {
  teams: { month: 1200, year: 10000 },
};
const DEFAULT_CURRENCY = "usd";

export function isSelfServePaidPlan(planKey: string): boolean {
  return planKey in SEAT_PRICING;
}

export function perSeatPrice(planKey: string, interval: BillingInterval): number {
  const p = SEAT_PRICING[planKey];
  if (!p) throw new Error(`UNKNOWN_PLAN:${planKey}`);
  return interval === "year" ? p.year : p.month;
}

function addInterval(date: Date, interval: BillingInterval): Date {
  const d = new Date(date);
  if (interval === "year") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

// ── Quote / result shapes ─────────────────────────────────────────────────────
export type ChangeRequest =
  | { kind: "seats"; seats: number }
  | { kind: "plan"; planKey: string }
  | { kind: "interval"; interval: BillingInterval }
  | { kind: "cancel" };

export interface Quote {
  kind: ChangeRequest["kind"];
  direction: "charge" | "credit" | "none";
  /** Gross charge or credit produced by this change (cents), before account credit. */
  grossCents: number;
  creditBalanceCents: number;
  /** For charges: how much existing credit offsets the gross. */
  creditAppliedCents: number;
  /** For charges: what the card is actually charged. */
  netChargeCents: number;
  currency: string;
  description: string;
  resulting: { planKey: string; interval: BillingInterval; seats: number };
}

export interface ApplyResult {
  ok: boolean;
  quote: Quote;
  error?: string;
  invoiceId?: string;
  newCreditBalanceCents: number;
}

export interface BillingState {
  hasSubscription: boolean;
  subscription: WorkspaceSubscription | null;
  creditBalanceCents: number;
  currency: string;
  memberCount: number;
  /** True when real charges are live (Polar off-session). When false, the UI
   * uses the direct/simulated subscribe path instead of a hosted checkout. */
  chargesLive: boolean;
}

// ── State read ────────────────────────────────────────────────────────────────
export async function getBillingState(companyId: string): Promise<BillingState> {
  const [sub, creditBalanceCents, memberCount] = await Promise.all([
    billingStorage.getActiveWorkspaceSubscription(companyId),
    billingStorage.getCreditBalance(companyId),
    billingStorage.getCompanyMemberCount(companyId),
  ]);
  return {
    hasSubscription: !!sub,
    subscription: sub ?? null,
    creditBalanceCents,
    currency: sub?.currency ?? DEFAULT_CURRENCY,
    memberCount,
    chargesLive: offSessionEnabled(),
  };
}

/** First-period total (no proration) for a brand-new subscription — the amount
 *  the initial checkout charges. */
export function newSubscriptionTotalCents(planKey: string, interval: BillingInterval, seats: number): number {
  return periodSubtotal(perSeatPrice(planKey, interval), Math.max(1, Math.floor(seats)));
}

/**
 * Provision a workspace subscription after a successful initial CHECKOUT (real
 * mode). The checkout already charged + saved the card, so this only records
 * state + a paid invoice — it does NOT call the gateway. Idempotent: a no-op if
 * the workspace already has an active subscription (webhooks can retry).
 */
export async function finalizeNewSubscriptionFromCheckout(opts: {
  companyId: string;
  planKey: string;
  interval: BillingInterval;
  seats: number;
  polarCustomerId?: string | null;
  polarOrderId?: string | null;
  amountCents?: number;
}): Promise<void> {
  if (!isSelfServePaidPlan(opts.planKey)) return;
  if (await billingStorage.getActiveWorkspaceSubscription(opts.companyId)) return; // idempotent

  const seats = Math.max(1, Math.floor(opts.seats));
  const perSeat = perSeatPrice(opts.planKey, opts.interval);
  const now = new Date();
  const periodEnd = addInterval(now, opts.interval);
  const subtotal = periodSubtotal(perSeat, seats);

  await billingStorage.createWorkspaceSubscription({
    companyId: opts.companyId,
    planKey: opts.planKey,
    billingInterval: opts.interval,
    seats,
    perSeatAmount: perSeat,
    currency: DEFAULT_CURRENCY,
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    polarCustomerId: opts.polarCustomerId ?? null,
    polarChargeProductId: chargeProductId(),
  });
  await billingStorage.createInvoice({
    companyId: opts.companyId,
    type: "new",
    periodStart: now,
    periodEnd,
    planKey: opts.planKey,
    billingInterval: opts.interval,
    seats,
    subtotalCents: subtotal,
    creditAppliedCents: 0,
    totalChargedCents: opts.amountCents ?? subtotal,
    currency: DEFAULT_CURRENCY,
    status: "paid",
    polarOrderId: opts.polarOrderId ?? null,
  });
}

// ── Pure quote computation (no DB writes, no charges) ─────────────────────────
function computeQuote(sub: WorkspaceSubscription, change: ChangeRequest, nowMs: number, creditBalanceCents: number): Quote {
  const seats = sub.seats;
  const interval = sub.billingInterval as BillingInterval;
  const perSeat = sub.perSeatAmount;
  const startMs = new Date(sub.currentPeriodStart).getTime();
  const endMs = new Date(sub.currentPeriodEnd).getTime();
  const remFrac = prorationFraction(nowMs, startMs, endMs);
  const base = {
    creditBalanceCents,
    currency: sub.currency,
    resulting: { planKey: sub.planKey, interval, seats },
  };
  const charge = (kind: Quote["kind"], gross: number, description: string, resulting: Quote["resulting"]): Quote => {
    const app = applyCredit(gross, creditBalanceCents);
    return {
      kind,
      direction: gross > 0 ? "charge" : "none",
      grossCents: gross,
      creditBalanceCents,
      creditAppliedCents: app.creditUsedCents,
      netChargeCents: app.chargedCents,
      currency: sub.currency,
      description,
      resulting,
    };
  };
  const credit = (kind: Quote["kind"], gross: number, description: string, resulting: Quote["resulting"]): Quote => ({
    kind,
    direction: gross > 0 ? "credit" : "none",
    grossCents: gross,
    creditBalanceCents,
    creditAppliedCents: 0,
    netChargeCents: 0,
    currency: sub.currency,
    description,
    resulting,
  });

  switch (change.kind) {
    case "seats": {
      const newSeats = change.seats;
      if (newSeats === seats) return charge("seats", 0, "No change", { ...base.resulting });
      if (newSeats > seats) {
        const added = newSeats - seats;
        const gross = seatAddCharge(perSeat, added, remFrac);
        return charge("seats", gross, `Add ${added} seat(s), prorated for the rest of the cycle`, {
          ...base.resulting,
          seats: newSeats,
        });
      }
      const removed = seats - newSeats;
      const gross = seatRemoveCredit(perSeat, removed, remFrac);
      return credit("seats", gross, `Remove ${removed} seat(s) — prorated credit (no refund)`, {
        ...base.resulting,
        seats: newSeats,
      });
    }
    case "plan": {
      const newPlan = change.planKey;
      if (newPlan === sub.planKey) return charge("plan", 0, "No change", { ...base.resulting });
      const newPerSeat = perSeatPrice(newPlan, interval);
      if (newPerSeat > perSeat) {
        const gross = planUpgradeCharge(perSeat, newPerSeat, seats, remFrac);
        return charge("plan", gross, `Upgrade to ${newPlan}, prorated price difference`, {
          ...base.resulting,
          planKey: newPlan,
        });
      }
      const gross = planDowngradeCredit(perSeat, newPerSeat, seats, remFrac);
      return credit("plan", gross, `Downgrade to ${newPlan} — prorated credit (no refund)`, {
        ...base.resulting,
        planKey: newPlan,
      });
    }
    case "interval": {
      const target = change.interval;
      if (target === interval) return charge("interval", 0, "No change", { ...base.resulting });
      if (target === "year") {
        // Monthly → Annual (§6): annual total − unused value of current month.
        const monthlyTotal = periodSubtotal(perSeat, seats);
        const annualTotal = periodSubtotal(perSeatPrice(sub.planKey, "year"), seats);
        const gross = monthlyToAnnualCharge(annualTotal, monthlyTotal, remFrac);
        return charge("interval", gross, "Switch to annual billing (credited for unused monthly time)", {
          ...base.resulting,
          interval: "year",
        });
      }
      // Annual → Monthly (§7): used time repriced at monthly; remainder → credit.
      const annualPaid = periodSubtotal(perSeat, seats);
      const monthlyPerSeat = perSeatPrice(sub.planKey, "month");
      const usedMonths = monthsUsedCeil(nowMs, startMs);
      const gross = annualToMonthlyCredit(annualPaid, monthlyPerSeat, seats, usedMonths);
      return credit(
        "interval",
        gross,
        `Switch to monthly — used time repriced at the monthly rate; ${usedMonths} month(s) used`,
        { ...base.resulting, interval: "month" },
      );
    }
    case "cancel":
      return {
        kind: "cancel",
        direction: "none",
        grossCents: 0,
        creditBalanceCents,
        creditAppliedCents: 0,
        netChargeCents: 0,
        currency: sub.currency,
        description: "Cancel at period end — no refund, no credit; active until period end",
        resulting: { ...base.resulting },
      };
  }
}

export async function preview(companyId: string, change: ChangeRequest): Promise<Quote> {
  const sub = await billingStorage.getActiveWorkspaceSubscription(companyId);
  if (!sub) throw new Error("NO_ACTIVE_SUBSCRIPTION");
  const balance = await billingStorage.getCreditBalance(companyId);
  return computeQuote(sub, change, Date.now(), balance);
}

// ── Internal: bill a charge (apply credit → charge net → invoice → consume) ────
async function billCharge(opts: {
  companyId: string;
  actingUserId: string;
  sub: WorkspaceSubscription;
  grossCents: number;
  type: string; // billing_invoices.type
  description: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  seats: number;
  planKey: string;
  interval: BillingInterval;
  periodKey?: string;
}): Promise<{ ok: boolean; invoiceId?: string; creditUsed: number; error?: string }> {
  const balance = await billingStorage.getCreditBalance(opts.companyId);
  const app = applyCredit(opts.grossCents, balance);

  // Charge the remainder on the saved card (simulated in dev / Phase 1).
  // Prefer the currently-configured (fixed-price) charge product over any product
  // id pinned on the subscription row — off-session charges require a fixed-price
  // product, and the env is the source of truth if it was changed.
  const charge = await chargeOffSession({
    externalCustomerId: opts.actingUserId,
    polarCustomerId: opts.sub.polarCustomerId,
    productId: chargeProductId() ?? opts.sub.polarChargeProductId,
    amountCents: app.chargedCents,
    currency: opts.sub.currency,
    description: opts.description,
    metadata: { companyId: opts.companyId, type: opts.type },
  });

  if (!charge.ok) {
    // NOTE: failed invoices deliberately carry NO periodKey — the periodKey is the
    // renewal idempotency guard (one PAID invoice per period) and is unique, so
    // attaching it here would both block dunning retries and collide on the second
    // failure. Only a successful charge claims the periodKey.
    await billingStorage.createInvoice({
      companyId: opts.companyId,
      type: opts.type,
      periodStart: opts.periodStart ?? null,
      periodEnd: opts.periodEnd ?? null,
      planKey: opts.planKey,
      billingInterval: opts.interval,
      seats: opts.seats,
      subtotalCents: opts.grossCents,
      creditAppliedCents: 0,
      totalChargedCents: app.chargedCents,
      currency: opts.sub.currency,
      status: "failed",
      polarOrderId: charge.orderId,
    });
    return { ok: false, creditUsed: 0, error: charge.error };
  }

  // Charge succeeded → consume the credit it offset, then record a paid invoice.
  if (app.creditUsedCents > 0) {
    await billingStorage.consumeCredit(opts.companyId, app.creditUsedCents, undefined, opts.description);
  }
  const invoice = await billingStorage.createInvoice({
    companyId: opts.companyId,
    type: opts.type,
    periodStart: opts.periodStart ?? null,
    periodEnd: opts.periodEnd ?? null,
    planKey: opts.planKey,
    billingInterval: opts.interval,
    seats: opts.seats,
    subtotalCents: opts.grossCents,
    creditAppliedCents: app.creditUsedCents,
    totalChargedCents: app.chargedCents,
    currency: opts.sub.currency,
    status: "paid",
    polarOrderId: charge.orderId,
    periodKey: opts.periodKey,
  });
  return { ok: true, invoiceId: invoice.id, creditUsed: app.creditUsedCents };
}

// ── New subscription (§1) ─────────────────────────────────────────────────────
export async function startSubscription(opts: {
  companyId: string;
  actingUserId: string;
  planKey: string;
  interval: BillingInterval;
  seats: number;
  polarCustomerId?: string | null;
  polarChargeProductId?: string | null;
}): Promise<ApplyResult> {
  const { companyId, actingUserId } = opts;
  if (!isSelfServePaidPlan(opts.planKey)) throw new Error(`UNKNOWN_PLAN:${opts.planKey}`);
  const seats = Math.max(1, Math.floor(opts.seats));
  const perSeat = perSeatPrice(opts.planKey, opts.interval);
  const now = new Date();
  const periodEnd = addInterval(now, opts.interval);
  const subtotal = periodSubtotal(perSeat, seats);

  const sub = await billingStorage.createWorkspaceSubscription({
    companyId,
    planKey: opts.planKey,
    billingInterval: opts.interval,
    seats,
    perSeatAmount: perSeat,
    currency: DEFAULT_CURRENCY,
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    polarCustomerId: opts.polarCustomerId ?? null,
    polarChargeProductId: opts.polarChargeProductId ?? null,
  });

  const res = await billCharge({
    companyId,
    actingUserId,
    sub,
    grossCents: subtotal,
    type: "new",
    description: `New ${opts.planKey} subscription — ${seats} seat(s)`,
    periodStart: now,
    periodEnd,
    seats,
    planKey: opts.planKey,
    interval: opts.interval,
  });

  const balance = await billingStorage.getCreditBalance(companyId);
  const quote: Quote = {
    kind: "seats",
    direction: subtotal > 0 ? "charge" : "none",
    grossCents: subtotal,
    creditBalanceCents: balance + res.creditUsed,
    creditAppliedCents: res.creditUsed,
    netChargeCents: subtotal - res.creditUsed,
    currency: DEFAULT_CURRENCY,
    description: "New subscription",
    resulting: { planKey: opts.planKey, interval: opts.interval, seats },
  };
  return { ok: res.ok, quote, error: res.error, invoiceId: res.invoiceId, newCreditBalanceCents: balance };
}

// ── Apply a change (seats / plan / interval / cancel) ─────────────────────────
export async function apply(companyId: string, actingUserId: string, change: ChangeRequest): Promise<ApplyResult> {
  const sub = await billingStorage.getActiveWorkspaceSubscription(companyId);
  if (!sub) throw new Error("NO_ACTIVE_SUBSCRIPTION");
  const now = new Date();
  const balanceBefore = await billingStorage.getCreditBalance(companyId);
  const quote = computeQuote(sub, change, now.getTime(), balanceBefore);
  const interval = sub.billingInterval as BillingInterval;

  // Cancel — no money, just flag for the cron to finalize at period end (§8).
  if (change.kind === "cancel") {
    await billingStorage.updateWorkspaceSubscription(sub.id, { cancelAtPeriodEnd: true });
    return { ok: true, quote, newCreditBalanceCents: balanceBefore };
  }

  // CREDIT-producing changes: grant credit + apply state immediately, no charge.
  if (quote.direction === "credit") {
    if (change.kind === "seats") {
      const newBal = await billingStorage.addCredit(companyId, quote.grossCents, "seat_removed", quote.description);
      await billingStorage.updateWorkspaceSubscription(sub.id, { seats: quote.resulting.seats });
      return { ok: true, quote, newCreditBalanceCents: newBal };
    }
    if (change.kind === "plan") {
      const newPerSeat = perSeatPrice(quote.resulting.planKey, interval);
      const newBal = await billingStorage.addCredit(companyId, quote.grossCents, "plan_downgrade", quote.description);
      await billingStorage.updateWorkspaceSubscription(sub.id, {
        planKey: quote.resulting.planKey,
        perSeatAmount: newPerSeat,
      });
      return { ok: true, quote, newCreditBalanceCents: newBal };
    }
    // interval → monthly (§7): grant credit, start a fresh monthly period, then
    // immediately bill that first month (credit usually covers it → $0 charged).
    if (change.kind === "interval") {
      await billingStorage.addCredit(companyId, quote.grossCents, "cycle_switch", quote.description);
      const monthlyPerSeat = perSeatPrice(sub.planKey, "month");
      const periodStart = now;
      const periodEnd = addInterval(now, "month");
      await billingStorage.updateWorkspaceSubscription(sub.id, {
        billingInterval: "month",
        perSeatAmount: monthlyPerSeat,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      });
      const refreshed = (await billingStorage.getWorkspaceSubscriptionById(sub.id)) ?? sub;
      const firstMonth = periodSubtotal(monthlyPerSeat, sub.seats);
      await billCharge({
        companyId,
        actingUserId,
        sub: refreshed,
        grossCents: firstMonth,
        type: "cycle_switch",
        description: "First monthly period after switching from annual",
        periodStart,
        periodEnd,
        seats: sub.seats,
        planKey: sub.planKey,
        interval: "month",
      });
      const newBal = await billingStorage.getCreditBalance(companyId);
      return { ok: true, quote, newCreditBalanceCents: newBal };
    }
  }

  // CHARGE-producing changes: charge (credit-offset) then apply state.
  if (change.kind === "seats") {
    const res = await billCharge({
      companyId, actingUserId, sub, grossCents: quote.grossCents, type: "seat_add",
      description: quote.description, seats: quote.resulting.seats, planKey: sub.planKey, interval,
    });
    if (res.ok) await billingStorage.updateWorkspaceSubscription(sub.id, { seats: quote.resulting.seats });
    return { ok: res.ok, quote, error: res.error, invoiceId: res.invoiceId, newCreditBalanceCents: await billingStorage.getCreditBalance(companyId) };
  }
  if (change.kind === "plan") {
    const newPerSeat = perSeatPrice(quote.resulting.planKey, interval);
    const res = await billCharge({
      companyId, actingUserId, sub, grossCents: quote.grossCents, type: "plan_upgrade",
      description: quote.description, seats: sub.seats, planKey: quote.resulting.planKey, interval,
    });
    if (res.ok) await billingStorage.updateWorkspaceSubscription(sub.id, { planKey: quote.resulting.planKey, perSeatAmount: newPerSeat });
    return { ok: res.ok, quote, error: res.error, invoiceId: res.invoiceId, newCreditBalanceCents: await billingStorage.getCreditBalance(companyId) };
  }
  if (change.kind === "interval") {
    // → annual (§6).
    const annualPerSeat = perSeatPrice(sub.planKey, "year");
    const periodStart = now;
    const periodEnd = addInterval(now, "year");
    const res = await billCharge({
      companyId, actingUserId, sub, grossCents: quote.grossCents, type: "cycle_switch",
      description: quote.description, periodStart, periodEnd, seats: sub.seats, planKey: sub.planKey, interval: "year",
    });
    if (res.ok) {
      await billingStorage.updateWorkspaceSubscription(sub.id, {
        billingInterval: "year",
        perSeatAmount: annualPerSeat,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      });
    }
    return { ok: res.ok, quote, error: res.error, invoiceId: res.invoiceId, newCreditBalanceCents: await billingStorage.getCreditBalance(companyId) };
  }

  return { ok: true, quote, newCreditBalanceCents: balanceBefore };
}

// ── Renewal (cron, §1 recurring; §8 finalize cancellation) ────────────────────
export async function renewSubscription(sub: WorkspaceSubscription, actingUserId: string): Promise<void> {
  const interval = sub.billingInterval as BillingInterval;
  const periodStart = new Date(sub.currentPeriodEnd);
  const periodEnd = addInterval(periodStart, interval);
  const periodKey = `${sub.companyId}:${periodStart.toISOString()}`;

  // Idempotency: never bill the same period twice.
  const existing = await billingStorage.getInvoiceByPeriodKey(periodKey);
  if (existing) return;

  // Cancellation finalizes at period end: stop billing, drop to free (§8).
  if (sub.cancelAtPeriodEnd) {
    await billingStorage.updateWorkspaceSubscription(sub.id, { status: "canceled", canceledAt: new Date() });
    return;
  }

  const subtotal = periodSubtotal(sub.perSeatAmount, sub.seats);
  const res = await billCharge({
    companyId: sub.companyId,
    actingUserId,
    sub,
    grossCents: subtotal,
    type: "renewal",
    description: `Renewal — ${sub.seats} seat(s) on ${sub.planKey} (${interval})`,
    periodStart,
    periodEnd,
    seats: sub.seats,
    planKey: sub.planKey,
    interval,
    periodKey,
  });

  if (res.ok) {
    await markChargeSucceeded(sub, periodStart, periodEnd);
  } else {
    await markChargeFailed(sub, res.error, new Date());
  }
}

// ── Dunning: retry a past-due renewal, downgrade after the grace period ────────
// Re-attempt the off-session charge for the still-unpaid period. Same periodKey
// as the original renewal, so a success claims the period idempotently.
export async function retrySubscription(sub: WorkspaceSubscription, actingUserId: string): Promise<void> {
  const interval = sub.billingInterval as BillingInterval;
  const periodStart = new Date(sub.currentPeriodEnd);
  const periodEnd = addInterval(periodStart, interval);
  const periodKey = `${sub.companyId}:${periodStart.toISOString()}`;

  // A prior attempt may have settled already (e.g. webhook landed) → finalize.
  const existing = await billingStorage.getInvoiceByPeriodKey(periodKey);
  if (existing && existing.status === "paid") {
    await markChargeSucceeded(sub, periodStart, periodEnd);
    return;
  }

  const subtotal = periodSubtotal(sub.perSeatAmount, sub.seats);
  const res = await billCharge({
    companyId: sub.companyId,
    actingUserId,
    sub,
    grossCents: subtotal,
    type: "renewal",
    description: `Renewal retry — ${sub.seats} seat(s) on ${sub.planKey} (${interval})`,
    periodStart,
    periodEnd,
    seats: sub.seats,
    planKey: sub.planKey,
    interval,
    periodKey,
  });

  if (res.ok) await markChargeSucceeded(sub, periodStart, periodEnd);
  else await markChargeFailed(sub, res.error, new Date());
}

/** Grace period elapsed with no successful payment → drop to the free plan. */
export async function downgradeExpiredSubscription(sub: WorkspaceSubscription): Promise<void> {
  await billingStorage.updateWorkspaceSubscription(sub.id, {
    status: "canceled",
    canceledAt: new Date(),
    nextRetryAt: null,
  });
  try {
    const contact = await billingStorage.getCompanyOwnerContact(sub.companyId);
    if (contact) {
      await sendSubscriptionDowngradedEmail({
        email: contact.email,
        displayName: contact.displayName,
        planKey: sub.planKey,
      });
    }
  } catch (err: any) {
    console.error("[billing] downgrade email failed:", err?.message ?? err);
  }
}

// Charge succeeded: advance the period, go active, and clear all dunning state.
async function markChargeSucceeded(sub: WorkspaceSubscription, periodStart: Date, periodEnd: Date): Promise<void> {
  await billingStorage.updateWorkspaceSubscription(sub.id, {
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    status: "active",
    failedPaymentCount: 0,
    lastPaymentError: null,
    nextRetryAt: null,
    gracePeriodEndsAt: null,
  });
}

// Charge failed: go past_due, schedule the next retry, set the grace deadline on
// the first failure, and email the workspace owner (best-effort).
async function markChargeFailed(sub: WorkspaceSubscription, error: string | undefined, now: Date): Promise<void> {
  const attempt = (sub.failedPaymentCount ?? 0) + 1;
  const graceEndsAt = sub.gracePeriodEndsAt ?? addDays(now, GRACE_PERIOD_DAYS);
  await billingStorage.updateWorkspaceSubscription(sub.id, {
    status: "past_due",
    failedPaymentCount: attempt,
    lastPaymentError: error ?? "charge failed",
    lastPaymentAttemptAt: now,
    nextRetryAt: nextRetryFrom(now, attempt),
    gracePeriodEndsAt: graceEndsAt,
  });
  try {
    const contact = await billingStorage.getCompanyOwnerContact(sub.companyId);
    if (contact) {
      await sendPaymentFailedEmail({
        email: contact.email,
        displayName: contact.displayName,
        amountCents: periodSubtotal(sub.perSeatAmount, sub.seats),
        currency: sub.currency,
        attempt,
        graceEndsAt,
      });
    }
  } catch (err: any) {
    console.error("[billing] dunning email failed:", err?.message ?? err);
  }
}

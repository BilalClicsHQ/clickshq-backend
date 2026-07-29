// ─────────────────────────────────────────────────────────────────────────────
// Billing math — the pure, deterministic core of the Clics billing engine.
//
// Implements the proration / credit formulas from the Clics Billing Logic Brief.
// INTENTIONALLY pure: no DB, no env, no Date.now() inside — every time value is
// passed in so the functions are 100% unit-testable and reproduce the brief's
// worked examples exactly. Like `shared/entitlements.ts`, this file is mirrored
// BYTE-FOR-BYTE in both repos (`clickshq-backend/shared` and
// `clickshq-frontend/shared`) and imported via the `@shared/*` alias.
//
// ALL money is integer **cents**. Never use floats for stored money — only the
// transient products inside these functions, which are rounded back to cents.
//
// Brief → function map:
//   §2 Add seats        → seatAddCharge        (prorated CHARGE for new seats)
//   §3 Remove seats     → seatRemoveCredit     (prorated CREDIT, no refund)
//   §4 Upgrade plan     → planUpgradeCharge    (prorated CHARGE of price diff)
//   §5 Downgrade plan   → planDowngradeCredit  (prorated CREDIT of price diff)
//   §6 Monthly→Annual   → monthlyToAnnualCharge(annual − unused monthly value)
//   §7 Annual→Monthly   → annualToMonthlyCredit(used time REPRICED at monthly)
//   §9 Apply credit     → applyCredit          (next invoice = subtotal − credit)
// ─────────────────────────────────────────────────────────────────────────────

/** Integer cents. */
export type Cents = number;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days-per-month convention used by the brief's examples (e.g. 20/30, 15/30). */
export const DAYS_PER_MONTH = 30;

// ── Time → fraction helpers ───────────────────────────────────────────────────

/**
 * Fraction of a billing period still REMAINING at `nowMs`, clamped to [0,1].
 * remaining / total. Drives every "prorated for the rest of the cycle" charge
 * or credit.
 */
export function prorationFraction(nowMs: number, periodStartMs: number, periodEndMs: number): number {
  const total = periodEndMs - periodStartMs;
  if (total <= 0) return 0;
  const remaining = periodEndMs - nowMs;
  return Math.max(0, Math.min(1, remaining / total));
}

/** Fraction of a billing period already ELAPSED at `nowMs` (= 1 − remaining). */
export function elapsedFraction(nowMs: number, periodStartMs: number, periodEndMs: number): number {
  return 1 - prorationFraction(nowMs, periodStartMs, periodEndMs);
}

/**
 * Months elapsed since `startMs`, using the brief's 30-day month and rounded UP
 * to the next whole month. Used for annual→monthly repricing (§7): a partly-used
 * month is charged as a full month at the monthly rate, which protects Clics from
 * handing out the annual discount to someone who exits early.
 */
export function monthsUsedCeil(nowMs: number, startMs: number): number {
  const days = Math.max(0, (nowMs - startMs) / DAY_MS);
  return Math.ceil(days / DAYS_PER_MONTH);
}

// ── Seat changes (§2 / §3) ────────────────────────────────────────────────────

/** §2 — prorated CHARGE for adding `addedSeats` for the remainder of the cycle. */
export function seatAddCharge(perSeatCents: Cents, addedSeats: number, remainingFraction: number): Cents {
  if (addedSeats <= 0) return 0;
  return Math.round(perSeatCents * addedSeats * remainingFraction);
}

/** §3 — prorated CREDIT (no refund) for removing `removedSeats` mid-cycle. */
export function seatRemoveCredit(perSeatCents: Cents, removedSeats: number, remainingFraction: number): Cents {
  if (removedSeats <= 0) return 0;
  return Math.round(perSeatCents * removedSeats * remainingFraction);
}

// ── Plan changes (§4 / §5) ────────────────────────────────────────────────────

/** §4 — prorated CHARGE of the per-seat price difference when upgrading plans. */
export function planUpgradeCharge(
  oldPerSeatCents: Cents,
  newPerSeatCents: Cents,
  seats: number,
  remainingFraction: number,
): Cents {
  const diff = newPerSeatCents - oldPerSeatCents;
  if (diff <= 0 || seats <= 0) return 0;
  return Math.round(diff * seats * remainingFraction);
}

/** §5 — prorated CREDIT (no refund) of the price difference when downgrading. */
export function planDowngradeCredit(
  oldPerSeatCents: Cents,
  newPerSeatCents: Cents,
  seats: number,
  remainingFraction: number,
): Cents {
  const diff = oldPerSeatCents - newPerSeatCents;
  if (diff <= 0 || seats <= 0) return 0;
  return Math.round(diff * seats * remainingFraction);
}

// ── Billing-cycle changes (§6 / §7) ───────────────────────────────────────────

/**
 * §6 — Monthly → Annual. Charge the full annual amount minus the unused value of
 * the current monthly period. `monthlyTotalCents` is the whole current monthly
 * invoice (seats × monthly per-seat).
 */
export function monthlyToAnnualCharge(
  annualTotalCents: Cents,
  monthlyTotalCents: Cents,
  remainingFraction: number,
): Cents {
  const unusedMonthly = Math.round(monthlyTotalCents * remainingFraction);
  return Math.max(0, annualTotalCents - unusedMonthly);
}

/**
 * §7 — Annual → Monthly. No refund. The time already used is REPRICED at the
 * standard monthly rate (NOT the discounted annual rate); whatever annual money
 * is left over becomes account credit. Returns the credit to grant.
 */
export function annualToMonthlyCredit(
  annualPaidCents: Cents,
  monthlyPerSeatCents: Cents,
  seats: number,
  usedMonths: number,
): Cents {
  const usedValue = Math.round(monthlyPerSeatCents * seats * Math.max(0, usedMonths));
  return Math.max(0, annualPaidCents - usedValue);
}

// ── Credit application (§9) ───────────────────────────────────────────────────

export interface CreditApplication {
  /** Amount actually charged to the card after credit. */
  chargedCents: Cents;
  /** Credit consumed by this invoice. */
  creditUsedCents: Cents;
  /** Credit balance left over (carries to future invoices). */
  remainingCreditCents: Cents;
}

/**
 * §9 — Apply account credit to an invoice subtotal. Credit can fully cover an
 * invoice (charge $0) and any leftover balance carries forward to future invoices.
 */
export function applyCredit(subtotalCents: Cents, creditBalanceCents: Cents): CreditApplication {
  const subtotal = Math.max(0, subtotalCents);
  const balance = Math.max(0, creditBalanceCents);
  const creditUsed = Math.min(subtotal, balance);
  return {
    chargedCents: subtotal - creditUsed,
    creditUsedCents: creditUsed,
    remainingCreditCents: balance - creditUsed,
  };
}

// ── Convenience ───────────────────────────────────────────────────────────────

/** Full-period subtotal (no proration): seats × per-seat price. */
export function periodSubtotal(perSeatCents: Cents, seats: number): Cents {
  return Math.max(0, perSeatCents) * Math.max(0, seats);
}

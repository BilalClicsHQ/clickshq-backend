# Polar Migration — kill the two-money-systems architecture

**Goal:** Polar computes ALL money (subscriptions, proration, credit, renewals, dunning,
invoices, MRR). Clics only *reads* entitlements from Polar. The custom engine gets deleted, not
rebuilt.

**Why:** two systems computing money = worst-case. One source of truth removes the whole
reconciliation + concurrency bug class.

**Verdict backing this** (see `BILLING_POLAR_CREDIT_SANDBOX_TEST.md`): on fixed-price products
Polar natively does credit-carry-forward + no-refund (Answer A). Migration is viable. Cost: lose
§7 repricing (already accepted).

---

## Phase 0 — Polar setup (dashboard, zero code)
- [ ] Create **fixed-price, seat-based** products: Teams Monthly **$12/seat**, Teams Yearly **$100/seat**. (The current PWYW "card capture" products can't prorate — proven dead-end.)
- [ ] Settings → Subscriptions → default `proration_behavior = prorate` (credit carries, no cash refund).
- [ ] Enable the **Customer Portal** (you already call `createPortalUrl`).
- [ ] Put the new product ids in env: `POLAR_SANDBOX_PRODUCT_TEAMS_*` (sandbox) + `POLAR_PRODUCT_TEAMS_*` (prod).

## Phase 1 — the only code you ADD (small; most already exists)
- [ ] **Checkout:** point pricing CTA → `createCheckout(user, productId, seats)` — *already in `polarService.ts`*.
- [ ] **Seat changes:** use `updateSubscriptionSeats` — *already exists* (the code the brief said it "superseded" comes back; add=`prorate`, remove=`next_period` already set).
- [ ] **Plan / interval / cancel:** redirect to the Polar **customer portal** (`createPortalUrl`). No custom UI. `// ponytail: Polar hosts the manage screen — don't rebuild it`.
- [ ] **Fix `configuredProductIds()`** to use the sandbox fallback like `teamsRecurringProductId()` — else seat lookup misses every sandbox sub (bug found during testing).

## Phase 2 — cutover entitlements  (test env → NO data migration)
- [ ] `entitlementService.ts`: delete `entitlementsFromWorkspace` + its candidate push; keep `entitlementsFromSubscription` (Polar) as the source. (net deletion)
- [ ] Existing subs/credit: **N/A — test environment, nothing to preserve.** Just drop the tables in Phase 3. `ponytail: no migration script, no coupons — there's no prod data`.

## Phase 3 — DELETE (the point)
**Backend**
- [ ] `server/services/billingEngineService.ts`
- [ ] `server/services/billingRenewalService.ts`
- [ ] `server/services/paymentGateway.ts`
- [ ] `server/storage/billingStorage.ts`
- [ ] `billing.routes.ts`: drop `/subscribe /preview /change /credit /invoices /workspace /subscribe-checkout /confirm-checkout /cron/renew` (keep `/config /checkout /portal /seats /orders /subscription`)
- [ ] `server/index.ts`: remove the billing-renewal `setInterval`
- [ ] `polar-webhooks.routes.ts`: remove the `order.paid → finalizeNewSubscriptionFromCheckout` branch (keep `subscription.*` sync)
- [ ] `shared/billing-math.ts`
- [ ] scripts: `billing-math.test.ts`, `fast-forward-*.ts`, `smoke-billing.ts`, `apply-billing-tables.cjs`, `apply-dunning-columns.cjs`, `clear-billing*.cjs`, `provision-from-checkout.ts`
- [ ] `scripts/polar-credit-sandbox-probe.ts` — after Phase 2 verified

**Frontend**
- [ ] `src/queries/billing.ts`: the new-engine hooks (`usePreview/useChange/useCredit/useInvoices/...`)
- [ ] `BillingManagePanel.tsx` preview/apply flow, `BillingInvoices.tsx`, the credit/ledger UI
- [ ] `shared/billing-math.ts` (frontend copy)
- [ ] **Keep** `BillingSubscription.tsx` (pricing) — just repoint its CTA to checkout + portal

**DB — last, after one reconciliation cycle**
- [ ] Drop `workspace_subscriptions`, `billing_credit_ledger`, `billing_invoices`, `account_credit`. `ponytail: rename to *_deprecated for one cycle, then drop — money data, don't hard-delete same day`.

---

## Net
Delete ~4 services + a scripts pile + 4 tables + half the billing routes + the frontend credit UI.
Add almost nothing (checkout + seats already exist; management = Polar portal). **One system
computes money.**

**The only real work is Phase 2** (existing subs + credit balances). Everything else is deletion
or wiring code that already exists.

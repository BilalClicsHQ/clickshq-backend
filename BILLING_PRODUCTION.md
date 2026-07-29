# Going live with billing (Clics engine + Polar)

This is the checklist to flip the **Clics billing engine** (System B — `workspace_subscriptions`,
credit ledger, our own renewals) from the **simulated** payment gateway to **real Polar charges**.

The engine logic is complete; only money movement is gated. The gateway
(`server/services/paymentGateway.ts`) charges for real **only** when:

```ts
isPolarConfigured() && process.env.BILLING_OFF_SESSION === "true" && !!chargeProductId()
```

Until all three are true it records invoices/ledger as if charged but **moves no money** (and logs a
loud `SIMULATED charge …` warning).

---

## 1. Apply the schema change

The dunning/retry fields were added to `workspace_subscriptions`, plus a unique constraint on
`billing_invoices.period_key`. Apply them with the **surgical, idempotent** script:

```bash
cd clickshq-backend && node scripts/apply-dunning-columns.cjs
```

> Do **not** use `npm run db:push` for this — its full-schema diff trips on unrelated pre-existing
> drift (`error: column "id" is in a primary key`) and aborts before applying anything. The script
> above adds only the additive columns/constraint (`ADD COLUMN IF NOT EXISTS`, no drops), the same
> approach as `scripts/apply-billing-tables.cjs`.

New columns: `failed_payment_count`, `last_payment_error`, `last_payment_attempt_at`,
`next_retry_at`, `grace_period_ends_at`.

## 2. Enable off-session charges on the Polar organization

This is the **lynchpin**. Per Polar's [fees page](https://polar.sh/docs/merchant-of-record/fees),
**off-session charges are a PREVIEW feature, and preview features are available only on a PAID Polar
plan** (Pro/Growth/Scale): *"Paid plans also unlock early access to features that are still in
preview. While in preview, each of these is available only on paid plans"* — and "Off-session
charges" is listed there.

So for real off-session charging (renewals, seat-adds, plan-upgrades, annual switch):

- The Polar org must be on a **paid plan** (Pro/Growth/Scale), and
- **verified / ready to accept payments**.

If `orders.create/finalize` returns `OffSessionChargesNotEnabled` / "account can't currently accept
payments", upgrade the org to a paid plan and/or contact **Polar support**. (Sandbox may behave
differently — confirm with the verify script in step 7.)

> Note: credit-only operations (remove seats, downgrade, cancel) do **not** charge off-session, so
> they work even without this. Only operations that charge the saved card need it.

## 3. Create the one-time "charge" product

Off-session charges bill against a **one-time, pay-what-you-want (PWYW)** product (we pass a custom
`amount`). In the Polar dashboard create one and copy its product id into the env below. The initial
hosted checkout uses the same product to capture + save the card.

## 4. Fill the backend `.env`

| Var | Purpose |
|-----|---------|
| `POLAR_SERVER` | `sandbox` (default) or `production` |
| `POLAR_ACCESS_TOKEN` | Organization Access Token (use `POLAR_SANDBOX_ACCESS_TOKEN` in sandbox) |
| `POLAR_WEBHOOK_SECRET` | Webhook signing secret (`POLAR_SANDBOX_WEBHOOK_SECRET` in sandbox) |
| `POLAR_CHARGE_PRODUCT_ID` | **(missing today)** the PWYW charge product from step 3 (`POLAR_SANDBOX_CHARGE_PRODUCT_ID` in sandbox) |
| `BILLING_OFF_SESSION` | **`true`** to charge for real (the master switch) |
| `BILLING_RETURN_URL` | Where Polar returns the customer, e.g. `https://app.clickshq.com/billing` |
| `BILLING_CRON_SECRET` | Shared secret guarding `POST /api/billing/cron/renew` |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | So dunning emails actually send (else they log to console) |

> Sandbox keys fall back to the unprefixed `POLAR_*` keys; production uses the unprefixed keys only.

## 5. Register the webhook

In the Polar dashboard add a webhook → `https://<your-api-host>/api/webhooks/polar` with the signing
secret from step 4. Subscribe to at least: `order.paid`, `order.created`, and the `subscription.*`
events. Raw-body capture is already handled for `/api/webhooks/*`.

`order.paid` with `metadata.kind = "new_subscription"` provisions the workspace subscription
(`finalizeNewSubscriptionFromCheckout`).

## 6. Run the renewal/dunning cron

`runBillingRenewalCron()` does three things each run: downgrade grace-expired subs → renew due subs →
retry past-due subs.

- **Standalone server**: already scheduled every 6h (`server/index.ts`).
- **Vercel** (no cron in serverless): schedule an external/Vercel Cron to call
  `POST /api/billing/cron/renew` with header `x-cron-secret: <BILLING_CRON_SECRET>` (hourly is fine).

## 7. Verify before real customers (sandbox)

Prove off-session works end-to-end. First complete a `subscribe-checkout` for a test user (saves the
card), then:

```bash
cd clickshq-backend
npx tsx scripts/verify-polar-offsession.ts <userId> --amount=100
```

A `✅ SUCCESS` means off-session charges are enabled **and** the saved card is reusable — you're ready.
`OffSessionChargesNotEnabled` → go back to step 2; "no saved card" → the checkout didn't save a card.

---

## How the flow works once live

- **New subscription** → UI calls `useSubscribeCheckout` → `/api/billing/subscribe-checkout` → hosted
  Polar checkout (captures + saves card, charges first period) → `order.paid` webhook provisions the
  `workspace_subscriptions` row + paid invoice.
- **Seat / plan / interval changes** → `/api/billing/change` → engine computes the prorated
  charge/credit → off-session `orders.create/finalize` for charges (credit-offset first). Downgrades
  grant account credit (never a refund).
- **Renewals** → our cron charges the saved card off-session each period (Polar auto-renew is **not**
  used — it can't net account credit).
- **Failed renewal (dunning)** → status `past_due`, kept on-plan during a **7-day grace period**,
  retried on a backoff (1d, 2d, 2d), owner emailed each failure. Grace elapses with no payment →
  downgraded to free + email.

## Dev / simulated mode

Leave `BILLING_OFF_SESSION` unset (or `false`) and use `useSubscribe` → `/api/billing/subscribe` for
direct provisioning with simulated charges. The `chargesLive` flag on `/api/billing/workspace` tells
the UI which path to use, so the frontend switches automatically.

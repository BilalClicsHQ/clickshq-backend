# Phase 2 — Real Polar payments: setup & sandbox test runbook

The Clics billing engine owns all the math + the credit ledger. Polar is only the
payment rail:

- **First purchase** → hosted Polar **checkout** (captures + saves the card, charges the first period).
- **Everything after** (seat add/upgrade/renewal) → **off-session Orders** (`orders.create({ amount }) + finalize()`) on the saved card.

Both use **one** Polar product: a **one-time, pay-what-you-want** product whose `amount` we override per charge.

> Until you complete the steps below, the engine stays in **simulated mode** (no real charges, no Polar calls). Nothing breaks in dev.

---

## 1. Enable off-session charges (beta)
Polar dashboard → **Settings → General → Features** → enable **Off-session charges**
(`off_session_charges_enabled`). If you don't see it, ask Polar support to enable it (it's beta).

## 2. Create the charge product
Dashboard → **Products → New product**:
- Type: **one-time** (NOT a subscription)
- Pricing: **Pay what you want** (custom amount; min e.g. $0.50)
- Name: e.g. `Clics charge`
- Copy its **product id** → `POLAR_CHARGE_PRODUCT_ID`.

(Its configured price is irrelevant — the engine always passes the exact `amount`.)

## 3. Webhook
Dashboard → **Settings → Webhooks → Add endpoint**:
- URL: `https://<your-backend-host>/api/webhooks/polar`
- Events: **order.paid** (plus the `subscription.*` events already handled).
- Copy the **signing secret** → `POLAR_WEBHOOK_SECRET`.
- **Local testing:** Polar must reach your webhook, so expose localhost with a tunnel:
  `ngrok http 4000` (or `cloudflared tunnel --url http://localhost:4000`) and use that URL.

## 4. Env vars (`clickshq-backend/.env`)
```
# Use SANDBOX for testing — do NOT test against production
POLAR_SERVER=sandbox
POLAR_ACCESS_TOKEN=<sandbox org access token>
POLAR_WEBHOOK_SECRET=<webhook signing secret>
POLAR_CHARGE_PRODUCT_ID=<the PWYW one-time product id>

# The switch that flips simulated → real charges
BILLING_OFF_SESSION=true

# Where Polar returns the customer (already used)
BILLING_RETURN_URL=http://localhost:5173/billing

# Secret for the renewal cron endpoint (Vercel / external schedulers)
BILLING_CRON_SECRET=<random string>
```
Restart the backend after editing `.env`.

## 5. Test flow (sandbox)
1. Billing page → **Get Started** on Teams. With `chargesLive` true, it redirects to the Polar checkout.
2. Pay with a Polar/Stripe **test card** (`4242 4242 4242 4242`, any future expiry/CVC).
3. Polar fires **order.paid** → webhook → `finalizeNewSubscriptionFromCheckout` provisions the
   workspace subscription + a paid `new` invoice (and stores `polarCustomerId`).
4. Back on `/billing?status=success`, the page refetches → the **Manage panel** shows Teams + seats.
5. **Add a seat** → off-session order charges the saved card (prorated). **Remove a seat** → credit
   to the ledger (no refund). **Switch cycle** → cred­it/charge per the brief.
6. Inspect with `node scripts/check-db.cjs` or Drizzle Studio.
7. **Renewal:** `curl -X POST https://<host>/api/billing/cron/renew -H "x-cron-secret: <BILLING_CRON_SECRET>"`
   (after temporarily setting a sub's `current_period_end` in the past) → charges `seats×price − credit`.

## 6. ⚠️ The one assumption to verify
This design assumes a **one-time PWYW checkout saves the card** so later off-session orders can charge it.
Confirm in sandbox: after step 2, do an **Add seat** (step 5) and check the off-session order succeeds
(not `PaymentMethodSetupFailed` / "no payment method"). If it fails:
- Option A: have customers add a card via the **Polar customer portal** (`/api/billing/portal`) before off-session charges.
- Option B: switch initial capture to a Polar **subscription** product purely for card-on-file, then cancel its auto-renew (more complex).
Tell me the result and I'll adjust `paymentGateway` / the capture flow accordingly.

## 7. Going to production
Only after sandbox passes: set `POLAR_SERVER=production`, swap to the production access token +
production charge product id + production webhook secret, keep `BILLING_OFF_SESSION=true`.

**Vercel note:** the `setInterval` renewal cron runs only on the standalone server. On Vercel, add a
**Vercel Cron** job hitting `POST /api/billing/cron/renew` daily with the `x-cron-secret` header.

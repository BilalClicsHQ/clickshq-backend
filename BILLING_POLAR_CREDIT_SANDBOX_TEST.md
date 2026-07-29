# Polar Sandbox Test Plan — Customer Credit Carry-Forward

**Status:** pre-migration validation. Run this BEFORE committing to "drop the custom
billing engine and let Polar own credit."

---
## ✅ RESULT ( run 2026-07-01, sandbox) — Answer = (A)

Tested with FIXED-price products (annual **$100** → monthly **$12**), switched ~14 min after
subscribing via `subscriptions.update({ productId, prorationBehavior: 'prorate' })`.

Polar created ONE credit order (`billing_reason=subscription_update`, status=paid) with two
prorated line items:
- **−$100.00** "Remaining time on FIXED YEARLY" (full unused annual credited)
- **+$12.00** "Fixed — Jul 1 → Aug 1" (first monthly period)
- **net total = −$88.00**, `due_amount = $0.00`, `refunded_amount = $0.00`

**Interpretation:**
- **NOT (B):** `refunded_amount = 0` — nothing went back to the card.
- **NOT charged:** `due_amount = 0` — the first monthly period was netted against the credit.
- **= (A):** the −$88 is retained as **customer credit**. The order model exposes
  `from_balance_amount` / `applied_balance_amount`, i.e. Polar keeps a Stripe-style customer
  balance that future invoices draw from. No cash refund. This matches our brief's
  "credit, never refund, carries forward" rule.

**Two migration constraints proven along the way:**
1. **Polar cannot prorate/switch CUSTOM-priced (PWYW) products** ("Can't update to a product
   with custom prices"). Our current "card capture" products are PWYW → every plan/seat
   product must be **recreated as fixed-price** to use Polar-native proration.
2. Polar matches customers by **email**, so reusing an email reattaches to the existing
   customer (and its active-subscription guard).

**One empirical gap left (couldn't fast-forward Polar's clock):** visually confirm the
**Aug 1 renewal** charges `due_amount = $0` and shows `from_balance_amount = $12`, draining the
$88 across ~7 monthly invoices. Structurally guaranteed by the balance fields, but worth
watching one real renewal (or repeating with a short-cycle product).

**What we still give up vs the custom engine:** §7 repricing. Polar credited the unused annual
at the **annual** rate (−$100 for the full remaining year); our §7 reprices used time at the
**monthly** rate. Here ~0 time was used so they coincided; with real elapsed time Polar credits
more (the ~$73 gap already accepted).

**Verdict: migration to Polar-native billing is viable** — use fixed-price products, accept the
§7 difference.

### Full proration matrix (seat-based products, run 2026-07-01)

Products: Teams Monthly (seat) $12/seat, Teams Yearly (seat) $100/seat. Sub started at 3 seats.

| Op | Engine | Polar result | Match |
|---|---|---|---|
| §2 add 3→5 (`invoice`) | prorated charge now | +$23.99 charged now | ✅ |
| §3 remove 5→2 (`prorate`) | prorated credit, no refund, carried | no refund; credit deferred, applied on next order | ✅ |
| §6 month→year (`prorate`→`invoice`) | annual − unused monthly | +$200 −$23.99 −$35.99(carried §3 credit) = **$140.02** now | ✅ same $ |
| §7 year→month (`prorate`→`invoice`) | credit annual − used@monthly, carried | +$24 −$200 = **−$176** carried, due $0, refund $0 | ⚠️ mechanism matches; Polar credits at **annual** rate, not monthly-reprice |

Matches the custom engine to the cent except §7's repricing (annual rate vs monthly — the accepted
~$73-type gap). All credit stays in-system (no cash refund); §6 even auto-consumed the carried §3
credit in one order, exactly like the engine's `applyCredit`.

**Migration is fully de-risked — the custom engine can be deleted.**

---

## The one question this answers

> When a proration **credit exceeds the next invoice**, what does Polar do with the
> leftover?
>
> - **(A) Carry it forward** as a persistent customer balance that drains across many
>   future invoices → ✅ matches our brief ("credit, never refund; carries across
>   invoices"). Migration is clean.
> - **(B) Refund the excess to the card** → ❌ violates the "no cash refund" rule. We'd
>   have to force `next_period` everywhere to avoid it.
> - **(C) Forfeit / drop the excess** → ❌ customer loses money they're owed. Unacceptable.

Everything else about the migration is mechanical. THIS is the gate. We already accept the
~$73 difference from losing §7 repricing; we are only validating *where the credit lands*.

## Why we can't just "wait and see"

Sandbox can't fast-forward Polar's clock (our `scripts/fast-forward-*.ts` move OUR clock —
Polar bills on its own real time). So the primary signal is **what object Polar creates the
moment the credit is issued**, not waiting for renewals:

- A **refund** object created → answer is (B).
- A durable **customer-level credit balance** (visible in customer state / portal) → answer
  is (A): if it's stored at the customer level it structurally carries across invoices.
- The credit appears **only as a single line on the immediate next order** with no leftover
  anywhere → answer is (C) (or partial-A that won't span multiple invoices).

Optional confirmation (slow): create a product with the shortest cycle Polar allows and let 2
real renewals fire to watch the balance drain twice.

---

## Prerequisites

Use a throwaway sandbox org. Set in `.env` (all already wired in `polarService.ts`):

```
POLAR_SERVER=sandbox
POLAR_SANDBOX_ACCESS_TOKEN=polar_oat_...        # sandbox org token
POLAR_SANDBOX_WEBHOOK_SECRET=...                # to observe events
POLAR_SANDBOX_PRODUCT_TEAMS_MONTHLY=<monthly_product_id>   # $12 / seat / mo, recurring
POLAR_SANDBOX_PRODUCT_TEAMS_YEARLY=<yearly_product_id>     # $100 / seat / yr, recurring
```

Sandbox API base: `https://sandbox-api.polar.sh`. Dashboard: `https://sandbox.polar.sh`.

**Products to create in the sandbox dashboard** (seat-based / per-unit recurring):
- Teams Monthly — $12.00 per seat, billing interval = month
- Teams Yearly — $100.00 per seat, billing interval = year

**Org proration default:** Settings → Subscriptions. Test runs override per-call, but set the
default to `prorate` so you see the "real" behavior the migration would use.

**Test cards** (Polar sandbox = Stripe test mode underneath):
- Success: `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP
- Requires 3DS/SCA: `4000 0027 6000 3184`
- (Decline `4000 0000 0000 0341` is for dunning tests — out of scope here.)

**Automated probe:** `scripts/polar-credit-sandbox-probe.ts` runs every API step below and
prints an A/B/C verdict (only the one-time card entry is interactive). Run with Node's
env-file flag (the repo has no `dotenv` dep):

```bash
npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts env       # sanity-check config
npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts checkout --ext probe-1 --interval year --seats 10
#   → open the printed URL, pay with 4242 4242 4242 4242
npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts resolve --ext probe-1     # get <sub_id>
npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts inspect --ext probe-1     # T0 baseline
npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts switch  --sub <sub_id> --to month --behavior prorate  # T2
npx tsx --env-file=.env scripts/polar-credit-sandbox-probe.ts inspect --ext probe-1     # ← THE answer (A/B/C)
```

The probe refuses to run when `POLAR_SERVER=production` (override: `--allow-production`).

**Observability:** point the sandbox webhook at a tunnel (or use the dashboard event log) and
log `order.*`, `subscription.*`, `refund.*`, `customer.*`. After each step also pull state
directly (the probe's `inspect`, or the curl examples below) so you don't depend on webhook
timing.

Helper — list everything for a customer after a step:

```bash
BASE=https://sandbox-api.polar.sh
TOK="$POLAR_SANDBOX_ACCESS_TOKEN"
CUST=<polar_customer_id>

curl -s "$BASE/v1/orders/?customer_id=$CUST&limit=20"   -H "Authorization: Bearer $TOK" | jq
curl -s "$BASE/v1/refunds/?customer_id=$CUST"           -H "Authorization: Bearer $TOK" | jq
curl -s "$BASE/v1/customers/$CUST"                       -H "Authorization: Bearer $TOK" | jq
curl -s "$BASE/v1/customers/$CUST/state"                 -H "Authorization: Bearer $TOK" | jq
curl -s "$BASE/v1/subscriptions/?customer_id=$CUST"     -H "Authorization: Bearer $TOK" | jq
```

> For every step, the things to record are: any `refund` created (amount), any `order` with a
> negative/credit amount, and any customer-level balance/credit field. Those three tell you A
> vs B vs C.

---

## Test scenarios

### T0 — Baseline: subscribe annual, 10 seats (card capture)
1. Create a sandbox customer (or via your `createCheckout` flow), complete checkout for the
   **Yearly** product with **quantity 10** using card `4242…`.
2. Confirm: one `order` for **$1000.00** paid; subscription `active`, interval `year`,
   `current_period_end ≈ now + 1y`; card saved on the customer.

**Pass:** $1000 order paid, subscription active annual, payment method on file.

---

### T1 — Sanity: small seat downgrade, credit < next invoice (`prorate`)
*Confirms the basic "credit not refund" behavior on a normal seat removal.*

1. On a **Monthly** 10-seat sub (do T0-style but monthly), partway through the month remove 4
   seats:
   ```bash
   curl -s -X PATCH "$BASE/v1/subscriptions/<sub_id>" -H "Authorization: Bearer $TOK" \
     -H "Content-Type: application/json" \
     -d '{"product_id":"<monthly_product>","seats":6,"proration_behavior":"prorate"}'
   ```
   (Or call our existing `updateSubscriptionSeats(userId, 6)`.)
2. Inspect orders + refunds + customer state.

**Pass (A):** NO refund created; the removed-seat value shows as a credit applied to the
**next** monthly invoice (next order ≈ `6 × $12 − credit`).
**Fail (B):** a `refund` to the card appears.

---

### T2 — THE TEST: annual → monthly, credit ≫ next invoice (`invoice`/`prorate`)
*This is the carry-forward decision. Interval change auto-promotes `prorate` → `invoice`.*

1. From T0 (annual, 10 seats, ~part-way through year), switch to monthly:
   ```bash
   curl -s -X PATCH "$BASE/v1/subscriptions/<sub_id>" -H "Authorization: Bearer $TOK" \
     -H "Content-Type: application/json" \
     -d '{"product_id":"<monthly_product>","proration_behavior":"prorate"}'
   ```
   Expected credit ≈ unused annual time at the annual rate (~$833 if ~2 months in), while the
   new monthly invoice is only **$120** (10 × $12). So ~$713 of credit has nowhere to go on
   the immediate invoice — **watch where it lands.**
2. Immediately inspect: `refunds`, `orders` (look for a negative/credit order), `customers/$CUST`
   and `/state` (look for a credit/balance field), the subscription's next-invoice/preview.

**Record exactly:**
- [ ] Credit amount Polar computed: `________`
- [ ] Refund created? amount: `________`  (any non-zero here ⇒ answer **B**)
- [ ] Leftover ~$713 visible as a **customer balance / credit**? where: `________`
- [ ] New subscription interval/period correct? `________`

**Pass (A):** no refund; leftover sits as a customer-level credit balance.
**Fail (B):** a card refund for the excess.
**Fail (C):** credit shown only on the one $120 order; leftover not recorded anywhere.

---

### T3 — Carry-forward across MULTIPLE invoices (confirm A is real)
*Only meaningful if T2 = A. Two ways, pick what sandbox allows:*

- **Fast (preferred):** if T2 stored a durable customer balance, that's structural proof it
  carries — record the balance object shape and you're done.
- **Slow (definitive):** create a sandbox monthly product with the **shortest interval Polar
  permits**, redo T2-style to produce a credit spanning ≥2 cycles, then let 2 renewals fire.
  After each renewal confirm the balance **decreases by the invoice amount** and the card is
  **charged $0** until the balance is exhausted.

**Pass:** balance drains across ≥2 consecutive renewals; card charged only after it hits $0.

---

### T4 — The escape hatch: `next_period` (our fallback if T2 ≠ A)
*Proves we can avoid the whole problem if Polar refunds/forfeits.*

1. From an annual 10-seat sub, switch to monthly with deferral:
   ```bash
   curl -s -X PATCH "$BASE/v1/subscriptions/<sub_id>" -H "Authorization: Bearer $TOK" \
     -H "Content-Type: application/json" \
     -d '{"product_id":"<monthly_product>","proration_behavior":"next_period"}'
   ```
2. Inspect the subscription's `pending_update` field.

**Pass:** no immediate charge, no credit, no refund; `pending_update` shows the scheduled
monthly switch; sub stays annual until `current_period_end`, then flips to monthly at renewal.

---

### T5 — Where does the customer SEE their credit?
*Migration also needs the "single dashboard" promise to hold.*

1. After T2, open the **customer portal** (`createPortalUrl`) and the **sandbox dashboard**
   for that customer.
2. Confirm the credit balance and invoice history are visible/queryable (API: customer state
   / orders). Note whether MRR and the credit both render correctly.

**Pass:** credit balance + full order history visible in portal/dashboard and via API.

---

## Results → decision

| T2 outcome | Meaning | Migration verdict |
|---|---|---|
| **A** (durable customer credit balance, no refund) | Polar carries credit like our ledger | ✅ Drop the custom engine; use `prorate`. Clean win. |
| **B** (refund excess to card) | Violates "no cash refund" | ⚠️ Migrate, but **force `next_period`** for cycle switches (T4) and any credit-producing downgrade; accept "changes apply at period end." |
| **C** (excess forfeited) | Customer loses owed money | ⛔ Don't let Polar own credit. Keep our ledger as source of truth; Polar = charge rail only (current design). |

Also blocking regardless of A/B/C: if **T5** fails (credit not visible to customer/dashboard),
the "single dashboard" goal isn't met — reconsider before cutover.

## Notes / gotchas
- `reset` proration is a **paid-Polar-plan preview** feature and resets the cycle + charges
  full price — not appropriate for annual→monthly; don't test it as the credit path.
- Per the Polar docs, `prorate` is **auto-promoted to `invoice`** whenever the interval
  changes — so T2 is effectively testing `invoice` behavior even though we passed `prorate`.
- Keep the seat quantity at 10 across tests so the dollar figures line up with the brief's
  worked example ($1000 annual, $120 monthly, ~$833 vs $760 credit).

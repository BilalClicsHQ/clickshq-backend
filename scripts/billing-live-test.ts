// ─────────────────────────────────────────────────────────────────────────────
// LIVE end-to-end test of the Polar billing flows, driven through the same
// service functions the API routes call. Exercises upgrade, downgrade, credit,
// checkout, portal and renewal state against the real Polar API.
//
//   npx tsx --env-file=.env scripts/billing-live-test.ts <userId>
//
// WRITES to Polar: it changes the seat count on the user's subscription and then
// restores it. Run it against SANDBOX only — it refuses to run in production.
// ─────────────────────────────────────────────────────────────────────────────
import {
  getActiveSeatSubscription,
  toSeatState,
  updateSubscriptionSeats,
  createCheckout,
  createPortalUrl,
  listOrders,
  getBillingConfig,
  getPolarServer,
  changeSubscriptionProduct,
  cancelActiveSubscription,
  polarAccessToken,
} from "../server/services/polarService";
import { Polar } from "@polar-sh/sdk";
import { db } from "../server/db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

if (getPolarServer() === "production") {
  console.error("Refusing to run: POLAR_SERVER=production. This test mutates a live subscription.");
  process.exit(1);
}

const userId = process.argv[2];
if (!userId) { console.error("usage: billing-live-test.ts <userId>"); process.exit(1); }

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => { failures++; console.log(`  ✗ ${m}`); };
const check = (c: boolean, m: string) => (c ? pass(m) : fail(m));
const usd = (c: number | null | undefined) => (c == null ? "—" : `${c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toFixed(2)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Raw client, used only to UNDO the cancellation test — the app deliberately has
// no un-cancel path (that lives in the Polar customer portal).
const polarClient = () => new Polar({ accessToken: polarAccessToken()!, server: getPolarServer() });

// ── Baseline ──────────────────────────────────────────────────────────────────
console.log("\n1. Current subscription (read live from Polar)");
const raw = await getActiveSeatSubscription(userId);
if (!raw) { console.error("  no active subscription for this user — nothing to test"); process.exit(1); }
const base = toSeatState(raw);
const baseSeats = base.seats;
console.log(`  ${base.productName} — ${base.seats} seats × ${usd(base.perSeatAmount)} = ${usd(base.amount)}/${base.recurringInterval}`);
console.log(`  status=${base.status} renews=${base.currentPeriodEnd?.slice(0, 10)} cancelAtPeriodEnd=${base.cancelAtPeriodEnd}`);
check(base.status === "active", "subscription is active");
check(base.amount === (base.perSeatAmount ?? 0) * base.seats, `total equals seats × per-seat (${usd(base.amount)})`);

// ── Recurring / renewal state ─────────────────────────────────────────────────
// Polar renews on its own schedule; what we can assert is that it IS set to renew
// and that the period is in the future (a renewal cannot be forced on demand).
console.log("\n2. Recurring renewal");
const endMs = base.currentPeriodEnd ? Date.parse(base.currentPeriodEnd) : 0;
check(!base.cancelAtPeriodEnd, "auto-renew is ON (cancelAtPeriodEnd = false)");
check(endMs > Date.now(), `next renewal in the future (${base.currentPeriodEnd?.slice(0, 10)})`);

const ordersBefore = await listOrders(userId);
console.log(`  ${ordersBefore.length} historical order(s); latest ${usd(ordersBefore[0]?.amount)}`);

// ── Upgrade: add seats ────────────────────────────────────────────────────────
// Adding uses prorationBehavior "invoice" — Polar charges the prorated difference
// immediately, so a new order should appear.
console.log(`\n3. UPGRADE ${baseSeats} → ${baseSeats + 2} seats`);
const up = await updateSubscriptionSeats(userId, baseSeats + 2);
console.log(`  now ${up.state.seats} seats × ${usd(up.state.perSeatAmount)} = ${usd(up.state.amount)}/${up.state.recurringInterval}`);
check(up.state.seats === baseSeats + 2, `seat count increased to ${baseSeats + 2}`);
check(up.state.amount === (up.state.perSeatAmount ?? 0) * up.state.seats, "total recalculated for the new seat count");
check(up.estimatedCreditCents === null, "no credit estimate on an upgrade (it is charged, not credited)");

await sleep(2500); // let Polar settle the proration order
const ordersAfterUp = await listOrders(userId);
const newOrders = ordersAfterUp.filter((o) => !ordersBefore.some((b) => b.id === o.id));
if (newOrders.length) {
  for (const o of newOrders) console.log(`  new order: ${usd(o.amount)} status=${o.status}`);
  // The order can legitimately be $0.00: credit carried from an earlier downgrade
  // is netted against the proration first. What must hold is that an order was
  // RAISED and settled — the amount depends on the credit balance.
  check(newOrders.every((o) => o.paid || o.status === "paid"), "upgrade raised a settled proration order");
  const charged = newOrders.reduce((s, o) => s + (o.amount ?? 0), 0);
  console.log(charged === 0
    ? "  → $0.00 charged: carried credit fully absorbed the proration (balance netting works)"
    : `  → ${usd(charged)} charged for the added seats`);
} else {
  fail("upgrade produced no order at all — proration was not billed");
}

// ── Downgrade: remove seats ───────────────────────────────────────────────────
// Removing uses "prorate" — no cash refund; unused value becomes credit that Polar
// carries onto future invoices.
console.log(`\n4. DOWNGRADE ${baseSeats + 2} → ${baseSeats} seats`);
const down = await updateSubscriptionSeats(userId, baseSeats);
console.log(`  now ${down.state.seats} seats × ${usd(down.state.perSeatAmount)} = ${usd(down.state.amount)}/${down.state.recurringInterval}`);
check(down.state.seats === baseSeats, `seat count restored to ${baseSeats}`);
check(down.estimatedCreditCents != null && down.estimatedCreditCents > 0,
  `downgrade produced a prorated credit estimate (${usd(down.estimatedCreditCents)}) — no cash refund`);

await sleep(2500);
const ordersAfterDown = await listOrders(userId);
const credits = ordersAfterDown.filter((o) => (o.amount ?? 0) < 0);
console.log(`  ${credits.length} credit note(s) on the account; most recent ${usd(credits[0]?.amount)}`);

// ── Balance handling ──────────────────────────────────────────────────────────
// Polar nets carried credit against the next invoice; the ledger of it is the
// order history (negative amounts) plus what the customer portal shows.
console.log("\n5. Balance / credit handling");
const netted = ordersAfterDown.reduce((sum, o) => sum + (o.amount ?? 0), 0);
console.log(`  lifetime order total (charges − credits): ${usd(netted)}`);
check(credits.length > 0, "credit notes exist — downgrades carry credit instead of refunding");

// ── Checkout + portal ─────────────────────────────────────────────────────────
console.log("\n6. Checkout & customer portal");
const cfg = getBillingConfig();
const monthly = cfg.plans.teams.monthly.productId;
if (monthly) {
  // Use the account's real email — Polar validates the domain, exactly as it will
  // for a real customer, so a fake address is not a faithful test.
  const [account] = await db.select({ email: users.email, displayName: users.displayName })
    .from(users).where(eq(users.id, userId)).limit(1);
  if (!account?.email) fail("could not load the account email for the checkout test");
  else {
    const co = await createCheckout({ id: userId, email: account.email, displayName: account.displayName }, monthly, 3);
    check(/^https?:\/\//.test(co.url), `checkout session created (${co.url.slice(0, 52)}…)`);
  }
} else fail("no monthly product configured");

try {
  const portal = await createPortalUrl(userId);
  check(/^https?:\/\//.test(portal), `customer portal URL issued (${portal.slice(0, 48)}…)`);
} catch (e: any) { fail(`portal failed: ${e?.message}`); }

// ── Billing-interval switch (monthly ↔ yearly) ────────────────────────────────
// A cycle change is just a product swap; Polar reprices and prorates. Switched
// back afterwards so the account ends where it started.
console.log("\n7. Billing-interval switch");
{
  const toYearly = cfg.plans.teams.yearly.productId;
  const toMonthly = cfg.plans.teams.monthly.productId;
  if (!toYearly || !toMonthly) fail("both interval products must be configured");
  else {
    const yearly = await changeSubscriptionProduct(userId, toYearly);
    console.log(`  → ${yearly.productName}: ${yearly.seats} seats × ${usd(yearly.perSeatAmount)} = ${usd(yearly.amount)}/${yearly.recurringInterval}`);
    check(yearly.recurringInterval === "year", "switched to annual billing");
    check(yearly.perSeatAmount === 10000, `annual per-seat price is $100.00 (got ${usd(yearly.perSeatAmount)})`);

    await sleep(2000);
    const back = await changeSubscriptionProduct(userId, toMonthly);
    console.log(`  ← ${back.productName}: ${back.seats} seats × ${usd(back.perSeatAmount)} = ${usd(back.amount)}/${back.recurringInterval}`);
    check(back.recurringInterval === "month", "switched back to monthly billing");
    check(back.perSeatAmount === 1200, `monthly per-seat price is $12.00 (got ${usd(back.perSeatAmount)})`);
    check(back.seats === baseSeats, "seat count preserved across both switches");
  }
}

// ── Cancel at period end ──────────────────────────────────────────────────────
// No refund; access continues to period end. Undone afterwards via the API so the
// test account is left renewing (the app itself has no un-cancel — that lives in
// the Polar customer portal).
console.log("\n8. Cancel at period end");
{
  const cancelled = await cancelActiveSubscription(userId);
  check(cancelled.cancelAtPeriodEnd, "subscription flagged to cancel at period end");
  check(cancelled.status === "active", "still active until the period ends (access retained, no refund)");
  console.log(`  access continues until ${cancelled.currentPeriodEnd?.slice(0, 10)}`);

  const sub = await getActiveSeatSubscription(userId);
  await polarClient().subscriptions.update({ id: sub.id, subscriptionUpdate: { cancelAtPeriodEnd: false } as any });
  await sleep(1500);
  const resumed = toSeatState(await getActiveSeatSubscription(userId));
  check(!resumed.cancelAtPeriodEnd, "cancellation reverted — test account left renewing");
}

// ── Final state ───────────────────────────────────────────────────────────────
console.log("\n9. Final state (must match the baseline)");
const final = toSeatState(await getActiveSeatSubscription(userId));
console.log(`  ${final.seats} seats × ${usd(final.perSeatAmount)} = ${usd(final.amount)}/${final.recurringInterval}, status=${final.status}`);
check(final.seats === baseSeats, `seats restored to ${baseSeats}`);
check(final.status === "active", "subscription still active");
check(!final.cancelAtPeriodEnd, "auto-renew still on");

console.log("\n" + "─".repeat(64));
console.log(failures === 0 ? "ALL PASS — live Polar billing flows verified\n" : `${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);

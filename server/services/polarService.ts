// ─────────────────────────────────────────────────────────────────────────────
// Polar (polar.sh) payment-gateway integration — Merchant of Record.
//
// Uses the core @polar-sh/sdk so we can attach the authenticated user to each
// checkout (customerExternalId = user.id) and return the hosted-checkout URL as
// JSON for the SPA to redirect to. Subscription state is kept in sync by the
// webhook handler (server/routes/polar-webhooks.routes.ts).
//
// Required env (see .env):
//   POLAR_ACCESS_TOKEN          Organization Access Token (OAT)
//   POLAR_WEBHOOK_SECRET        Webhook signing secret
//   POLAR_SERVER                'sandbox' (default) | 'production'
//   POLAR_PRODUCT_TEAMS_MONTHLY Product ID for the monthly "Teams" plan
//   POLAR_PRODUCT_TEAMS_YEARLY  Product ID for the yearly "Teams" plan
//   BILLING_RETURN_URL          Where Polar sends the customer back (the SPA),
//                               e.g. http://localhost:5173/billing
// ─────────────────────────────────────────────────────────────────────────────
import { Polar } from "@polar-sh/sdk";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { subscriptions, type Subscription } from "@shared/schema";

type PolarServer = "sandbox" | "production";

export interface PlanPrice {
  /** Polar product ID for this plan/interval, or null if not configured. */
  productId: string | null;
}

export interface BillingConfig {
  configured: boolean;
  server: PolarServer;
  plans: {
    teams: { monthly: PlanPrice; yearly: PlanPrice };
  };
}

// ── Client (lazy singleton) ──────────────────────────────────────────────────
let _client: Polar | null = null;

export function getPolarServer(): PolarServer {
  return process.env.POLAR_SERVER === "production" ? "production" : "sandbox";
}

function isSandbox(): boolean {
  return getPolarServer() === "sandbox";
}

// ── Environment-aware credentials ─────────────────────────────────────────────
// Sandbox and production are separate Polar environments with separate tokens,
// secrets and products. Selected by POLAR_SERVER:
//   sandbox    → POLAR_SANDBOX_* keys (fallback to the unprefixed POLAR_* key)
//   production → the unprefixed POLAR_* keys
export function polarAccessToken(): string | undefined {
  return isSandbox()
    ? process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN
    : process.env.POLAR_ACCESS_TOKEN;
}

export function polarWebhookSecret(): string | undefined {
  return isSandbox()
    ? process.env.POLAR_SANDBOX_WEBHOOK_SECRET || process.env.POLAR_WEBHOOK_SECRET
    : process.env.POLAR_WEBHOOK_SECRET;
}

export function isPolarConfigured(): boolean {
  return Boolean(polarAccessToken());
}

function getClient(): Polar {
  if (!isPolarConfigured()) {
    throw new Error("Polar is not configured — set POLAR_ACCESS_TOKEN (or POLAR_SANDBOX_ACCESS_TOKEN)");
  }
  if (!_client) {
    _client = new Polar({
      accessToken: polarAccessToken()!,
      server: getPolarServer(),
    });
  }
  return _client;
}

// ── Plan configuration ───────────────────────────────────────────────────────
export function getBillingConfig(): BillingConfig {
  // Env-aware (sandbox → POLAR_SANDBOX_PRODUCT_TEAMS_*), same source as checkout.
  return {
    configured: isPolarConfigured(),
    server: getPolarServer(),
    plans: {
      teams: {
        monthly: { productId: teamsRecurringProductId("month") },
        yearly: { productId: teamsRecurringProductId("year") },
      },
    },
  };
}

/** All Polar product IDs we recognise — used to allowlist checkout requests. */
export function configuredProductIds(): string[] {
  return [teamsRecurringProductId("month"), teamsRecurringProductId("year")].filter(
    (v): v is string => Boolean(v),
  );
}

function returnBase(): string {
  return process.env.BILLING_RETURN_URL || "http://localhost:5173/billing";
}

// ── Checkout ─────────────────────────────────────────────────────────────────
export interface CheckoutUser {
  id: string;
  email: string;
  displayName?: string | null;
}

export async function createCheckout(
  user: CheckoutUser,
  productId: string,
  seats?: number,
): Promise<{ id: string; url: string }> {
  const polar = getClient();
  const successUrl = `${returnBase()}?status=success&checkout_id={CHECKOUT_ID}`;

  const checkout = await polar.checkouts.create({
    products: [productId],
    successUrl,
    customerEmail: user.email,
    customerName: user.displayName ?? undefined,
    // Links the Polar customer back to our user; surfaced again on webhooks.
    externalCustomerId: user.id,
    metadata: { userId: user.id },
    // Seat-based pricing: pre-fill the seat quantity chosen in the UI so the
    // hosted checkout (and resulting invoice) is billed per seat. Ignored by
    // Polar for non-seat-based products. minSeats:1 keeps the floor at one.
    ...(seats && seats > 0 ? { seats, minSeats: 1 } : {}),
  });

  return { id: checkout.id, url: checkout.url };
}

// ── Clics engine: initial-purchase checkout (card capture + first charge) ─────
// The Clics billing engine charges via off-session Orders, but a customer needs
// a SAVED card first. Polar only saves cards for RECURRING products (a one-time
// checkout does NOT persist the card). So the initial purchase goes through a
// hosted checkout against a recurring, pay-what-you-want product
// (POLAR_PRODUCT_TEAMS_MONTHLY/YEARLY) with a custom `amount` = the first period's
// total: Polar charges that AND saves the card, so later off-session Orders
// (renewals, seat-adds via POLAR_CHARGE_PRODUCT_ID) can reuse it. The webhook/
// confirm reads the metadata below to provision the workspace subscription.
//
// NOTE: a recurring checkout creates a Polar subscription that would auto-renew.
// The Clics engine drives renewals itself (to net credit), so Polar's auto-renew
// must be cancelled after provisioning (cancelAtPeriodEnd) — added as a follow-up
// once card-capture is validated in sandbox, so it can't confound that test.
export function chargeProductId(): string | null {
  const v = isSandbox()
    ? process.env.POLAR_SANDBOX_CHARGE_PRODUCT_ID || process.env.POLAR_CHARGE_PRODUCT_ID
    : process.env.POLAR_CHARGE_PRODUCT_ID;
  return (v || "").trim() || null;
}

// Recurring (subscription) Teams product id for the interval — used for the INITIAL
// checkout so Polar saves the card. Env-aware: sandbox prefers POLAR_SANDBOX_* and
// falls back to the unprefixed keys.
export function teamsRecurringProductId(interval: string): string | null {
  const sb = isSandbox();
  const monthly =
    (sb ? process.env.POLAR_SANDBOX_PRODUCT_TEAMS_MONTHLY : "") || process.env.POLAR_PRODUCT_TEAMS_MONTHLY || "";
  const yearly =
    (sb ? process.env.POLAR_SANDBOX_PRODUCT_TEAMS_YEARLY : "") || process.env.POLAR_PRODUCT_TEAMS_YEARLY || "";
  return ((interval === "year" ? yearly : monthly) || "").trim() || null;
}

export async function createSubscriptionCheckout(opts: {
  user: CheckoutUser;
  companyId: string;
  planKey: string;
  interval: string; // "month" | "year"
  seats: number;
  amountCents: number;
}): Promise<{ id: string; url: string }> {
  const polar = getClient();
  // Recurring PWYW product → Polar SAVES the card (a one-time product does not), and
  // the custom `amount` lets us charge the exact first-period total (seats × per-seat
  // computed by the engine). The engine then owns all later billing off-session.
  const product = teamsRecurringProductId(opts.interval);
  if (!product) {
    throw new Error(
      "No recurring Teams product configured (POLAR_SANDBOX_PRODUCT_TEAMS_MONTHLY/YEARLY or POLAR_PRODUCT_TEAMS_*)",
    );
  }

  const successUrl = `${returnBase()}?status=success&checkout_id={CHECKOUT_ID}`;
  const checkout = await polar.checkouts.create({
    products: [product],
    amount: opts.amountCents, // exact first-period total for the PWYW recurring product
    // Off-session charges later need a billing address (tax) + saved card; collect
    // the address at the initial checkout so it's on file for future Orders.
    requireBillingAddress: true,
    successUrl,
    customerEmail: opts.user.email,
    customerName: opts.user.displayName ?? undefined,
    externalCustomerId: opts.user.id,
    metadata: {
      kind: "new_subscription",
      companyId: opts.companyId,
      userId: opts.user.id,
      planKey: opts.planKey,
      interval: opts.interval,
      seats: opts.seats,
    },
  });

  return { id: checkout.id, url: checkout.url };
}

// ── Checkout reconciliation (provision on return) ────────────────────────────
// Fetch a completed checkout so the caller can provision the subscription on
// return from Polar — a fallback for when the order.paid webhook hasn't arrived
// (e.g. local dev with no public webhook URL). Idempotent at the caller.
export interface ConfirmedCheckout {
  status: string;
  paid: boolean;
  userId: string | null; // our external customer id (= user.id)
  customerId: string | null; // Polar customer id
  metadata: Record<string, any>;
  amountCents: number | null;
}

export async function getCheckout(checkoutId: string): Promise<ConfirmedCheckout | null> {
  const polar = getClient();
  const co: any = await polar.checkouts.get({ id: checkoutId });
  if (!co) return null;
  const status = String(co.status ?? "");
  return {
    status,
    // Per Polar: ONLY "succeeded" means the payment was captured. "confirmed" just
    // means the customer clicked Pay (not a success signal); "processing"/"open"/
    // "expired"/"failed" are not paid either. Don't provision on anything else.
    paid: status === "succeeded",
    userId: co.externalCustomerId ?? co.customerExternalId ?? co.metadata?.userId ?? null,
    customerId: co.customerId ?? co.customer?.id ?? null,
    metadata: co.metadata ?? {},
    amountCents: co.totalAmount ?? co.amount ?? null,
  };
}

// ── Customer portal ──────────────────────────────────────────────────────────
// Creates a customer session and returns the hosted customer-portal URL where
// the customer can manage their subscription, payment methods, and invoices.
//
// Seat-based products make the buyer a "team customer" in Polar, and a session for
// a team customer REQUIRES identifying which member it is for — without it Polar
// rejects the call with "member_id is required for team customers". Since Teams is
// our only paid plan and it is seat-based, every paying customer hits that path.
// Polar creates an owner member whose external_id is the same user id we set as
// externalCustomerId, so the same id identifies both. Non-team customers reject
// the member field, hence the retry.
export async function createPortalUrl(userId: string): Promise<string> {
  const polar = getClient();
  let session: any;
  try {
    session = await polar.customerSessions.create({ externalCustomerId: userId, externalMemberId: userId });
  } catch {
    session = await polar.customerSessions.create({ externalCustomerId: userId });
  }
  const url = session?.customerPortalUrl ?? session?.customer_portal_url;
  if (!url) throw new Error("Polar did not return a customer portal URL");
  return url as string;
}

// ── Orders / invoices ─────────────────────────────────────────────────────────
export interface BillingOrder {
  id: string;
  productId: string | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
  productName: string | null;
  status: string | null;
  paid: boolean;
  invoiceNumber: string | null;
}

// Polar REST base for the active environment.
function polarApiBase(): string {
  return getPolarServer() === "production" ? "https://api.polar.sh" : "https://sandbox-api.polar.sh";
}

// Fetch the customer's orders (invoices) straight from the Polar REST API,
// filtered by our external customer id (= the user's id). Uses fetch directly
// rather than the SDK pager, whose page shape was returning nothing.
export async function listOrders(userId: string): Promise<BillingOrder[]> {
  const token = polarAccessToken();
  if (!token) return [];
  try {
    const url = `${polarApiBase()}/v1/orders/?external_customer_id=${encodeURIComponent(userId)}&limit=50&sorting=-created_at`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error(`[polar] listOrders HTTP ${res.status}`);
      return [];
    }
    const data: any = await res.json();
    const items: any[] = data?.items ?? [];
    return items.map((o: any) => ({
      id: o.id,
      productId: o.product_id ?? null,
      date: o.created_at ?? null,
      amount: o.total_amount ?? o.net_amount ?? o.amount ?? null,
      currency: o.currency ?? null,
      productName: o.product?.name ?? null,
      status: o.status ?? null,
      paid: o.paid === true || o.status === "paid",
      invoiceNumber: o.invoice_number ?? null,
    }));
  } catch (err: any) {
    console.error("[polar] listOrders failed:", err?.message ?? err);
    return [];
  }
}

// ── DB read ──────────────────────────────────────────────────────────────────
export async function getActiveSubscriptionForUser(userId: string): Promise<Subscription | null> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(5);
  if (rows.length === 0) return null;
  // Prefer an active/trialing/past_due row; otherwise the most recently updated.
  const live = rows.find((r) => ["active", "trialing", "past_due"].includes(r.status));
  return live ?? rows[0];
}

// Polar product IDs the user currently has access to: active subscriptions plus
// any paid (non-refunded) one-time orders. Drives the "current plan" display and
// blocks re-purchasing a plan the user already has.
export async function getActiveProductIds(userId: string): Promise<string[]> {
  const ids = new Set<string>();

  const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  for (const s of subs) {
    if (s.polarProductId && ["active", "trialing", "past_due"].includes(s.status)) {
      ids.add(s.polarProductId);
    }
  }

  try {
    const orders = await listOrders(userId);
    for (const o of orders) {
      if (o.paid && o.productId) ids.add(o.productId);
    }
  } catch {
    /* orders are best-effort */
  }

  return [...ids];
}

// ── Seat-based subscription management (live via Polar) ──────────────────────
// Up-sell / down-sell seats on an existing subscription. We read state straight
// from Polar (not the local mirror) so this works even when webhooks haven't
// synced (e.g. local dev). Billing decisions (match the old engine §2/§3):
//   • adding seats   → "invoice"  (charge the prorated top-up immediately, §2)
//   • removing seats → "prorate"  (prorated credit carried to future invoices; no refund, §3)
export type SeatProrationMode = "prorate" | "invoice" | "next_period";

export interface SeatSubscriptionState {
  subscriptionId: string;
  productId: string | null;
  productName: string | null;
  status: string;
  seats: number;
  amount: number | null; // total per-period amount, in cents
  perSeatAmount: number | null; // amount / seats, in cents
  currency: string | null;
  recurringInterval: string | null; // month | year
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  // Pending scheduled change (e.g. a downgrade applied at period start). Money
  // amount is not exposed by Polar here — only the future seat count + when.
  pendingSeats: number | null;
  pendingAppliesAt: string | null;
}

function seatsOf(sub: any): number {
  return typeof sub?.seats === "number" && sub.seats > 0 ? sub.seats : 1;
}

/** Map a Polar Subscription object to the shape the UI consumes. */
export function toSeatState(s: any): SeatSubscriptionState {
  const seats = seatsOf(s);
  const amount = typeof s?.amount === "number" ? s.amount : null;
  return {
    subscriptionId: s.id,
    productId: s.productId ?? s.product?.id ?? null,
    productName: s.product?.name ?? s.productName ?? null,
    status: s.status,
    seats,
    amount,
    perSeatAmount: amount != null ? Math.round(amount / seats) : null,
    currency: s.currency ?? null,
    recurringInterval: s.recurringInterval ?? null,
    currentPeriodStart: s.currentPeriodStart ? new Date(s.currentPeriodStart).toISOString() : null,
    currentPeriodEnd: s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toISOString() : null,
    cancelAtPeriodEnd: Boolean(s.cancelAtPeriodEnd),
    pendingSeats: s.pendingUpdate?.seats ?? null,
    pendingAppliesAt: s.pendingUpdate?.appliesAt
      ? new Date(s.pendingUpdate.appliesAt).toISOString()
      : null,
  };
}

// The caller's active, seat-eligible subscription (one of our configured Teams
// products), fetched live from Polar by external customer id. null if none.
export async function getActiveSeatSubscription(userId: string): Promise<any | null> {
  const polar = getClient();
  const teamsIds = new Set(configuredProductIds());
  const result = await polar.subscriptions.list({ externalCustomerId: userId, active: true });
  for await (const page of result) {
    const items: any[] = (page as any)?.result?.items ?? [];
    for (const s of items) {
      const pid = s.productId ?? s.product?.id ?? null;
      const statusOk = ["active", "trialing", "past_due"].includes(s.status);
      if (statusOk && (teamsIds.size === 0 || (pid && teamsIds.has(pid)))) {
        return s;
      }
    }
  }
  return null;
}

// Display-only estimate of the credit a downgrade produces. Polar computes the
// authoritative amount at invoice time; this just mirrors it for the UI:
// removed seats × per-seat price × fraction of the current period remaining.
function estimateProratedCredit(sub: any, removedSeats: number): number | null {
  const amount = typeof sub?.amount === "number" ? sub.amount : null;
  const seats = seatsOf(sub);
  const start = sub?.currentPeriodStart ? new Date(sub.currentPeriodStart).getTime() : null;
  const end = sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : null;
  if (amount == null || !start || !end || end <= start || removedSeats <= 0) return null;
  const perSeat = amount / seats;
  const now = Date.now();
  const fraction = Math.max(0, Math.min(1, (end - now) / (end - start)));
  return Math.round(perSeat * removedSeats * fraction);
}

export async function updateSubscriptionSeats(
  userId: string,
  newSeats: number,
): Promise<{ state: SeatSubscriptionState; estimatedCreditCents: number | null }> {
  const polar = getClient();
  const sub = await getActiveSeatSubscription(userId);
  if (!sub) throw new Error("NO_ACTIVE_SUBSCRIPTION");

  const currentSeats = seatsOf(sub);
  if (newSeats === currentSeats) {
    return { state: toSeatState(sub), estimatedCreditCents: null };
  }

  const adding = newSeats > currentSeats;
  const prorationBehavior: SeatProrationMode = adding ? "invoice" : "prorate";

  const updated = await polar.subscriptions.update({
    id: sub.id,
    subscriptionUpdate: { seats: newSeats, prorationBehavior },
  });

  // Removals defer the credit to the next invoice (no refund); surface an
  // estimate of that credit. Additions are charged immediately (prorated).
  const estimatedCreditCents = adding ? null : estimateProratedCredit(sub, currentSeats - newSeats);

  return { state: toSeatState(updated), estimatedCreditCents };
}

// Switch the active subscription to a different product — used for plan (tier)
// changes AND billing-interval switches (monthly↔yearly), since both are just a
// product swap. Polar prorates automatically; an interval change is charged
// immediately (Polar promotes `prorate`→`invoice`). Removals/downgrades produce
// account credit (no cash refund) that carries to future invoices.
export async function changeSubscriptionProduct(
  userId: string,
  productId: string,
  prorationBehavior: SeatProrationMode | "invoice" = "prorate",
): Promise<SeatSubscriptionState> {
  const polar = getClient();
  const sub = await getActiveSeatSubscription(userId);
  if (!sub) throw new Error("NO_ACTIVE_SUBSCRIPTION");
  const updated = await polar.subscriptions.update({
    id: sub.id,
    subscriptionUpdate: { productId, prorationBehavior } as any,
  });
  return toSeatState(updated);
}

// Cancel the active subscription at period end — no refund, access until period
// end (matches the old engine's §8). Polar finalizes at renewal.
export async function cancelActiveSubscription(userId: string): Promise<SeatSubscriptionState> {
  const polar = getClient();
  const sub = await getActiveSeatSubscription(userId);
  if (!sub) throw new Error("NO_ACTIVE_SUBSCRIPTION");
  const updated = await polar.subscriptions.update({
    id: sub.id,
    subscriptionUpdate: { cancelAtPeriodEnd: true } as any,
  });
  return toSeatState(updated);
}

// ── Webhook → DB sync ────────────────────────────────────────────────────────
function pick<T = any>(obj: any, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

function toDate(v: any): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** Resolve our internal user id from a Polar subscription/order payload. */
function resolveUserId(data: any): string | undefined {
  const meta = data?.metadata ?? {};
  return (
    meta.userId ??
    meta.user_id ??
    pick<string>(data?.customer, "externalId", "external_id") ??
    pick<string>(data, "customerExternalId", "customer_external_id")
  );
}

/**
 * Upsert a subscription row from a Polar subscription webhook payload.
 * Idempotent on polarSubscriptionId — safe to call on retries.
 */
export async function upsertSubscriptionFromPolar(data: any): Promise<void> {
  const polarSubscriptionId = data?.id;
  if (!polarSubscriptionId) return;

  const userId = resolveUserId(data);
  if (!userId) {
    console.warn(`[polar] subscription ${polarSubscriptionId} has no resolvable userId — skipping`);
    return;
  }

  const row = {
    userId,
    polarSubscriptionId,
    polarCustomerId: pick<string>(data, "customerId", "customer_id") ?? data?.customer?.id ?? null,
    polarProductId: pick<string>(data, "productId", "product_id") ?? data?.product?.id ?? null,
    status: (data?.status as string) ?? "active",
    productName: data?.product?.name ?? null,
    amount: pick<number>(data, "amount") ?? null,
    currency: pick<string>(data, "currency") ?? null,
    recurringInterval: pick<string>(data, "recurringInterval", "recurring_interval") ?? null,
    cancelAtPeriodEnd: Boolean(pick(data, "cancelAtPeriodEnd", "cancel_at_period_end")),
    currentPeriodStart: toDate(pick(data, "currentPeriodStart", "current_period_start")),
    currentPeriodEnd: toDate(pick(data, "currentPeriodEnd", "current_period_end")),
    endsAt: toDate(pick(data, "endsAt", "ends_at")),
    metadata: data?.metadata ?? null,
    updatedAt: new Date(),
  };

  const [existing] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.polarSubscriptionId, polarSubscriptionId))
    .limit(1);

  if (existing) {
    await db.update(subscriptions).set(row).where(eq(subscriptions.id, existing.id));
  } else {
    await db.insert(subscriptions).values(row);
  }
}

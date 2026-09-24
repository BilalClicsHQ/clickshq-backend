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

// ── Discounts (promo codes) ──────────────────────────────────────────────────
export interface PromoCode {
  id: string;
  code: string;
  name: string | null;
  /** Human-readable value, e.g. "20% off" or "$5.00 off". */
  label: string;
}

/** Look up an active discount by its customer-facing code. null if unknown. */
export async function findDiscountByCode(code: string): Promise<PromoCode | null> {
  const token = polarAccessToken();
  if (!token) return null;
  const wanted = code.trim().toUpperCase();
  if (!wanted) return null;
  const res = await fetch(`${polarApiBase()}/v1/discounts/?limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  const hit = (data?.items ?? []).find((d: any) => String(d.code ?? "").toUpperCase() === wanted);
  if (!hit) return null;
  const label =
    hit.type === "percentage" && hit.basis_points != null
      ? `${hit.basis_points / 100}% off`
      : hit.amount != null
      ? `$${(hit.amount / 100).toFixed(2)} off`
      : "discount applied";
  return { id: hit.id, code: hit.code, name: hit.name ?? null, label };
}

export async function createCheckout(
  user: CheckoutUser,
  productId: string,
  seats?: number,
  discountId?: string | null,
): Promise<{ id: string; url: string }> {
  const polar = getClient();
  const successUrl = `${returnBase()}?status=success&checkout_id={CHECKOUT_ID}`;

  const checkout = await polar.checkouts.create({
    products: [productId],
    successUrl,
    customerEmail: user.email,
    // Deliberately no customerName: Polar prefills the CARDHOLDER NAME from it,
    // and the name on the card is often not the workspace display name. A wrong
    // prefill invites an AVS/name mismatch, so let the payer type it themselves.
    // Links the Polar customer back to our user; surfaced again on webhooks.
    externalCustomerId: user.id,
    ...(discountId ? { discountId } : {}),
    metadata: { userId: user.id },
    // Seat-based pricing: pre-fill the seat quantity chosen in the UI so the
    // hosted checkout (and resulting invoice) is billed per seat. Ignored by
    // Polar for non-seat-based products. minSeats:1 keeps the floor at one.
    ...(seats && seats > 0 ? { seats, minSeats: 1 } : {}),
  });

  return { id: checkout.id, url: checkout.url };
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

// ── Customer billing details ─────────────────────────────────────────────────
// Polar's customer record holds the billing name/address/tax id used on invoices.
// It has NO phone field — the billing form's phone lives on our users row.
export interface CustomerBilling {
  name: string | null;
  email: string | null;
  billingAddress: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  taxId: string | null;
}

function toBilling(c: any): CustomerBilling {
  const a = c?.billingAddress ?? c?.billing_address ?? null;
  return {
    name: c?.billingName ?? c?.billing_name ?? c?.name ?? null,
    email: c?.email ?? null,
    billingAddress: a
      ? {
          line1: a.line1 ?? null,
          line2: a.line2 ?? null,
          city: a.city ?? null,
          state: a.state ?? null,
          postalCode: a.postalCode ?? a.postal_code ?? null,
          country: a.country ?? null,
        }
      : null,
    taxId: c?.taxId ?? c?.tax_id ?? null,
  };
}

/** The caller's Polar customer, or null if they've never checked out. */
export async function getCustomerBilling(userId: string): Promise<CustomerBilling | null> {
  const polar = getClient();
  try {
    const c: any = await polar.customers.getExternal({ externalId: userId });
    return toBilling(c);
  } catch {
    return null; // no Polar customer yet — the UI shows an empty form
  }
}

export async function updateCustomerBilling(
  userId: string,
  input: {
    email?: string | null;
    name?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  },
): Promise<CustomerBilling> {
  const polar = getClient();

  // A Polar customer only exists after a first checkout. Someone filling in their
  // billing details BEFORE subscribing (the empty state of the Invoices tab) has
  // none, so create one — otherwise the form would appear to save and then lose
  // everything but the phone number on reload.
  let current: any = null;
  try {
    current = await polar.customers.getExternal({ externalId: userId });
  } catch {
    if (!input.email) throw new Error("Cannot create a Polar customer without an email");
    current = await polar.customers.create({
      externalId: userId,
      email: input.email,
      ...(input.name ? { name: input.name } : {}),
    } as any);
  }

  const a = current?.billingAddress ?? current?.billing_address ?? {};
  // Polar requires a country on the address; keep the existing one when the form
  // doesn't supply it, and drop the address entirely if we still have none.
  const country = (input.country ?? a.country ?? "").trim();
  const billingAddress = country
    ? {
        line1: a.line1 ?? null,
        line2: a.line2 ?? null,
        city: input.city ?? a.city ?? null,
        state: input.state ?? a.state ?? null,
        postalCode: input.postalCode ?? a.postalCode ?? a.postal_code ?? null,
        country,
      }
    : undefined;

  const updated: any = await polar.customers.updateExternal({
    externalId: userId,
    customerUpdateExternalID: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(billingAddress ? { billingAddress } : {}),
    } as any,
  });
  return toBilling(updated);
}

// ── Saved payment methods ────────────────────────────────────────────────────
// Reading cards uses the organization token. Deleting one is a CUSTOMER-PORTAL
// operation, so it needs a short-lived customer session token instead.
//
// There is deliberately no "add card" here: Polar's add-payment-method endpoint
// requires a Stripe.js confirmation token, which would mean collecting raw card
// details in our own page (PCI scope). Adding a card goes through Polar's
// checkout instead — see createCheckout.
export interface SavedCard {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

export async function listPaymentMethods(userId: string): Promise<SavedCard[]> {
  const polar = getClient();
  let customerId: string;
  try {
    const c: any = await polar.customers.getExternal({ externalId: userId });
    customerId = c.id;
  } catch {
    return []; // no customer yet
  }
  const token = polarAccessToken();
  const res = await fetch(`${polarApiBase()}/v1/customers/${customerId}/payment-methods?limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`[polar] listPaymentMethods HTTP ${res.status}`);
    return [];
  }
  const data: any = await res.json();
  return (data?.items ?? []).map((pm: any) => ({
    id: pm.id,
    brand: pm.method_metadata?.brand ?? null,
    last4: pm.method_metadata?.last4 ?? null,
    expMonth: pm.method_metadata?.exp_month ?? null,
    expYear: pm.method_metadata?.exp_year ?? null,
    isDefault: pm.is_default === true,
  }));
}

/** Short-lived customer-session token, used for customer-portal endpoints. */
async function customerSessionToken(userId: string): Promise<string> {
  const polar = getClient();
  const session: any = await polar.customerSessions
    .create({ externalCustomerId: userId, externalMemberId: userId } as any)
    .catch(() => polar.customerSessions.create({ externalCustomerId: userId }));
  const token = session?.token;
  if (!token) throw new Error("Polar did not return a customer session token");
  return token;
}

/** Thrown when Polar declines the deletion for a reason worth showing the user. */
export class PaymentMethodDeleteError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export async function deletePaymentMethod(userId: string, paymentMethodId: string): Promise<void> {
  const token = await customerSessionToken(userId);
  const res = await fetch(
    `${polarApiBase()}/v1/customer-portal/customers/me/payment-methods/${encodeURIComponent(paymentMethodId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.ok || res.status === 204) return;

  // Polar refuses to remove the last card behind an active subscription — that
  // would leave the subscription with no way to charge. It's a rule worth telling
  // the customer about, not a failure to hide behind a generic error.
  const body: any = await res.json().catch(() => ({}));
  const code = String(body?.error ?? `HTTP_${res.status}`);
  if (code === "PaymentMethodInUseByActiveSubscription") {
    throw new PaymentMethodDeleteError(
      "This card is paying for your active subscription. Add another card first, or cancel the subscription, then remove it.",
      code,
    );
  }
  throw new PaymentMethodDeleteError(
    String(body?.detail ?? `Polar refused to delete the payment method (HTTP ${res.status})`),
    code,
  );
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

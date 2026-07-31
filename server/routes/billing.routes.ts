// ─────────────────────────────────────────────────────────────────────────────
// Billing routes — Polar checkout, subscription status, customer portal, orders.
// Mounted at /api/billing (see server/routes.ts). All routes require a session.
//
// POLAR IS THE ONLY SOURCE OF MONEY TRUTH. Every amount — proration on seat and
// plan changes, downgrade credit, renewals, dunning, invoices — is computed by
// Polar. This server never calculates a charge; it forwards intent to Polar and
// reads the result back. The old Clics billing engine (workspace_subscriptions +
// a local credit ledger + our own renewal cron) was a second money system and has
// been removed — do not reintroduce local billing math here.
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth";
import {
  isPolarConfigured,
  getBillingConfig,
  configuredProductIds,
  createCheckout,
  createPortalUrl,
  listOrders,
  getActiveSubscriptionForUser,
  getActiveProductIds,
  getActiveSeatSubscription,
  toSeatState,
  updateSubscriptionSeats,
  changeSubscriptionProduct,
  cancelActiveSubscription,
  getCustomerBilling,
  updateCustomerBilling,
  listPaymentMethods,
  deletePaymentMethod,
  findDiscountByCode,
} from "../services/polarService";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

const router = Router();

function notConfigured(res: Response) {
  return res.status(503).json({ error: "Billing is not configured" });
}

// GET /api/billing/config — plan → Polar product-id map + whether Polar is live.
// Safe to call even when Polar is unconfigured (drives the UI state).
router.get("/config", requireAuth, (_req: Request, res: Response) => {
  res.json(getBillingConfig());
});

// GET /api/billing/subscription — the caller's current subscription (or null).
router.get("/subscription", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    const [sub, activeProductIds] = await Promise.all([
      getActiveSubscriptionForUser(userId),
      getActiveProductIds(userId),
    ]);
    res.json({ subscription: sub, activeProductIds });
  } catch (err: any) {
    console.error("[billing] subscription error:", err?.message ?? err);
    res.status(500).json({ error: "Failed to load subscription" });
  }
});

// POST /api/billing/checkout — start a hosted Polar checkout for a product.
// Body: { productId: string }. Returns { url } for the SPA to redirect to.
router.post("/checkout", requireAuth, async (req: Request, res: Response) => {
  if (!isPolarConfigured()) return notConfigured(res);
  try {
    const user = req.user as any;
    const { productId, seats } = req.body ?? {};

    if (typeof productId !== "string" || !productId.trim()) {
      return res.status(400).json({ error: "productId is required" });
    }
    // Only allow products we have configured — never trust an arbitrary id.
    if (!configuredProductIds().includes(productId)) {
      return res.status(400).json({ error: "Unknown or unconfigured product" });
    }

    // Optional seat count for seat-based pricing. Validate before trusting it:
    // integer, at least 1, capped at Polar's 1000-seat-per-subscription limit.
    let seatCount: number | undefined;
    if (seats !== undefined && seats !== null) {
      const n = Number(seats);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        return res.status(400).json({ error: "seats must be an integer between 1 and 1000" });
      }
      seatCount = n;
    }

    // Don't let a user buy a plan they already have (active sub or paid order).
    const owned = await getActiveProductIds(user.id);
    if (owned.includes(productId)) {
      return res.status(409).json({ error: "You already have this plan." });
    }

    // Optional promo code — resolved to a Polar discount so the hosted checkout
    // opens with it already applied.
    let discountId: string | null = null;
    if (typeof req.body?.promoCode === "string" && req.body.promoCode.trim()) {
      const promo = await findDiscountByCode(req.body.promoCode);
      if (!promo) return res.status(400).json({ error: "That promo code isn't valid." });
      discountId = promo.id;
    }

    const { url } = await createCheckout(
      { id: user.id, email: user.email, displayName: user.displayName },
      productId,
      seatCount,
      discountId,
    );
    res.json({ url });
  } catch (err: any) {
    console.error("[billing] checkout error:", err?.message ?? err);
    res.status(502).json({ error: "Failed to create checkout session" });
  }
});

// POST /api/billing/portal — get a Polar customer-portal URL for the caller.
router.post("/portal", requireAuth, async (req: Request, res: Response) => {
  if (!isPolarConfigured()) return notConfigured(res);
  try {
    const userId = (req.user as any)?.id;
    const url = await createPortalUrl(userId);
    res.json({ url });
  } catch (err: any) {
    console.error("[billing] portal error:", err?.message ?? err);
    // Most common cause: the user has no Polar customer yet (never checked out).
    res.status(502).json({ error: "Failed to open billing portal" });
  }
});

// GET /api/billing/seats — current seat state for the caller's active sub.
// Read live from Polar so it works even when the local mirror is unsynced.
router.get("/seats", requireAuth, async (req: Request, res: Response) => {
  if (!isPolarConfigured()) return res.json({ hasSubscription: false });
  try {
    const userId = (req.user as any)?.id;
    const sub = await getActiveSeatSubscription(userId);
    if (!sub) return res.json({ hasSubscription: false });
    res.json({ hasSubscription: true, ...toSeatState(sub) });
  } catch (err: any) {
    console.error("[billing] seats get error:", err?.message ?? err);
    res.status(500).json({ error: "Failed to load seats" });
  }
});

// PATCH /api/billing/seats — up-sell / down-sell seats on the active sub.
// Body: { seats: number }. Adds charge immediately (prorated); removals defer
// the credit to the next invoice (no refund).
router.patch("/seats", requireAuth, async (req: Request, res: Response) => {
  if (!isPolarConfigured()) return notConfigured(res);
  const { seats } = req.body ?? {};
  const n = Number(seats);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    return res.status(400).json({ error: "seats must be an integer between 1 and 1000" });
  }
  try {
    const userId = (req.user as any)?.id;
    const { state, estimatedCreditCents } = await updateSubscriptionSeats(userId, n);
    res.json({ hasSubscription: true, ...state, estimatedCreditCents });
  } catch (err: any) {
    if (err?.message === "NO_ACTIVE_SUBSCRIPTION") {
      return res.status(409).json({ error: "No active subscription to update." });
    }
    console.error("[billing] seats update error:", err?.message ?? err);
    res.status(502).json({ error: "Failed to update seats" });
  }
});

// GET /api/billing/orders — the caller's past orders/invoices (best-effort).
router.get("/orders", requireAuth, async (req: Request, res: Response) => {
  if (!isPolarConfigured()) return res.json({ orders: [] });
  try {
    const userId = (req.user as any)?.id;
    const orders = await listOrders(userId);
    res.json({ orders });
  } catch (err: any) {
    console.error("[billing] orders error:", err?.message ?? err);
    res.json({ orders: [] });
  }
});

// POST /api/billing/plan — switch plan tier OR billing interval (monthly↔yearly)
// via Polar (a product swap). Body: { productId, prorationBehavior? }. Polar
// prorates automatically; downgrades become carried account credit (no refund).
router.post("/plan", requireAuth, async (req: Request, res: Response) => {
  if (!isPolarConfigured()) return notConfigured(res);
  const { productId, prorationBehavior } = req.body ?? {};
  if (typeof productId !== "string" || !configuredProductIds().includes(productId)) {
    return res.status(400).json({ error: "Unknown or unconfigured product" });
  }
  const pb = ["prorate", "invoice", "next_period"].includes(prorationBehavior) ? prorationBehavior : "prorate";
  try {
    const state = await changeSubscriptionProduct((req.user as any)?.id, productId, pb);
    res.json({ hasSubscription: true, ...state });
  } catch (err: any) {
    if (err?.message === "NO_ACTIVE_SUBSCRIPTION") return res.status(409).json({ error: "No active subscription" });
    console.error("[billing] plan change error:", err?.message ?? err);
    res.status(502).json({ error: "Failed to change plan" });
  }
});

// POST /api/billing/cancel — cancel at period end via Polar (no refund).
router.post("/cancel", requireAuth, async (req: Request, res: Response) => {
  if (!isPolarConfigured()) return notConfigured(res);
  try {
    const state = await cancelActiveSubscription((req.user as any)?.id);
    res.json({ hasSubscription: true, ...state });
  } catch (err: any) {
    if (err?.message === "NO_ACTIVE_SUBSCRIPTION") return res.status(409).json({ error: "No active subscription" });
    console.error("[billing] cancel error:", err?.message ?? err);
    res.status(502).json({ error: "Failed to cancel subscription" });
  }
});

// POST /api/billing/promo — validate a promo code for the Summary panel.
router.post("/promo", requireAuth, async (req: Request, res: Response) => {
  if (!isPolarConfigured()) return notConfigured(res);
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!code.trim()) return res.status(400).json({ error: "Enter a promo code" });
  try {
    const promo = await findDiscountByCode(code);
    if (!promo) return res.status(404).json({ error: "That promo code isn't valid." });
    res.json(promo);
  } catch (err: any) {
    console.error("[billing] promo error:", err?.message ?? err);
    res.status(502).json({ error: "Couldn't check that code" });
  }
});

// ── Billing details (Invoices tab) ────────────────────────────────────────────
// Name/address live on the Polar customer (they appear on Polar's invoices);
// phone has no Polar equivalent, so it comes from our users row.

// GET /api/billing/customer — billing name, address and phone for the form.
router.get("/customer", requireAuth, async (req: Request, res: Response) => {
  const user = req.user as any;
  try {
    const [row] = await db.select({ phone: users.phone, displayName: users.displayName, email: users.email })
      .from(users).where(eq(users.id, user.id)).limit(1);
    const billing = isPolarConfigured() ? await getCustomerBilling(user.id) : null;
    res.json({
      name: billing?.name ?? row?.displayName ?? null,
      email: billing?.email ?? row?.email ?? null,
      phone: row?.phone ?? null,
      city: billing?.billingAddress?.city ?? null,
      state: billing?.billingAddress?.state ?? null,
      postalCode: billing?.billingAddress?.postalCode ?? null,
      country: billing?.billingAddress?.country ?? null,
    });
  } catch (err: any) {
    console.error("[billing] customer get error:", err?.message ?? err);
    res.status(500).json({ error: "Failed to load billing details" });
  }
});

// PATCH /api/billing/customer — save the billing-information form.
router.patch("/customer", requireAuth, async (req: Request, res: Response) => {
  const user = req.user as any;
  const { name, phone, city, state, postalCode, country } = req.body ?? {};
  const str = (v: any) => (typeof v === "string" ? v.trim().slice(0, 200) : undefined);
  try {
    const phoneVal = str(phone);
    if (phoneVal !== undefined) {
      await db.update(users).set({ phone: phoneVal || null }).where(eq(users.id, user.id));
    }
    // The Polar customer only exists after a first checkout; skip it until then so
    // a free user can still save their details locally.
    let billing = null;
    if (isPolarConfigured() && (await getCustomerBilling(user.id))) {
      billing = await updateCustomerBilling(user.id, {
        name: str(name),
        city: str(city),
        state: str(state),
        postalCode: str(postalCode),
        country: str(country),
      });
    }
    res.json({
      name: billing?.name ?? str(name) ?? null,
      phone: phoneVal ?? null,
      city: billing?.billingAddress?.city ?? str(city) ?? null,
      state: billing?.billingAddress?.state ?? str(state) ?? null,
      postalCode: billing?.billingAddress?.postalCode ?? str(postalCode) ?? null,
      country: billing?.billingAddress?.country ?? str(country) ?? null,
    });
  } catch (err: any) {
    console.error("[billing] customer update error:", err?.message ?? err);
    res.status(502).json({ error: "Failed to save billing details" });
  }
});

// GET /api/billing/payment-methods — saved cards (brand / last4 / expiry).
router.get("/payment-methods", requireAuth, async (req: Request, res: Response) => {
  if (!isPolarConfigured()) return res.json({ paymentMethods: [] });
  try {
    res.json({ paymentMethods: await listPaymentMethods((req.user as any)?.id) });
  } catch (err: any) {
    console.error("[billing] payment methods error:", err?.message ?? err);
    res.json({ paymentMethods: [] });
  }
});

// DELETE /api/billing/payment-methods/:id — remove a saved card.
// Adding one is NOT here: Polar requires a Stripe confirmation token for that,
// which would mean handling raw card details. New cards go through checkout.
router.delete("/payment-methods/:id", requireAuth, async (req: Request, res: Response) => {
  if (!isPolarConfigured()) return notConfigured(res);
  try {
    await deletePaymentMethod((req.user as any)?.id, req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[billing] payment method delete error:", err?.message ?? err);
    res.status(502).json({ error: "Failed to remove the card" });
  }
});

export default router;

// ─────────────────────────────────────────────────────────────────────────────
// Payment gateway — the ONLY place that moves money. Isolates the Clics billing
// engine from Polar so the engine stays pure-logic + DB.
//
// Clics computes the exact amount (seats × price − credit, prorations, etc.) and
// asks the gateway to charge the customer's saved card off-session via Polar's
// Orders API: orders.create({ amount }) → orders.finalize().
//
// Phase 1 / dev: when off-session charging isn't enabled (the Polar
// `off_session_charges_enabled` org flag + a one-time charge product + an opt-in
// env), the gateway SIMULATES a successful charge so the whole engine, ledger and
// invoice flow are exercisable end-to-end without real money. Flip
// BILLING_OFF_SESSION=true (with POLAR_CHARGE_PRODUCT_ID set) to charge for real.
// ─────────────────────────────────────────────────────────────────────────────
import { Polar } from "@polar-sh/sdk";
import { isPolarConfigured, getPolarServer, polarAccessToken, chargeProductId } from "./polarService";

export interface ChargeRequest {
  /** Our internal user id (= Polar externalCustomerId). */
  externalCustomerId: string;
  /** Polar customer id if already known (skips the lookup). */
  polarCustomerId?: string | null;
  /** One-time charge product id; falls back to POLAR_CHARGE_PRODUCT_ID. */
  productId?: string | null;
  amountCents: number;
  currency: string;
  description: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface ChargeResult {
  ok: boolean;
  orderId: string | null;
  /**
   * "paid" | "failed" | "simulated" | "no_charge" | "not_configured" |
   * "off_session_not_enabled" | "no_payment_method" | Polar order status.
   */
  status: string;
  simulated: boolean;
  error?: string;
}

/** Real off-session charging is only attempted when fully configured + opted-in. */
export function offSessionEnabled(): boolean {
  return isPolarConfigured() && process.env.BILLING_OFF_SESSION === "true" && !!chargeProductId();
}

/**
 * Where a simulated charge would be real money. A production Polar org means live
 * cards regardless of NODE_ENV; NODE_ENV=production catches a real deploy that
 * forgot to set POLAR_SERVER (it defaults to sandbox).
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || getPolarServer() === "production";
}

// Classify a Polar API error so callers can react (and the env/ops checklist can
// point at the exact fix). Polar surfaces these as the org not being able to
// charge off-session yet — almost always "off-session charges not enabled on the
// organization" (a Polar account/setup step, NOT a paid plan) or "no saved card".
function classifyChargeError(err: any): { status: string; message: string } {
  const raw = `${err?.message ?? ""} ${JSON.stringify(err?.body ?? err?.data ?? "")}`.toLowerCase();
  const message = err?.message ?? String(err);
  // Check this BEFORE the off-session check — the message contains "off-session"
  // but the real fix is using a fixed-price charge product (POLAR_CHARGE_PRODUCT_ID).
  if (raw.includes("fixed-price") || raw.includes("fixed price")) {
    return { status: "charge_product_not_fixed", message };
  }
  if (raw.includes("not ready") || raw.includes("cannot currently accept") || raw.includes("offsessionchargesnotenabled")) {
    return { status: "off_session_not_enabled", message };
  }
  // Polar: PaymentActionRequired — the card needs SCA/3DS authentication that can't
  // be completed off-session. The customer must re-authenticate via a fresh checkout.
  if (raw.includes("action_required") || raw.includes("action required") || raw.includes("authentication")) {
    return { status: "action_required", message };
  }
  if (raw.includes("payment method") || raw.includes("no card") || raw.includes("paymentmethod")) {
    return { status: "no_payment_method", message };
  }
  return { status: "failed", message };
}

let _client: Polar | null = null;
function client(): Polar {
  if (!_client) {
    _client = new Polar({ accessToken: polarAccessToken()!, server: getPolarServer() });
  }
  return _client;
}

/**
 * Charge the customer's saved payment method for an arbitrary amount. Returns a
 * normalized result; never throws (failures come back as { ok:false }).
 */
export async function chargeOffSession(req: ChargeRequest): Promise<ChargeResult> {
  // $0 (or credit fully covered the invoice) → nothing to charge.
  if (req.amountCents <= 0) {
    return { ok: true, orderId: null, status: "no_charge", simulated: false };
  }

  // Dev / Phase-1 fallback: when off-session charging isn't fully wired (no
  // BILLING_OFF_SESSION=true, no charge product, or Polar unconfigured) we record
  // the invoice/ledger as if the card was charged, but NO money moves. Loud on
  // purpose so a misconfigured production deploy can't silently "succeed".
  if (!offSessionEnabled()) {
    const reason = !isPolarConfigured()
      ? "Polar not configured"
      : !chargeProductId()
      ? `${getPolarServer() === "production" ? "POLAR_CHARGE_PRODUCT_ID" : "POLAR_SANDBOX_CHARGE_PRODUCT_ID"} not set`
      : "BILLING_OFF_SESSION !== 'true'";

    // Simulation is a DEV affordance only. Returning ok:true in production makes
    // the engine write a PAID invoice, advance the period and grant free service
    // — exactly what an unset production POLAR_CHARGE_PRODUCT_ID would cause.
    // Fail CLOSED instead: the caller records a failed invoice and dunning runs.
    if (isProduction()) {
      console.error(
        `[paymentGateway] REFUSING to simulate a ${req.amountCents} ${req.currency} charge in ` +
          `production (${reason}). Nothing will be marked paid.`,
      );
      return {
        ok: false,
        orderId: null,
        status: "not_configured",
        simulated: false,
        error: `Off-session charging is not configured: ${reason}`,
      };
    }

    console.warn(
      `[paymentGateway] SIMULATED charge of ${req.amountCents} ${req.currency} ` +
        `(${reason}) — no real money moved. Set BILLING_OFF_SESSION=true + enable ` +
        `off-session charges on the Polar org to charge for real.`,
    );
    return { ok: true, orderId: null, status: "simulated", simulated: true };
  }

  const productId = (req.productId || chargeProductId() || "").trim();
  if (!productId) {
    return { ok: false, orderId: null, status: "failed", simulated: false, error: "No charge product configured" };
  }

  try {
    const polar = client();

    // Resolve the Polar customer (= our external customer id). If they have no
    // Polar customer record yet they have never completed a checkout, so there is
    // no saved card to charge off-session.
    let customerId = req.polarCustomerId ?? null;
    if (!customerId) {
      try {
        const customer = await polar.customers.getExternal({ externalId: req.externalCustomerId });
        customerId = customer.id;
      } catch {
        return {
          ok: false,
          orderId: null,
          status: "no_payment_method",
          simulated: false,
          error: "No Polar customer / saved card for this account — complete a checkout first.",
        };
      }
    }

    // Off-session charge: create a draft order against the saved card for an
    // arbitrary amount (the PWYW charge product), then finalize to capture it.
    const draft = await polar.orders.create({
      customerId,
      productId,
      amount: req.amountCents,
      currency: req.currency,
      // OrderCreate.metadata values must be string | number | boolean.
      metadata: { ...(req.metadata ?? {}), description: req.description.slice(0, 500) },
    });

    const finalized = await polar.orders.finalize({ id: draft.id });
    const status = String(finalized.status ?? "unknown");
    return { ok: status === "paid", orderId: finalized.id, status, simulated: false };
  } catch (err: any) {
    const { status, message } = classifyChargeError(err);
    if (status === "off_session_not_enabled") {
      console.error(
        "[paymentGateway] Off-session charges are NOT enabled for this Polar organization. " +
          "Off-session charges are a PREVIEW feature available only on a PAID Polar plan " +
          "(Pro/Growth/Scale) and require the org to be ready for payments. Upgrade the Polar " +
          "org and/or contact Polar support. Charge could not be completed.",
      );
    }
    return { ok: false, orderId: null, status, simulated: false, error: message };
  }
}

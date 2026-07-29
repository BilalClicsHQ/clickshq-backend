// ─────────────────────────────────────────────────────────────────────────────
// Polar webhook receiver — keeps the local `subscriptions` table in sync.
// Mounted at /api/webhooks (route: POST /api/webhooks/polar).
//
// Signature verification uses validateEvent() over the RAW request body. The
// app already captures raw bytes on req.rawBody for /api/webhooks/* paths
// (server/index.ts + api/handler.ts express.json `verify` hook), so we don't
// need an extra express.raw() middleware here.
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type Request, type Response } from "express";
import { validateEvent, WebhookVerificationError } from "@polar-sh/sdk/webhooks";
import { upsertSubscriptionFromPolar, polarWebhookSecret } from "../services/polarService";

const router = Router();

router.post("/polar", async (req: Request, res: Response) => {
  const secret = polarWebhookSecret();
  if (!secret) {
    console.warn("[polar webhook] webhook secret not set — rejecting delivery");
    return res.status(503).send("");
  }

  const raw = (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

  let event: any;
  try {
    event = validateEvent(raw, req.headers as any, secret);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return res.status(403).send("");
    }
    console.error("[polar webhook] validation error:", err);
    return res.status(400).send("");
  }

  try {
    switch (event.type) {
      case "subscription.created":
      case "subscription.updated":
      case "subscription.active":
      case "subscription.canceled":
      case "subscription.uncanceled":
      case "subscription.past_due":
      case "subscription.revoked":
        await upsertSubscriptionFromPolar(event.data);
        break;

      case "order.paid":
      case "order.created":
        // Renewal / proration orders carry their subscription — sync the mirror so
        // status + period reflect the payment. Polar owns the money; we only read.
        if (event.data?.subscription) {
          await upsertSubscriptionFromPolar(event.data.subscription);
        }
        break;

      default:
        // checkout.*, customer.*, benefit.*, product.* — nothing to persist yet.
        break;
    }

    // 202 Accepted — Polar treats any 2xx as success.
    return res.status(202).send("");
  } catch (err: any) {
    console.error(`[polar webhook] handler failed for ${event?.type}:`, err?.message ?? err);
    // 5xx makes Polar retry the delivery.
    return res.status(500).send("");
  }
});

export default router;

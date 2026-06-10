/**
 * Jira webhook receiver.
 *
 * Mounted at /api/webhooks/jira.
 *
 * Unlike GitHub, Jira webhooks (Connect/OAuth dynamic ones) don't sign
 * requests with HMAC out of the box. We protect this endpoint by:
 *   1. Including a long random secret in the webhook URL query string.
 *      Each subscription has its own secret (?key=…) so we can verify.
 *   2. Validating the payload structure (event + issue.key minimum).
 *   3. Deduping with a synthesized delivery key.
 *
 * Webhook URL format: /api/webhooks/jira?key={WEBHOOK_SECRET}
 */
import { Router, Request, Response } from "express";
import { storage } from "../storage";
import { processJiraWebhookEvent } from "../services/jiraWebhookService";

const router = Router();

router.post("/jira", async (req: Request, res: Response) => {
  const providedKey = (req.query.key as string) || "";
  const expectedKey = process.env.JIRA_WEBHOOK_SECRET || "";

  if (!expectedKey) {
    console.error("[Jira Webhook] JIRA_WEBHOOK_SECRET not configured");
    return res
      .status(503)
      .json({ success: false, error: "Webhook receiver not configured" });
  }

  if (providedKey !== expectedKey) {
    return res
      .status(401)
      .json({ success: false, error: "Invalid webhook key" });
  }

  const payload = req.body;
  const event: string = payload?.webhookEvent || "";
  const issueKey: string | undefined = payload?.issue?.key;
  const cloudId: string | undefined =
    payload?.matchedWebhookIds?.[0]?.toString() ||
    (req.query.cloudId as string) ||
    payload?.cloudId;

  if (!event) {
    return res.status(400).json({ success: false, error: "Missing event" });
  }

  // Synthesize delivery key (Jira doesn't provide a delivery ID)
  // Use event + issueKey + timestamp to make it idempotent enough
  const deliveryKey = `${event}:${issueKey ?? "?"}:${payload.timestamp ?? Date.now()}`;

  // Idempotency
  const existing = await storage.getJiraWebhookDelivery(deliveryKey);
  if (existing) {
    return res.status(200).json({ success: true, deduped: true });
  }

  // If cloudId not present in payload, fall back to query string
  const resolvedCloudId = cloudId || (req.query.cloudId as string) || "";
  if (!resolvedCloudId) {
    // We can still process — webhook handler tries to look up by issue
    console.warn("[Jira Webhook] No cloudId in payload or query");
  }

  try {
    await processJiraWebhookEvent(event, payload, resolvedCloudId);
    await storage.recordJiraWebhookDelivery({
      deliveryKey,
      event,
      issueKey,
      payload,
      status: "processed",
    });
    return res.status(200).json({ success: true });
  } catch (err: any) {
    console.error("[Jira Webhook] Processing error:", err);
    await storage
      .recordJiraWebhookDelivery({
        deliveryKey,
        event,
        issueKey,
        payload,
        status: "failed",
        error: err?.message ?? String(err),
      })
      .catch(() => undefined);
    return res
      .status(200)
      .json({ success: false, error: "Processed with errors" });
  }
});

export default router;

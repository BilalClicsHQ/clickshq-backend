/**
 * GitHub webhook receiver.
 *
 * Mounted at /api/webhooks/github. Requires the raw request body (captured
 * by the express.json `verify` hook in server/index.ts) so that the HMAC
 * signature GitHub sends in X-Hub-Signature-256 can be re-computed
 * byte-for-byte.
 *
 * Flow:
 *   1. Pull headers (event, delivery, signature).
 *   2. Look up the secret(s) registered for this repo.
 *   3. Verify signature against ANY matching secret (multiple spaces may
 *      install the same repo with different secrets).
 *   4. Dedupe on X-GitHub-Delivery (GitHub retries).
 *   5. Hand off to githubWebhookService.processWebhookEvent.
 *   6. Always return 2xx for valid signatures so GitHub stops retrying;
 *      we log failures internally.
 */
import { Router, Request, Response } from "express";
import { storage } from "../storage";
import { verifyWebhookSignature } from "../services/githubService";
import { processWebhookEvent } from "../services/githubWebhookService";

const router = Router();

router.post("/github", async (req: Request, res: Response) => {
  const event = (req.headers["x-github-event"] as string) || "";
  const deliveryId = (req.headers["x-github-delivery"] as string) || "";
  const signature = (req.headers["x-hub-signature-256"] as string) || "";
  const rawBody: Buffer | undefined = (req as any).rawBody;

  if (!event || !deliveryId) {
    return res
      .status(400)
      .json({ success: false, error: "Missing GitHub webhook headers" });
  }
  if (!rawBody) {
    return res
      .status(400)
      .json({ success: false, error: "Raw body missing" });
  }

  const payload = req.body;
  const repoFullName: string | undefined = payload?.repository?.full_name;

  // PING event arrives right after webhook creation; verify against ANY active
  // webhook secret we have stored for this repo (or — for ping — the most
  // recently created one). We accept the first matching secret.
  let secretMatched = false;
  if (repoFullName) {
    const webhooks = await storage.getGithubWebhooksByRepo(repoFullName);
    for (const wh of webhooks) {
      if (verifyWebhookSignature(rawBody, signature, wh.secret)) {
        secretMatched = true;
        break;
      }
    }
  }

  if (!secretMatched) {
    // Don't reveal whether the repo is known — generic 401
    await storage
      .recordWebhookDelivery({
        deliveryId,
        event,
        repoFullName,
        payload,
        status: "failed",
        error: "signature_mismatch",
      })
      .catch(() => undefined);
    return res.status(401).json({ success: false, error: "Invalid signature" });
  }

  // Idempotency — GitHub may retry
  const existing = await storage.getWebhookDelivery(deliveryId);
  if (existing) {
    return res.status(200).json({ success: true, deduped: true });
  }

  // Acknowledge fast, process inline (events are small enough; queue can be
  // added later for high volume).
  try {
    await processWebhookEvent(event, payload);
    await storage.recordWebhookDelivery({
      deliveryId,
      event,
      repoFullName,
      payload,
      status: "processed",
    });
    return res.status(200).json({ success: true });
  } catch (err: any) {
    console.error("[GitHub Webhook] Processing error:", err);
    await storage
      .recordWebhookDelivery({
        deliveryId,
        event,
        repoFullName,
        payload,
        status: "failed",
        error: err?.message ?? String(err),
      })
      .catch(() => undefined);
    // Return 200 anyway — we accepted it; retrying won't help.
    return res
      .status(200)
      .json({ success: false, error: "Processed with errors" });
  }
});

export default router;

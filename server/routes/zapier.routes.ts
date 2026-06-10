import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { db } from "../db";
import { zapierWebhooks, apiKeys, zapierOAuthCodes, zapierOAuthTokens, users } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { testWebhook } from "../services/zapierWebhookService";
import crypto from "crypto";

const ZAPIER_CLIENT_ID = process.env.ZAPIER_CLIENT_ID || "clickshq_zapier_client";
const ZAPIER_CLIENT_SECRET = process.env.ZAPIER_CLIENT_SECRET || "";
const ZAPIER_REDIRECT_URI = process.env.ZAPIER_REDIRECT_URI || "https://zapier.com/dashboard/auth/oauth/return/App238457CLIAPI/";
const FRONTEND_APP_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const router = Router();

// ─── GET /settings — Get webhook settings for current user ───────────────────
router.get("/settings", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;

    const [webhook] = await db
      .select()
      .from(zapierWebhooks)
      .where(eq(zapierWebhooks.userId, user.id));

    if (!webhook) {
      return res.json({ success: true, data: null });
    }

    res.json({ success: true, data: webhook });
  } catch (err) {
    console.error("[Zapier] Error fetching settings:", err);
    res.status(500).json({ success: false, error: "Failed to fetch Zapier settings" });
  }
});

// ─── POST /connect — Save webhook URL ────────────────────────────────────────
router.post("/connect", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { webhookUrl, events } = req.body;

    if (!webhookUrl || typeof webhookUrl !== "string") {
      return res.status(400).json({ success: false, error: "webhookUrl is required" });
    }

    // Validate URL format
    try {
      new URL(webhookUrl);
    } catch {
      return res.status(400).json({ success: false, error: "Invalid webhook URL" });
    }

    // Check if user already has a webhook — update it
    const [existing] = await db
      .select()
      .from(zapierWebhooks)
      .where(eq(zapierWebhooks.userId, user.id));

    let webhook;
    if (existing) {
      [webhook] = await db
        .update(zapierWebhooks)
        .set({
          webhookUrl,
          events: events || existing.events,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(zapierWebhooks.id, existing.id))
        .returning();
    } else {
      [webhook] = await db
        .insert(zapierWebhooks)
        .values({
          userId: user.id,
          webhookUrl,
          events: events || undefined,
        })
        .returning();
    }

    res.json({ success: true, data: webhook });
  } catch (err) {
    console.error("[Zapier] Error connecting webhook:", err);
    res.status(500).json({ success: false, error: "Failed to connect Zapier webhook" });
  }
});

// ─── POST /disconnect — Remove webhook ───────────────────────────────────────
router.post("/disconnect", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;

    const result = await db
      .delete(zapierWebhooks)
      .where(eq(zapierWebhooks.userId, user.id))
      .returning();

    if (result.length === 0) {
      return res.status(404).json({ success: false, error: "No webhook found to disconnect" });
    }

    res.json({ success: true, data: { message: "Zapier webhook disconnected" } });
  } catch (err) {
    console.error("[Zapier] Error disconnecting webhook:", err);
    res.status(500).json({ success: false, error: "Failed to disconnect Zapier webhook" });
  }
});

// ─── POST /test — Send test webhook ──────────────────────────────────────────
router.post("/test", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;

    // Use URL from body or from user's saved webhook
    let webhookUrl = req.body.webhookUrl;

    if (!webhookUrl) {
      const [webhook] = await db
        .select()
        .from(zapierWebhooks)
        .where(and(eq(zapierWebhooks.userId, user.id), eq(zapierWebhooks.isActive, true)));

      if (!webhook) {
        return res.status(404).json({ success: false, error: "No active webhook found. Connect a webhook first." });
      }
      webhookUrl = webhook.webhookUrl;
    }

    const result = await testWebhook(webhookUrl);

    if (result.success) {
      res.json({ success: true, data: { message: "Test webhook sent successfully", statusCode: result.statusCode } });
    } else {
      res.status(400).json({ success: false, error: result.error || "Webhook test failed" });
    }
  } catch (err) {
    console.error("[Zapier] Error testing webhook:", err);
    res.status(500).json({ success: false, error: "Failed to test webhook" });
  }
});

// ─── GET /status — Check if connected ────────────────────────────────────────
router.get("/status", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;

    const [webhook] = await db
      .select()
      .from(zapierWebhooks)
      .where(and(eq(zapierWebhooks.userId, user.id), eq(zapierWebhooks.isActive, true)));

    res.json({
      success: true,
      data: {
        connected: !!webhook,
        webhookUrl: webhook?.webhookUrl || null,
        events: webhook?.events || null,
        lastTriggeredAt: webhook?.lastTriggeredAt || null,
      },
    });
  } catch (err) {
    console.error("[Zapier] Error checking status:", err);
    res.status(500).json({ success: false, error: "Failed to check Zapier status" });
  }
});

// ─── POST /generate-key — Generate a new API key for current user ────────────
router.post("/generate-key", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;

    // Revoke any existing active keys for this user
    await db
      .update(apiKeys)
      .set({ isActive: false })
      .where(eq(apiKeys.userId, user.id));

    // Generate a new 64-char hex API key
    const key = crypto.randomBytes(32).toString("hex");

    const [newKey] = await db
      .insert(apiKeys)
      .values({
        userId: user.id,
        key,
        name: "Zapier Integration",
      })
      .returning();

    res.json({ success: true, data: { id: newKey.id, key: newKey.key, name: newKey.name, createdAt: newKey.createdAt } });
  } catch (err) {
    console.error("[Zapier] Error generating API key:", err);
    res.status(500).json({ success: false, error: "Failed to generate API key" });
  }
});

// ─── GET /api-key — Get current user's active API key ────────────────────────
router.get("/api-key", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;

    const [keyRecord] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, user.id), eq(apiKeys.isActive, true)));

    if (!keyRecord) {
      return res.json({ success: true, data: null });
    }

    res.json({
      success: true,
      data: {
        id: keyRecord.id,
        key: keyRecord.key,
        name: keyRecord.name,
        lastUsedAt: keyRecord.lastUsedAt,
        createdAt: keyRecord.createdAt,
      },
    });
  } catch (err) {
    console.error("[Zapier] Error fetching API key:", err);
    res.status(500).json({ success: false, error: "Failed to fetch API key" });
  }
});

// ─── DELETE /api-key — Revoke current user's API key ─────────────────────────
router.delete("/api-key", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;

    const result = await db
      .update(apiKeys)
      .set({ isActive: false })
      .where(and(eq(apiKeys.userId, user.id), eq(apiKeys.isActive, true)))
      .returning();

    if (result.length === 0) {
      return res.status(404).json({ success: false, error: "No active API key found" });
    }

    res.json({ success: true, data: { message: "API key revoked" } });
  } catch (err) {
    console.error("[Zapier] Error revoking API key:", err);
    res.status(500).json({ success: false, error: "Failed to revoke API key" });
  }
});

// ─── OAuth Status & Disconnect ────────────────────────────────────────────────

// GET /oauth/status — check if current user has an active OAuth token
router.get("/oauth/status", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const [token] = await db
      .select()
      .from(zapierOAuthTokens)
      .where(and(eq(zapierOAuthTokens.userId, user.id), eq(zapierOAuthTokens.isActive, true)));

    res.json({
      success: true,
      data: {
        connected: !!token,
        connectedAt: token?.createdAt || null,
      },
    });
  } catch (err) {
    console.error("[Zapier OAuth] Error in /oauth/status:", err);
    res.status(500).json({ success: false, error: "Failed to check status" });
  }
});

// DELETE /oauth/token — revoke OAuth token (disconnect)
router.delete("/oauth/token", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    await db
      .update(zapierOAuthTokens)
      .set({ isActive: false })
      .where(and(eq(zapierOAuthTokens.userId, user.id), eq(zapierOAuthTokens.isActive, true)));

    res.json({ success: true, data: { message: "Zapier disconnected" } });
  } catch (err) {
    console.error("[Zapier OAuth] Error in DELETE /oauth/token:", err);
    res.status(500).json({ success: false, error: "Failed to disconnect" });
  }
});

// ─── OAuth 2.0 Endpoints ──────────────────────────────────────────────────────

// GET /oauth/authorize — Zapier redirects user here to log in and approve access
// This shows a login/consent page or redirects to frontend login
router.get("/oauth/authorize", async (req: Request, res: Response) => {
  try {
    const { client_id, redirect_uri, state } = req.query as Record<string, string>;

    // Validate client_id
    if (client_id !== ZAPIER_CLIENT_ID) {
      return res.status(400).send("Invalid client_id");
    }

    // If user is already logged in via session, generate code immediately
    const user = (req as any).user;
    if (user) {
      const code = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await db.insert(zapierOAuthCodes).values({
        code,
        userId: user.id,
        redirectUri: redirect_uri || ZAPIER_REDIRECT_URI,
        expiresAt,
      });

      const callbackUrl = new URL(redirect_uri || ZAPIER_REDIRECT_URI);
      callbackUrl.searchParams.set("code", code);
      if (state) callbackUrl.searchParams.set("state", state);
      return res.redirect(callbackUrl.toString());
    }

    // Not logged in — redirect to frontend login page with OAuth params
    const loginUrl = new URL(`${FRONTEND_APP_URL}/zapier-auth`);
    loginUrl.searchParams.set("client_id", client_id);
    loginUrl.searchParams.set("redirect_uri", redirect_uri || ZAPIER_REDIRECT_URI);
    if (state) loginUrl.searchParams.set("state", state);

    return res.redirect(loginUrl.toString());
  } catch (err) {
    console.error("[Zapier OAuth] Error in /authorize:", err);
    res.status(500).send("Internal server error");
  }
});

// POST /oauth/callback — Frontend calls this after user logs in, to generate auth code
// User must be authenticated (session cookie)
router.post("/oauth/callback", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { redirect_uri, state } = req.body;

    const code = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await db.insert(zapierOAuthCodes).values({
      code,
      userId: user.id,
      redirectUri: redirect_uri || ZAPIER_REDIRECT_URI,
      expiresAt,
    });

    res.json({ success: true, data: { code, state } });
  } catch (err) {
    console.error("[Zapier OAuth] Error in /oauth/callback:", err);
    res.status(500).json({ success: false, error: "Failed to generate OAuth code" });
  }
});

// POST/GET /oauth/token — Zapier calls this to exchange auth code for access token
// Zapier sends client_id/client_secret via Authorization header (Basic) or body or query
async function handleOAuthToken(req: Request, res: Response) {
  try {
    // Support Basic Auth header (Zapier default) — Authorization: Basic base64(client_id:client_secret)
    let headerClientId = "";
    let headerClientSecret = "";
    const authHeader = req.headers["authorization"] as string;
    if (authHeader?.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      const [id, secret] = decoded.split(":");
      headerClientId = id || "";
      headerClientSecret = secret || "";
    }

    const code = (req.body.code || req.query.code) as string;
    const client_id = (req.body.client_id || req.query.client_id || headerClientId) as string;
    const client_secret = (req.body.client_secret || req.query.client_secret || headerClientSecret) as string;
    const grant_type = (req.body.grant_type || req.query.grant_type || "authorization_code") as string;

    if (grant_type !== "authorization_code") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }

    if (client_id !== ZAPIER_CLIENT_ID || client_secret !== ZAPIER_CLIENT_SECRET) {
      return res.status(401).json({ error: "invalid_client" });
    }

    if (!code) {
      return res.status(400).json({ error: "invalid_request", error_description: "code is required" });
    }

    // Find the code
    const [codeRecord] = await db
      .select()
      .from(zapierOAuthCodes)
      .where(and(eq(zapierOAuthCodes.code, code), eq(zapierOAuthCodes.used, false)));

    if (!codeRecord) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Code not found or already used" });
    }

    if (new Date() > codeRecord.expiresAt) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Code has expired" });
    }

    // Mark code as used
    await db.update(zapierOAuthCodes).set({ used: true }).where(eq(zapierOAuthCodes.id, codeRecord.id));

    // Deactivate any existing tokens for this user
    await db.update(zapierOAuthTokens).set({ isActive: false }).where(eq(zapierOAuthTokens.userId, codeRecord.userId));

    // Generate access token
    const accessToken = crypto.randomBytes(40).toString("hex");

    await db.insert(zapierOAuthTokens).values({
      accessToken,
      userId: codeRecord.userId,
    });

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 31536000,
    });
  } catch (err) {
    console.error("[Zapier OAuth] Error in /oauth/token:", err);
    res.status(500).json({ error: "server_error" });
  }
}

router.post("/oauth/token", handleOAuthToken);
router.get("/oauth/token", handleOAuthToken);


export default router;

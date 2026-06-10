import type { Request, Response } from "express";
import crypto from "crypto";
import { slackStorage } from "../../storage/slackStorage";
import { storage } from "../../storage";
import {
  exchangeCodeForToken,
  encryptToken,
  decryptToken,
  revokeToken,
  isSlackConfigured,
  sendMessage,
  sendDM,
  listChannels,
  buildWelcomeMessage,
  buildWelcomeDM,
} from "../../services/slackService";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

export async function slackOAuthInitHandler(req: Request, res: Response) {
  try {
    if (!isSlackConfigured()) {
      res.status(503).json({ message: "Slack integration is not configured" });
      return;
    }

    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    // Use session-based state instead of JWT
    const state = crypto.randomBytes(32).toString("hex");
    (req.session as any).slackOAuthState = state;
    (req.session as any).slackOAuthUserId = userId;

    const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI
      || `${req.protocol}://${req.get("host")}/api/slack/oauth/callback`;

    const params = new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      scope: "chat:write,channels:read,groups:read,channels:join,im:write,users:read,users:read.email",
      redirect_uri: redirectUri,
      state,
    });

    const slackUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
    res.json({ url: slackUrl });
  } catch (error) {
    console.error("Error initiating Slack OAuth:", error);
    res.status(500).json({ message: "Failed to initiate Slack OAuth" });
  }
}

export async function slackOAuthCallbackHandler(req: Request, res: Response) {
  try {
    const { code, state, error: slackError } = req.query;

    if (slackError) {
      console.error("Slack OAuth error:", slackError);
      res.redirect(`${FRONTEND_URL}/apps-integrations/slack?slack=error&reason=${slackError}`);
      return;
    }

    if (!code || !state) {
      res.redirect(`${FRONTEND_URL}/apps-integrations/slack?slack=error&reason=missing_params`);
      return;
    }

    // Validate state from session
    const sessionState = (req.session as any)?.slackOAuthState;
    const userId = (req.session as any)?.slackOAuthUserId;

    if (!sessionState || sessionState !== state || !userId) {
      res.redirect(`${FRONTEND_URL}/apps-integrations/slack?slack=error&reason=invalid_state`);
      return;
    }

    // Clear session state
    delete (req.session as any).slackOAuthState;
    delete (req.session as any).slackOAuthUserId;

    const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI
      || `${req.protocol}://${req.get("host")}/api/slack/oauth/callback`;

    const oauthResult = await exchangeCodeForToken(code as string, redirectUri);

    const encryptedToken = encryptToken(oauthResult.accessToken);

    await slackStorage.createSlackIntegration({
      teamId: oauthResult.teamId,
      teamName: oauthResult.teamName,
      accessToken: encryptedToken,
      botUserId: oauthResult.botUserId,
      installedByUserId: userId,
      scopes: oauthResult.scopes,
      isEnabled: true,
    });

    // Link the installing user's Slack ID
    if (oauthResult.authedUserId) {
      await storage.updateUserSlackId(userId, oauthResult.authedUserId);
    }

    // Send welcome messages (fire-and-forget)
    try {
      if (oauthResult.authedUserId) {
        const dm = buildWelcomeDM(oauthResult.teamName);
        await sendDM(oauthResult.accessToken, oauthResult.authedUserId, dm.blocks, dm.text);
      }

      const channels = await listChannels(oauthResult.accessToken);
      if (channels.length > 0) {
        const targetChannel = channels.find(c => c.name === "general") || channels[0];
        const welcome = buildWelcomeMessage(oauthResult.teamName);
        await sendMessage(targetChannel.id, welcome.blocks, welcome.text, oauthResult.accessToken);
        const integration = await slackStorage.getActiveIntegration();
        if (integration) {
          await slackStorage.updateSlackIntegration(integration.id, {
            defaultChannelId: targetChannel.id,
            defaultChannelName: targetChannel.name,
          });
        }
      }
    } catch (welcomeErr) {
      console.error("Error sending welcome message:", welcomeErr);
    }

    res.redirect(`${FRONTEND_URL}/apps-integrations/slack?slack=connected`);
  } catch (error: any) {
    console.error("Error in Slack OAuth callback:", error?.message || error);
    const reason = error?.slackError || "exchange_failed";
    res.redirect(`${FRONTEND_URL}/apps-integrations/slack?slack=error&reason=${encodeURIComponent(reason)}`);
  }
}

export async function slackDisconnectHandler(req: Request, res: Response) {
  try {
    const integration = await slackStorage.getActiveIntegration();

    if (!integration) {
      res.status(404).json({ message: "No Slack integration found" });
      return;
    }

    try {
      const token = decryptToken(integration.accessToken);
      await revokeToken(token);
    } catch (err) {
      console.error("Error revoking Slack token:", err);
    }

    await slackStorage.deleteSlackIntegration(integration.id);

    res.json({ message: "Slack workspace disconnected successfully" });
  } catch (error) {
    console.error("Error disconnecting Slack:", error);
    res.status(500).json({ message: "Failed to disconnect Slack" });
  }
}

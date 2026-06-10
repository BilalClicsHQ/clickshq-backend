import type { Express } from "express";
import { requireAuth } from "../../auth";
import { slackOAuthRateLimiter } from "../../middleware/rateLimiter";
import {
  slackOAuthInitHandler,
  slackOAuthCallbackHandler,
  slackDisconnectHandler,
  getSlackSettingsHandler,
  updateSlackSettingsHandler,
  listSlackChannelsHandler,
  testSlackNotificationHandler,
  getSlackChannelMappingsHandler,
  createSlackChannelMappingHandler,
  deleteSlackChannelMappingHandler,
  getSlackUserLinkHandler,
  linkSlackUserHandler,
  unlinkSlackUserHandler,
  getNotificationPreferencesHandler,
  updateNotificationPreferencesHandler,
  getLocationsHandler,
} from "./index";

export function registerSlackRoutes(app: Express) {
  // OAuth - authorize needs auth (session cookie), callback does not (Slack redirects here)
  app.get("/api/slack/oauth/authorize", requireAuth, slackOAuthRateLimiter, slackOAuthInitHandler);
  app.get("/api/slack/oauth/callback", slackOAuthRateLimiter, slackOAuthCallbackHandler);

  // Settings
  app.get("/api/slack/settings", requireAuth, getSlackSettingsHandler);
  app.patch("/api/slack/settings", requireAuth, updateSlackSettingsHandler);
  app.get("/api/slack/channels", requireAuth, listSlackChannelsHandler);
  app.post("/api/slack/test", requireAuth, testSlackNotificationHandler);
  app.delete("/api/slack/disconnect", requireAuth, slackDisconnectHandler);

  // Channel mappings
  app.get("/api/slack/channel-mappings", requireAuth, getSlackChannelMappingsHandler);
  app.post("/api/slack/channel-mappings", requireAuth, createSlackChannelMappingHandler);
  app.delete("/api/slack/channel-mappings/:id", requireAuth, deleteSlackChannelMappingHandler);

  // Locations (spaces + projects for dropdown)
  app.get("/api/slack/locations", requireAuth, getLocationsHandler);

  // Per-user Slack link
  app.get("/api/slack/user-link", requireAuth, getSlackUserLinkHandler);
  app.post("/api/slack/user-link", requireAuth, linkSlackUserHandler);
  app.delete("/api/slack/user-link", requireAuth, unlinkSlackUserHandler);

  // Per-user notification preferences
  app.get("/api/slack/notification-preferences", requireAuth, getNotificationPreferencesHandler);
  app.patch("/api/slack/notification-preferences", requireAuth, updateNotificationPreferencesHandler);
}

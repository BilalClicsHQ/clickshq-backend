import type { Request, Response } from "express";
import { slackStorage } from "../../storage/slackStorage";
import { storage } from "../../storage";
import { db } from "../../db";
import { spaces, workspaceProjects } from "@shared/schema";
import { desc } from "drizzle-orm";
import {
  listChannels,
  decryptToken,
  sendMessage,
  buildTestMessage,
  isSlackConfigured,
  lookupSlackUserByEmail,
} from "../../services/slackService";

export async function getSlackSettingsHandler(req: Request, res: Response) {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration) {
      res.json({ connected: false, configured: isSlackConfigured() });
      return;
    }
    res.json({
      connected: true,
      configured: true,
      teamId: integration.teamId,
      teamName: integration.teamName,
      defaultChannelId: integration.defaultChannelId,
      defaultChannelName: integration.defaultChannelName,
      isEnabled: integration.isEnabled,
      installedByUserId: integration.installedByUserId,
      createdAt: integration.createdAt,
    });
  } catch (error) {
    console.error("Error fetching Slack settings:", error);
    res.status(500).json({ message: "Failed to fetch Slack settings" });
  }
}

export async function updateSlackSettingsHandler(req: Request, res: Response) {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration) {
      res.status(404).json({ message: "No Slack integration found" });
      return;
    }
    const { isEnabled, defaultChannelId, defaultChannelName } = req.body;
    const updates: Record<string, any> = {};
    if (typeof isEnabled === "boolean") updates.isEnabled = isEnabled;
    if (defaultChannelId !== undefined) updates.defaultChannelId = defaultChannelId;
    if (defaultChannelName !== undefined) updates.defaultChannelName = defaultChannelName;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ message: "No valid updates provided" });
      return;
    }
    const updated = await slackStorage.updateSlackIntegration(integration.id, updates);
    res.json(updated);
  } catch (error) {
    console.error("Error updating Slack settings:", error);
    res.status(500).json({ message: "Failed to update Slack settings" });
  }
}

export async function listSlackChannelsHandler(req: Request, res: Response) {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration) {
      res.status(404).json({ message: "No Slack integration found" });
      return;
    }
    const token = decryptToken(integration.accessToken);
    const channels = await listChannels(token);
    res.json(channels);
  } catch (error: any) {
    console.error("Error listing Slack channels:", error);
    const detail = error?.slackError || error?.message || String(error);
    res.status(500).json({ message: "Failed to list Slack channels", error: detail });
  }
}

export async function testSlackNotificationHandler(req: Request, res: Response) {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration) {
      res.status(404).json({ message: "No Slack integration found" });
      return;
    }
    if (!integration.defaultChannelId) {
      res.status(400).json({ message: "No default channel configured" });
      return;
    }
    const token = decryptToken(integration.accessToken);
    const message = buildTestMessage();
    await sendMessage(integration.defaultChannelId, message.blocks, message.text, token);
    res.json({ message: "Test notification sent successfully" });
  } catch (error) {
    console.error("Error sending test notification:", error);
    res.status(500).json({ message: "Failed to send test notification" });
  }
}

export async function getSlackChannelMappingsHandler(req: Request, res: Response) {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration) {
      res.status(404).json({ message: "No Slack integration found" });
      return;
    }
    const mappings = await slackStorage.getChannelMappings(integration.id);
    res.json(mappings);
  } catch (error) {
    console.error("Error fetching channel mappings:", error);
    res.status(500).json({ message: "Failed to fetch channel mappings" });
  }
}

export async function createSlackChannelMappingHandler(req: Request, res: Response) {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration) {
      res.status(404).json({ message: "No Slack integration found" });
      return;
    }
    const { workspaceProjectId, spaceId, channelId, channelName } = req.body;
    if ((!workspaceProjectId && !spaceId) || !channelId || !channelName) {
      res.status(400).json({ message: "Either workspaceProjectId or spaceId, plus channelId and channelName are required" });
      return;
    }
    const mapping = await slackStorage.createChannelMapping({
      slackIntegrationId: integration.id,
      workspaceProjectId: workspaceProjectId || undefined,
      spaceId: spaceId || undefined,
      channelId,
      channelName,
    });
    res.status(201).json(mapping);
  } catch (error) {
    console.error("Error creating channel mapping:", error);
    res.status(500).json({ message: "Failed to create channel mapping" });
  }
}

export async function deleteSlackChannelMappingHandler(req: Request, res: Response) {
  try {
    const deleted = await slackStorage.deleteChannelMapping(req.params.id);
    if (!deleted) {
      res.status(404).json({ message: "Channel mapping not found" });
      return;
    }
    res.json({ message: "Channel mapping deleted" });
  } catch (error) {
    console.error("Error deleting channel mapping:", error);
    res.status(500).json({ message: "Failed to delete channel mapping" });
  }
}

// ==================== USER SLACK LINK ====================

export async function getSlackUserLinkHandler(req: Request, res: Response) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    const user = await storage.getUser(userId);
    res.json({
      linked: !!user?.slackUserId,
      slackUserId: user?.slackUserId || null,
    });
  } catch (error) {
    console.error("Error fetching Slack user link:", error);
    res.status(500).json({ message: "Failed to fetch Slack user link status" });
  }
}

export async function linkSlackUserHandler(req: Request, res: Response) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const integration = await slackStorage.getActiveIntegration();
    if (!integration) {
      res.status(404).json({ message: "No Slack integration found. Connect Slack first." });
      return;
    }

    const user = await storage.getUser(userId);
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const token = decryptToken(integration.accessToken);
    const slackUserId = await lookupSlackUserByEmail(token, user.email);

    if (!slackUserId) {
      res.status(404).json({
        message: `No Slack user found with email ${user.email}. Make sure you use the same email in Slack and ClicksHQ.`,
      });
      return;
    }

    await storage.updateUserSlackId(userId, slackUserId);
    res.json({ linked: true, slackUserId });
  } catch (error) {
    console.error("Error linking Slack user:", error);
    res.status(500).json({ message: "Failed to link Slack user" });
  }
}

export async function unlinkSlackUserHandler(req: Request, res: Response) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    await storage.updateUserSlackId(userId, "");
    res.json({ linked: false, slackUserId: null });
  } catch (error) {
    console.error("Error unlinking Slack user:", error);
    res.status(500).json({ message: "Failed to unlink Slack user" });
  }
}

// ==================== LOCATIONS (Spaces + Projects for dropdown) ====================

export async function getLocationsHandler(req: Request, res: Response) {
  try {
    const allSpaces = await db.select().from(spaces).orderBy(desc(spaces.updatedAt));
    const allProjects = await db.select().from(workspaceProjects).orderBy(desc(workspaceProjects.updatedAt));

    const locations: any[] = [];

    for (const space of allSpaces) {
      locations.push({
        id: space.id,
        name: space.name,
        type: "space",
        children: [],
      });
    }

    for (const project of allProjects) {
      locations.push({
        id: project.id,
        name: project.name,
        type: "project",
        children: [],
      });
    }

    res.json(locations);
  } catch (error) {
    console.error("Error fetching locations:", error);
    res.status(500).json({ message: "Failed to fetch locations" });
  }
}

// ==================== NOTIFICATION PREFERENCES ====================

export async function getNotificationPreferencesHandler(req: Request, res: Response) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const prefs = await slackStorage.getNotificationPreferences(userId);
    if (!prefs) {
      res.json({
        channelTaskCreated: true,
        channelStatusChanged: true,
        channelNewComment: true,
        channelAssigneesChanged: true,
        channelMentioned: true,
        dmTaskAssigned: true,
        dmTaskCompleted: true,
        dmCommentOnMyTask: true,
        dmMentioned: true,
        dmStatusChangeOnMyTask: true,
        dmDeadlineApproaching: true,
      });
      return;
    }

    res.json({
      channelTaskCreated: prefs.channelTaskCreated,
      channelStatusChanged: prefs.channelStatusChanged,
      channelNewComment: prefs.channelNewComment,
      channelAssigneesChanged: prefs.channelAssigneesChanged,
      channelMentioned: prefs.channelMentioned,
      dmTaskAssigned: prefs.dmTaskAssigned,
      dmTaskCompleted: prefs.dmTaskCompleted,
      dmCommentOnMyTask: prefs.dmCommentOnMyTask,
      dmMentioned: prefs.dmMentioned,
      dmStatusChangeOnMyTask: prefs.dmStatusChangeOnMyTask,
      dmDeadlineApproaching: prefs.dmDeadlineApproaching,
    });
  } catch (error) {
    console.error("Error fetching notification preferences:", error);
    res.status(500).json({ message: "Failed to fetch notification preferences" });
  }
}

export async function updateNotificationPreferencesHandler(req: Request, res: Response) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const allowedFields = [
      "channelTaskCreated", "channelStatusChanged", "channelNewComment",
      "channelAssigneesChanged", "channelMentioned",
      "dmTaskAssigned", "dmTaskCompleted", "dmCommentOnMyTask",
      "dmMentioned", "dmStatusChangeOnMyTask", "dmDeadlineApproaching",
    ];

    const updates: Record<string, boolean> = {};
    for (const field of allowedFields) {
      if (typeof req.body[field] === "boolean") {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ message: "No valid preference updates provided" });
      return;
    }

    const prefs = await slackStorage.upsertNotificationPreferences(userId, updates);
    res.json(prefs);
  } catch (error) {
    console.error("Error updating notification preferences:", error);
    res.status(500).json({ message: "Failed to update notification preferences" });
  }
}

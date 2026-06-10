import { slackStorage } from "../storage/slackStorage";
import { db } from "../db";
import { users, projects, projectActivities, tasks, spaces } from "@shared/schema";
import type { Project } from "@shared/schema";
import { eq, ne, and, lte, isNotNull, sql } from "drizzle-orm";
import {
  decryptToken,
  sendMessage,
  sendDM,
  buildTaskCreatedMessage,
  buildTaskUpdatedMessage,
  buildTaskCompletedMessage,
  buildTaskAssignedMessage,
  buildCommentAddedMessage,
  buildDeadlineApproachingMessage,
  buildMentionMessage,
  buildSpaceTaskCreatedMessage,
  buildSpaceTaskUpdatedMessage,
  buildSpaceTaskAssignedMessage,
  SlackApiError,
} from "./slackService";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

function taskUrl(projectId: string): string {
  return `${FRONTEND_URL}/tasks/${projectId}`;
}

/**
 * Resolve the channel to send a notification to.
 * First checks for an explicit channel mapping, then falls back to the default channel.
 */
async function resolveChannel(
  _integrationId: string,
  project: Project
): Promise<string | null> {
  // Check for project-specific channel mapping
  if (project.workspaceProjectId) {
    const mapping = await slackStorage.getChannelMappingForProject(project.workspaceProjectId);
    if (mapping) return mapping.channelId;
  }
  // Fallback to default channel from integration settings
  const integration = await slackStorage.getActiveIntegration();
  if (integration?.defaultChannelId) {
    return integration.defaultChannelId;
  }
  console.warn(`[Slack] No channel mapping or default channel found for project ${project.id}`);
  return null;
}

async function getUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user || undefined;
}

async function getUserName(userId: string | undefined | null): Promise<string> {
  if (!userId) return "Unknown";
  const user = await getUser(userId);
  return user?.displayName || user?.email || "Unknown";
}

async function getUserByDisplayName(displayName: string) {
  const [user] = await db.select().from(users).where(eq(users.displayName, displayName));
  return user || undefined;
}

// ==================== PREFERENCE CHECKS ====================

type DmPreferenceKey =
  | "dmTaskAssigned"
  | "dmTaskCompleted"
  | "dmCommentOnMyTask"
  | "dmMentioned"
  | "dmStatusChangeOnMyTask"
  | "dmDeadlineApproaching";

type ChannelPreferenceKey =
  | "channelTaskCreated"
  | "channelStatusChanged"
  | "channelNewComment"
  | "channelAssigneesChanged"
  | "channelMentioned";

async function isUserDmEnabled(userId: string, key: DmPreferenceKey): Promise<boolean> {
  try {
    const prefs = await slackStorage.getNotificationPreferences(userId);
    if (!prefs) return true;
    return prefs[key] !== false;
  } catch {
    return true;
  }
}

const channelPreferenceMap: Record<string, ChannelPreferenceKey> = {
  task_created: "channelTaskCreated",
  task_updated: "channelStatusChanged",
  task_completed: "channelStatusChanged",
  task_assigned: "channelAssigneesChanged",
  comment_added: "channelNewComment",
  user_mentioned: "channelMentioned",
};

async function isChannelNotificationEnabled(eventType: string, userId?: string | null): Promise<boolean> {
  if (!userId) return true;
  const key = channelPreferenceMap[eventType];
  if (!key) return true;
  try {
    const prefs = await slackStorage.getNotificationPreferences(userId);
    if (!prefs) return true;
    return prefs[key] !== false;
  } catch {
    return true;
  }
}

// ==================== PER-USER DM SUPPORT ====================

async function getTaskFollowerIds(projectId: string): Promise<string[]> {
  const followerIds = new Set<string>();

  const activities = await db
    .select({ userId: projectActivities.userId })
    .from(projectActivities)
    .where(eq(projectActivities.projectId, projectId));

  for (const a of activities) {
    if (a.userId) followerIds.add(a.userId);
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (project?.owner) {
    const ownerUser = await getUserByDisplayName(project.owner);
    if (ownerUser) followerIds.add(ownerUser.id);
  }

  return Array.from(followerIds);
}

async function sendUserDMNotification(
  userId: string,
  message: { text: string; blocks: any[] },
  token: string
): Promise<void> {
  try {
    const user = await getUser(userId);
    if (!user?.slackUserId) {
      console.warn(`[Slack] User ${userId} has no slackUserId linked. Skipping DM.`);
      return;
    }
    await sendDM(token, user.slackUserId, message.blocks, message.text);
  } catch (err) {
    console.error(`[Slack] Failed to send DM to user ${userId}:`, err);
  }
}

async function notifyUsersDM(
  userIds: string[],
  message: { text: string; blocks: any[] },
  excludeUserId?: string | null,
  dmPreferenceKey?: DmPreferenceKey
): Promise<void> {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration || !integration.isEnabled) return;
    const token = decryptToken(integration.accessToken);

    for (const uid of userIds) {
      if (excludeUserId && uid === excludeUserId) continue;
      if (dmPreferenceKey && !(await isUserDmEnabled(uid, dmPreferenceKey))) continue;
      await sendUserDMNotification(uid, message, token);
    }
  } catch (err) {
    console.error("[Slack] Error in notifyUsersDM:", err);
  }
}

// ==================== CHANNEL NOTIFICATION ====================

async function resolveSpaceChannel(spaceId: string): Promise<string | null> {
  const mapping = await slackStorage.getChannelMappingForSpace(spaceId);
  if (mapping) return mapping.channelId;
  // Fallback to default channel
  const integration = await slackStorage.getActiveIntegration();
  if (integration?.defaultChannelId) {
    return integration.defaultChannelId;
  }
  console.warn(`[Slack] No channel mapping or default channel found for space ${spaceId}`);
  return null;
}

async function sendChannelNotification(
  eventType: string,
  channelId: string,
  entityId: string,
  message: { text: string; blocks: any[] },
  triggeredByUserId?: string | null
): Promise<void> {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration || !integration.isEnabled) {
      console.warn(`[Slack] No active/enabled integration found. Skipping ${eventType} channel notification.`);
      return;
    }
    console.log(`[Slack] Sending ${eventType} channel notification to ${channelId} for entity ${entityId}`);

    const token = decryptToken(integration.accessToken);
    const payload = JSON.stringify(message.blocks);

    const log = await slackStorage.createNotificationLog({
      slackIntegrationId: integration.id,
      channelId,
      eventType,
      payload,
      status: "pending",
      entityId,
      triggeredByUserId: triggeredByUserId || undefined,
    });

    try {
      await sendMessage(channelId, message.blocks, message.text, token);
      await slackStorage.updateNotificationLog(log.id, {
        status: "sent",
        sentAt: new Date(),
      });
    } catch (err) {
      const isRetryable = err instanceof SlackApiError && err.isRetryable;
      const retryDelay = isRetryable ? 5 * 60 * 1000 : undefined;
      await slackStorage.updateNotificationLog(log.id, {
        status: "failed",
        lastError: err instanceof Error ? err.message : String(err),
        nextRetryAt: retryDelay ? new Date(Date.now() + retryDelay) : undefined,
      });
      console.error(`[Slack] Failed to send ${eventType} notification:`, err);
    }
  } catch (err) {
    console.error(`[Slack] Error in sendChannelNotification (${eventType}):`, err);
  }
}

async function sendNotification(
  eventType: string,
  project: Project,
  message: { text: string; blocks: any[] },
  triggeredByUserId?: string | null
): Promise<void> {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration || !integration.isEnabled) {
      console.warn(`[Slack] No active/enabled integration found. Skipping ${eventType} notification.`);
      return;
    }

    const channelId = await resolveChannel(integration.id, project);
    if (!channelId) {
      console.warn(`[Slack] No channel resolved for project ${project.id} (workspaceProjectId: ${project.workspaceProjectId}). Skipping ${eventType}.`);
      return;
    }
    console.log(`[Slack] Sending ${eventType} to channel ${channelId} for project ${project.id}`);

    const token = decryptToken(integration.accessToken);
    const payload = JSON.stringify(message.blocks);

    const log = await slackStorage.createNotificationLog({
      slackIntegrationId: integration.id,
      channelId,
      eventType,
      payload,
      status: "pending",
      entityId: project.id,
      triggeredByUserId: triggeredByUserId || undefined,
    });

    try {
      await sendMessage(channelId, message.blocks, message.text, token);
      await slackStorage.updateNotificationLog(log.id, {
        status: "sent",
        sentAt: new Date(),
      });
    } catch (err) {
      const isRetryable = err instanceof SlackApiError && err.isRetryable;
      const retryDelay = isRetryable ? 5 * 60 * 1000 : undefined;
      await slackStorage.updateNotificationLog(log.id, {
        status: "failed",
        lastError: err instanceof Error ? err.message : String(err),
        nextRetryAt: retryDelay ? new Date(Date.now() + retryDelay) : undefined,
      });
      console.error(`[Slack] Failed to send ${eventType} notification:`, err);
    }
  } catch (err) {
    console.error(`[Slack] Error in sendNotification (${eventType}):`, err);
  }
}

// ==================== PUBLIC NOTIFICATION METHODS ====================

export async function notifyTaskCreated(
  project: Project,
  userId?: string | null
): Promise<void> {
  console.log(`[Slack] notifyTaskCreated triggered for project ${project.id}, user ${userId}`);
  const userName = await getUserName(userId);
  const url = taskUrl(project.id);
  const message = buildTaskCreatedMessage(project, userName, url);
  if (await isChannelNotificationEnabled("task_created", userId)) {
    await sendNotification("task_created", project, message, userId);
  } else {
    console.log(`[Slack] Channel notification disabled for task_created by user ${userId}`);
  }
  if (project.owner) {
    const ownerUser = await getUserByDisplayName(project.owner);
    if (ownerUser && ownerUser.id !== userId) {
      await notifyUsersDM([ownerUser.id], message, userId, "dmTaskAssigned");
    }
  }
}

export async function notifyTaskUpdated(
  project: Project,
  changes: Record<string, any>,
  userId?: string | null
): Promise<void> {
  const userName = await getUserName(userId);
  const url = taskUrl(project.id);
  const message = buildTaskUpdatedMessage(project, changes, userName, url);
  if (await isChannelNotificationEnabled("task_updated", userId)) {
    await sendNotification("task_updated", project, message, userId);
  }
  const followers = await getTaskFollowerIds(project.id);
  await notifyUsersDM(followers, message, userId, "dmStatusChangeOnMyTask");
}

export async function notifyTaskCompleted(
  project: Project,
  userId?: string | null
): Promise<void> {
  const userName = await getUserName(userId);
  const url = taskUrl(project.id);
  const message = buildTaskCompletedMessage(project, userName, url);
  if (await isChannelNotificationEnabled("task_completed", userId)) {
    await sendNotification("task_completed", project, message, userId);
  }
  const followers = await getTaskFollowerIds(project.id);
  await notifyUsersDM(followers, message, userId, "dmTaskCompleted");
}

export async function notifyTaskAssigned(
  project: Project,
  assigneeName: string,
  assignerId?: string | null
): Promise<void> {
  const assignerName = await getUserName(assignerId);
  const url = taskUrl(project.id);
  const message = buildTaskAssignedMessage(project, assigneeName, assignerName, url);
  if (await isChannelNotificationEnabled("task_assigned", assignerId)) {
    await sendNotification("task_assigned", project, message, assignerId);
  }
  const assigneeUser = await getUserByDisplayName(assigneeName);
  if (assigneeUser && assigneeUser.id !== assignerId) {
    await notifyUsersDM([assigneeUser.id], message, assignerId, "dmTaskAssigned");
  }
}

export async function notifyCommentAdded(
  projectId: string,
  commentText: string,
  userId?: string | null
): Promise<void> {
  try {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return;
    const userName = await getUserName(userId);
    const url = taskUrl(projectId);
    const message = buildCommentAddedMessage(project, commentText, userName, url);
    if (await isChannelNotificationEnabled("comment_added", userId)) {
      await sendNotification("comment_added", project, message, userId);
    }
    const followers = await getTaskFollowerIds(projectId);
    await notifyUsersDM(followers, message, userId, "dmCommentOnMyTask");
  } catch (err) {
    console.error("[Slack] Error in notifyCommentAdded:", err);
  }
}

export async function notifyUserMentioned(
  projectId: string,
  mentionedUserId: string,
  mentionerUserId?: string | null
): Promise<void> {
  try {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return;
    const mentionedName = await getUserName(mentionedUserId);
    const mentionerName = await getUserName(mentionerUserId);
    const url = taskUrl(projectId);
    const message = buildMentionMessage(project, mentionedName, mentionerName, url);
    if (await isChannelNotificationEnabled("user_mentioned", mentionerUserId)) {
      await sendNotification("user_mentioned", project, message, mentionerUserId);
    }
    await notifyUsersDM([mentionedUserId], message, mentionerUserId, "dmMentioned");
  } catch (err) {
    console.error("[Slack] Error in notifyUserMentioned:", err);
  }
}

// ==================== SPACE TASK NOTIFICATIONS ====================

type Task = typeof tasks.$inferSelect;

async function getAssigneeNames(assigneeIds: string[]): Promise<string[]> {
  const names: string[] = [];
  for (const id of assigneeIds) {
    const user = await getUser(id);
    names.push(user?.displayName || user?.email || "Unknown");
  }
  return names;
}

function spaceTaskUrl(spaceId: string, taskId: string): string {
  return `${FRONTEND_URL}/spaces/${spaceId}?task=${taskId}`;
}

export async function notifySpaceTaskCreated(
  task: Task,
  userId?: string | null
): Promise<void> {
  try {
    console.log(`[Slack] notifySpaceTaskCreated triggered for task ${task.id} in space ${task.spaceId}`);
    const channelId = await resolveSpaceChannel(task.spaceId);
    if (!channelId) {
      console.warn(`[Slack] No channel found for space ${task.spaceId}. Skipping space task notification.`);
      return;
    }
    if (!(await isChannelNotificationEnabled("task_created", userId))) return;

    const userName = await getUserName(userId);
    const assigneeNames = await getAssigneeNames(task.assigneeIds || []);
    const url = spaceTaskUrl(task.spaceId, task.id);
    const message = buildSpaceTaskCreatedMessage(
      { name: task.name, priority: task.priority, dueDate: task.dueDate, assigneeNames },
      userName, url
    );
    await sendChannelNotification("task_created", channelId, task.id, message, userId);

    // DM assignees
    for (const assigneeId of (task.assigneeIds || [])) {
      if (assigneeId !== userId) {
        await notifyUsersDM([assigneeId], message, userId, "dmTaskAssigned");
      }
    }
  } catch (err) {
    console.error("[Slack] Error in notifySpaceTaskCreated:", err);
  }
}

export async function notifySpaceTaskUpdated(
  task: Task,
  changes: Record<string, any>,
  userId?: string | null
): Promise<void> {
  try {
    const channelId = await resolveSpaceChannel(task.spaceId);
    if (!channelId) return;
    if (!(await isChannelNotificationEnabled("task_updated", userId))) return;

    const userName = await getUserName(userId);
    const assigneeNames = await getAssigneeNames(task.assigneeIds || []);
    const url = spaceTaskUrl(task.spaceId, task.id);
    const message = buildSpaceTaskUpdatedMessage(
      { name: task.name, priority: task.priority, dueDate: task.dueDate, assigneeNames },
      changes, userName, url
    );
    await sendChannelNotification("task_updated", channelId, task.id, message, userId);

    // DM assignees
    for (const assigneeId of (task.assigneeIds || [])) {
      if (assigneeId !== userId) {
        await notifyUsersDM([assigneeId], message, userId, "dmStatusChangeOnMyTask");
      }
    }
  } catch (err) {
    console.error("[Slack] Error in notifySpaceTaskUpdated:", err);
  }
}

export async function notifySpaceTaskAssigned(
  task: Task,
  newAssigneeIds: string[],
  userId?: string | null
): Promise<void> {
  try {
    const channelId = await resolveSpaceChannel(task.spaceId);
    if (!channelId) return;

    const assignerName = await getUserName(userId);
    const url = spaceTaskUrl(task.spaceId, task.id);

    for (const assigneeId of newAssigneeIds) {
      if (assigneeId === userId) continue;
      const assigneeName = await getUserName(assigneeId);
      const message = buildSpaceTaskAssignedMessage(
        { name: task.name, priority: task.priority, dueDate: task.dueDate },
        assigneeName, assignerName, url
      );
      if (await isChannelNotificationEnabled("task_assigned", userId)) {
        await sendChannelNotification("task_assigned", channelId, task.id, message, userId);
      }
      await notifyUsersDM([assigneeId], message, userId, "dmTaskAssigned");
    }
  } catch (err) {
    console.error("[Slack] Error in notifySpaceTaskAssigned:", err);
  }
}

// ==================== SCHEDULED JOBS ====================

export async function checkDeadlines(): Promise<void> {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration || !integration.isEnabled) return;

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const todayStr = now.toISOString().split("T")[0];
    const tomorrowStr = tomorrow.toISOString().split("T")[0];

    const upcomingTasks = await db
      .select()
      .from(projects)
      .where(
        and(
          isNotNull(projects.dueDate),
          lte(projects.dueDate, tomorrowStr),
          ne(projects.status, "Completed"),
          sql`${projects.dueDate} >= ${todayStr}`
        )
      );

    const token = decryptToken(integration.accessToken);

    for (const project of upcomingTasks) {
      const url = taskUrl(project.id);
      const message = buildDeadlineApproachingMessage(project, url);
      await sendNotification("deadline_approaching", project, message);
      if (project.owner) {
        const ownerUser = await getUserByDisplayName(project.owner);
        if (ownerUser?.slackUserId && await isUserDmEnabled(ownerUser.id, "dmDeadlineApproaching")) {
          await sendUserDMNotification(ownerUser.id, message, token);
        }
      }
    }

    if (upcomingTasks.length > 0) {
      console.log(`[Slack] Sent deadline reminders for ${upcomingTasks.length} tasks`);
    }
  } catch (err) {
    console.error("[Slack] Error checking deadlines:", err);
  }
}

export async function processRetries(): Promise<void> {
  try {
    const integration = await slackStorage.getActiveIntegration();
    if (!integration || !integration.isEnabled) return;

    const pendingRetries = await slackStorage.getPendingRetryNotifications();
    if (pendingRetries.length === 0) return;

    const token = decryptToken(integration.accessToken);

    for (const log of pendingRetries) {
      try {
        const blocks = JSON.parse(log.payload);
        await sendMessage(log.channelId, blocks, "ClicksHQ notification", token);
        await slackStorage.updateNotificationLog(log.id, {
          status: "sent",
          sentAt: new Date(),
        });
      } catch (err) {
        const newRetryCount = (log.retryCount || 0) + 1;
        const maxRetries = log.maxRetries || 3;
        const backoffMs = Math.pow(2, newRetryCount) * 5 * 60 * 1000;

        await slackStorage.updateNotificationLog(log.id, {
          retryCount: newRetryCount,
          lastError: err instanceof Error ? err.message : String(err),
          status: newRetryCount >= maxRetries ? "failed" : "retrying",
          nextRetryAt: newRetryCount < maxRetries ? new Date(Date.now() + backoffMs) : undefined,
        });
        console.error(`[Slack] Retry failed for notification ${log.id}:`, err);
      }
    }

    console.log(`[Slack] Processed ${pendingRetries.length} notification retries`);
  } catch (err) {
    console.error("[Slack] Error processing retries:", err);
  }
}

/**
 * Slack Daily Digest — sends each connected user a morning summary
 * of overdue and upcoming tasks in their spaces.
 *
 * Runs daily at 9:00 AM user local time (approximation: 9 AM server time;
 * timezone-aware scheduling can be added per-user later).
 */
import { storage } from "../storage";
import { db } from "../db";
import { tasks, userIntegrations, users, slackIntegrations } from "@shared/schema";
import { eq, sql, and, inArray } from "drizzle-orm";
import { decryptToken } from "./slackService";

interface DigestTask {
  id: string;
  shortId: number | null;
  name: string;
  dueDate: string | null;
  priority: string | null;
  spaceId: string;
}

async function getOverdueTasks(userId: string): Promise<DigestTask[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: tasks.id,
      shortId: tasks.shortId,
      name: tasks.name,
      dueDate: tasks.dueDate,
      priority: tasks.priority,
      spaceId: tasks.spaceId,
    })
    .from(tasks)
    .where(
      and(
        sql`${tasks.dueDate} IS NOT NULL`,
        sql`${tasks.dueDate} < ${today}`,
        sql`${userId} = ANY(${tasks.assigneeIds}) OR ${tasks.ownerId} = ${userId}`,
      ),
    )
    .limit(20);
  return rows;
}

async function getUpcomingTasks(userId: string, daysAhead = 7): Promise<DigestTask[]> {
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date();
  future.setDate(future.getDate() + daysAhead);
  const futureStr = future.toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: tasks.id,
      shortId: tasks.shortId,
      name: tasks.name,
      dueDate: tasks.dueDate,
      priority: tasks.priority,
      spaceId: tasks.spaceId,
    })
    .from(tasks)
    .where(
      and(
        sql`${tasks.dueDate} IS NOT NULL`,
        sql`${tasks.dueDate} >= ${today}`,
        sql`${tasks.dueDate} <= ${futureStr}`,
        sql`${userId} = ANY(${tasks.assigneeIds}) OR ${tasks.ownerId} = ${userId}`,
      ),
    )
    .limit(20);
  return rows;
}

/**
 * Get the Slack DM channel ID for the user (lazy: ping the user's Slack and find conversations).
 * Mock: in production this comes from slack_users mapping stored at OAuth time.
 */
async function getSlackDmChannel(token: string, slackUserId: string): Promise<string | null> {
  try {
    const res = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ users: slackUserId }),
    });
    const data: any = await res.json();
    return data?.channel?.id ?? null;
  } catch {
    return null;
  }
}

async function postSlackMessage(token: string, channel: string, text: string, blocks: any[]): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, blocks }),
  });
}

export async function sendSlackDailyDigest(userId: string): Promise<void> {
  // 1. Get user's slack_user_id from users table
  const [userRow] = await db
    .select({ slackUserId: users.slackUserId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const slackUserId = userRow?.slackUserId;
  if (!slackUserId) return;

  // 2. Get the Slack workspace token (any workspace this user installed)
  const [slackInt] = await db
    .select()
    .from(slackIntegrations)
    .where(and(eq(slackIntegrations.installedByUserId, userId), eq(slackIntegrations.isEnabled, true)))
    .limit(1);
  if (!slackInt) return;
  const accessToken = decryptToken(slackInt.accessToken);
  const token = { accessToken };

  const overdue = await getOverdueTasks(userId);
  const upcoming = await getUpcomingTasks(userId);

  if (overdue.length === 0 && upcoming.length === 0) {
    return; // Nothing to report
  }

  const dm = await getSlackDmChannel(token.accessToken, slackUserId);
  if (!dm) return;

  const frontendUrl = process.env.FRONTEND_URL ?? "https://nexus-frontend-sepia.vercel.app";

  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "📋 Your clicsHQ daily digest" },
    },
  ];

  if (overdue.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🚨 Overdue (${overdue.length})*\n${overdue
          .slice(0, 5)
          .map((t) => `• <${frontendUrl}/spaces/${t.spaceId}/tasks/${t.id}|TASK-${t.shortId ?? "?"}> ${t.name} _(${t.dueDate})_`)
          .join("\n")}${overdue.length > 5 ? `\n_…and ${overdue.length - 5} more_` : ""}`,
      },
    });
  }

  if (upcoming.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📅 Upcoming (next 7 days)*\n${upcoming
          .slice(0, 5)
          .map((t) => `• <${frontendUrl}/spaces/${t.spaceId}/tasks/${t.id}|TASK-${t.shortId ?? "?"}> ${t.name} _(${t.dueDate})_`)
          .join("\n")}${upcoming.length > 5 ? `\n_…and ${upcoming.length - 5} more_` : ""}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `<${frontendUrl}|Open clicsHQ> · Daily digest`,
      },
    ],
  });

  const fallbackText = `clicsHQ digest: ${overdue.length} overdue, ${upcoming.length} upcoming`;
  await postSlackMessage(token.accessToken, dm, fallbackText, blocks);
}

/**
 * Send digest to ALL users with Slack connected.
 * Called by daily cron. Uses slackIntegrations table to find connected users.
 */
export async function runDailyDigestCron(): Promise<void> {
  const rows = await db
    .select({ userId: slackIntegrations.installedByUserId })
    .from(slackIntegrations)
    .where(eq(slackIntegrations.isEnabled, true));

  console.log(`[Slack Digest] Running for ${rows.length} users`);
  for (const row of rows) {
    try {
      await sendSlackDailyDigest(row.userId);
    } catch (err: any) {
      console.error(`[Slack Digest] User ${row.userId} failed:`, err.message);
    }
  }
}

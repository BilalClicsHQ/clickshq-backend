import crypto from "crypto";
import type { Project } from "@shared/schema";

// ==================== TOKEN ENCRYPTION ====================

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.SLACK_TOKEN_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("SLACK_TOKEN_ENCRYPTION_KEY environment variable is required");
  }
  return Buffer.from(key, "hex");
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptToken(encrypted: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, ciphertext] = encrypted.split(":");
  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error("Invalid encrypted token format");
  }
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ==================== SLACK API ====================

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
  [key: string]: any;
}

export class SlackApiError extends Error {
  constructor(
    public method: string,
    public slackError: string,
    public isRetryable: boolean
  ) {
    super(`Slack API error [${method}]: ${slackError}`);
    this.name = "SlackApiError";
  }
}

const RETRYABLE_ERRORS = new Set([
  "service_unavailable",
  "internal_error",
  "request_timeout",
  "fatal_error",
]);

export async function slackApiCall(
  method: string,
  token: string,
  body?: Record<string, any>
): Promise<SlackApiResponse> {
  const url = `https://slack.com/api/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("Retry-After") || "30", 10);
    throw Object.assign(
      new SlackApiError(method, "rate_limited", true),
      { retryAfter }
    );
  }

  if (response.status >= 500) {
    throw new SlackApiError(method, `http_${response.status}`, true);
  }

  const data = (await response.json()) as SlackApiResponse;

  if (!data.ok) {
    const isRetryable = RETRYABLE_ERRORS.has(data.error || "");
    throw new SlackApiError(method, data.error || "unknown_error", isRetryable);
  }

  return data;
}

// ==================== OAUTH ====================

export interface SlackOAuthResult {
  accessToken: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  authedUserId: string;
  scopes: string;
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<SlackOAuthResult> {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required");
  }

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = (await response.json()) as any;

  if (!data.ok) {
    throw new SlackApiError("oauth.v2.access", data.error || "oauth_failed", false);
  }

  return {
    accessToken: data.access_token,
    teamId: data.team.id,
    teamName: data.team.name,
    botUserId: data.bot_user_id,
    authedUserId: data.authed_user?.id || "",
    scopes: data.scope || "",
  };
}

export async function revokeToken(token: string): Promise<void> {
  await slackApiCall("auth.revoke", token);
}

export async function openDM(token: string, slackUserId: string): Promise<string> {
  const data = await slackApiCall("conversations.open", token, {
    users: slackUserId,
  });
  return data.channel?.id;
}

export async function sendDM(
  token: string,
  slackUserId: string,
  blocks: any[],
  text: string
): Promise<void> {
  const channelId = await openDM(token, slackUserId);
  if (channelId) {
    await slackApiCall("chat.postMessage", token, {
      channel: channelId,
      blocks,
      text,
    });
  }
}

export async function listChannels(
  token: string
): Promise<Array<{ id: string; name: string; isPrivate: boolean }>> {
  const channels: Array<{ id: string; name: string; isPrivate: boolean }> = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, any> = {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    };
    if (cursor) body.cursor = cursor;

    const data = await slackApiCall("conversations.list", token, body);

    for (const ch of data.channels || []) {
      channels.push({
        id: ch.id,
        name: ch.name,
        isPrivate: ch.is_private,
      });
    }

    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels;
}

export async function lookupSlackUserByEmail(
  token: string,
  email: string
): Promise<string | null> {
  try {
    const data = await slackApiCall("users.lookupByEmail", token, { email });
    return data.user?.id || null;
  } catch {
    return null;
  }
}

export async function sendMessage(
  channelId: string,
  blocks: any[],
  text: string,
  token: string
): Promise<void> {
  try {
    await slackApiCall("chat.postMessage", token, {
      channel: channelId,
      blocks,
      text,
    });
  } catch (error: any) {
    if (error?.slackError === "not_in_channel") {
      await slackApiCall("conversations.join", token, { channel: channelId });
      await slackApiCall("chat.postMessage", token, {
        channel: channelId,
        blocks,
        text,
      });
    } else {
      throw error;
    }
  }
}

// ==================== MESSAGE BUILDERS ====================

function statusEmoji(status: string | null): string {
  switch (status) {
    case "Not Started": return "\u26AA";
    case "In Progress": return "\uD83D\uDD35";
    case "Completed": return "\u2705";
    case "Blocked": return "\uD83D\uDED1";
    case "Reviewing": return "\uD83D\uDD0D";
    case "Design Approval Needed": return "\uD83C\uDFA8";
    case "Temporary Hold": return "\u23F8\uFE0F";
    default: return "\u26AA";
  }
}

function riskEmoji(risk: string | null): string {
  switch (risk) {
    case "Low": return "\uD83D\uDFE2";
    case "Medium": return "\uD83D\uDFE1";
    case "High": return "\uD83D\uDD34";
    default: return "\u2796";
  }
}

function taskFields(project: Project, taskUrl: string): any[] {
  return [
    { type: "mrkdwn", text: `*Task:*\n<${taskUrl}|${project.task}>` },
    { type: "mrkdwn", text: `*Status:*\n${statusEmoji(project.status)} ${project.status || "Not Set"}` },
    { type: "mrkdwn", text: `*Assigned To:*\n${project.owner || "Unassigned"}` },
    { type: "mrkdwn", text: `*Due Date:*\n${project.dueDate || "Not set"}` },
    { type: "mrkdwn", text: `*Risk:*\n${riskEmoji(project.risk)} ${project.risk || "Not set"}` },
    { type: "mrkdwn", text: `*Type:*\n${project.taskType || "Not set"}` },
  ];
}

function actionButton(taskUrl: string): any {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View Task", emoji: true },
        url: taskUrl,
        style: "primary",
      },
    ],
  };
}

export function buildTaskCreatedMessage(project: Project, userName: string, taskUrl: string) {
  return {
    text: `New task created: ${project.task}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\uD83D\uDCCB New Task Created", emoji: true } },
      { type: "section", fields: taskFields(project, taskUrl) },
      { type: "context", elements: [{ type: "mrkdwn", text: `Created by *${userName}*` }] },
      { type: "divider" },
      actionButton(taskUrl),
    ],
  };
}

export function buildTaskUpdatedMessage(
  project: Project,
  changes: Record<string, any>,
  userName: string,
  taskUrl: string
) {
  const changeLines = Object.entries(changes)
    .filter(([key]) => !["lastUpdated", "createdAt"].includes(key))
    .map(([key, value]) => `\u2022 *${key}*: ${value}`)
    .join("\n");

  return {
    text: `Task updated: ${project.task}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\u270F\uFE0F Task Updated", emoji: true } },
      { type: "section", fields: taskFields(project, taskUrl) },
      { type: "section", text: { type: "mrkdwn", text: `*Changes:*\n${changeLines || "No details"}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Updated by *${userName}*` }] },
      { type: "divider" },
      actionButton(taskUrl),
    ],
  };
}

export function buildTaskCompletedMessage(project: Project, userName: string, taskUrl: string) {
  return {
    text: `Task completed: ${project.task}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\u2705 Task Completed", emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Task:*\n<${taskUrl}|${project.task}>` },
          { type: "mrkdwn", text: `*Assigned To:*\n${project.owner || "Unassigned"}` },
          { type: "mrkdwn", text: `*Due Date:*\n${project.dueDate || "Not set"}` },
          { type: "mrkdwn", text: `*Type:*\n${project.taskType || "Not set"}` },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `Completed by *${userName}*` }] },
      { type: "divider" },
      actionButton(taskUrl),
    ],
  };
}

export function buildTaskAssignedMessage(
  project: Project,
  assigneeName: string,
  assignerName: string,
  taskUrl: string
) {
  return {
    text: `Task assigned to ${assigneeName}: ${project.task}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\uD83D\uDC64 Task Assigned", emoji: true } },
      { type: "section", fields: taskFields(project, taskUrl) },
      { type: "context", elements: [{ type: "mrkdwn", text: `Assigned to *${assigneeName}* by *${assignerName}*` }] },
      { type: "divider" },
      actionButton(taskUrl),
    ],
  };
}

export function buildCommentAddedMessage(
  project: Project,
  commentText: string,
  userName: string,
  taskUrl: string
) {
  return {
    text: `New comment on ${project.task}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\uD83D\uDCAC New Comment", emoji: true } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${taskUrl}|${project.task}>*\n\n> ${commentText.substring(0, 300)}${commentText.length > 300 ? "..." : ""}`,
        },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `Comment by *${userName}*` }] },
      { type: "divider" },
      actionButton(taskUrl),
    ],
  };
}

export function buildDeadlineApproachingMessage(project: Project, taskUrl: string) {
  return {
    text: `Deadline approaching: ${project.task}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\u23F0 Deadline Approaching", emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Task:*\n<${taskUrl}|${project.task}>` },
          { type: "mrkdwn", text: `*Status:*\n${statusEmoji(project.status)} ${project.status || "Not Set"}` },
          { type: "mrkdwn", text: `*Assigned To:*\n${project.owner || "Unassigned"}` },
          { type: "mrkdwn", text: `*Due Date:*\n${project.dueDate || "Not set"}` },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `\u26A0\uFE0F This task is due within the next 24 hours` }] },
      { type: "divider" },
      actionButton(taskUrl),
    ],
  };
}

export function buildMentionMessage(
  project: Project,
  mentionedName: string,
  mentionerName: string,
  taskUrl: string
) {
  return {
    text: `${mentionedName} was mentioned in ${project.task}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\uD83D\uDD14 You Were Mentioned", emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Task:*\n<${taskUrl}|${project.task}>` },
          { type: "mrkdwn", text: `*Status:*\n${statusEmoji(project.status)} ${project.status || "Not Set"}` },
          { type: "mrkdwn", text: `*Assigned To:*\n${project.owner || "Unassigned"}` },
          { type: "mrkdwn", text: `*Due Date:*\n${project.dueDate || "Not set"}` },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `*${mentionedName}* was mentioned by *${mentionerName}*` }] },
      { type: "divider" },
      actionButton(taskUrl),
    ],
  };
}

export function buildTestMessage() {
  return {
    text: "Test notification from ClicksHQ",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\uD83D\uDE80 ClicksHQ Connected!", emoji: true } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Your Slack integration is working correctly. You will receive task notifications in this channel.",
        },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "Sent from *ClicksHQ*" }] },
    ],
  };
}

export function buildWelcomeDM(teamName: string) {
  const appUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  return {
    text: `You've successfully installed ClicksHQ's app for Slack!`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `Hi! You've successfully installed *ClicksHQ's* app for Slack.` },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Stay on top of your projects by syncing notifications, tracking task updates, and keeping your team informed \u2014 all within Slack.",
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Configure notifications in Slack*\nNotifications will appear in your configured channel. To manage settings, visit <${appUrl}/apps-integrations/slack|notification settings> in ClicksHQ.`,
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*What you'll receive*\n\n\u2022 Task created \u2014 when a new task is added\n\u2022 Task updated \u2014 status changes, reassignments\n\u2022 Task completed \u2014 when work is done\n\u2022 Task assigned \u2014 ownership changes\n\u2022 Comments \u2014 new comments on tasks\n\u2022 Deadline reminders \u2014 approaching due dates\n\u2022 Mentions \u2014 when you're mentioned",
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Need help?*\nVisit <${appUrl}/apps-integrations/slack|ClicksHQ Slack Settings> to configure your default channel and per-project channel mappings.`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `<${appUrl}|ClicksHQ>` }],
      },
    ],
  };
}

export function buildWelcomeMessage(teamName: string) {
  return {
    text: `ClicksHQ has been connected to ${teamName}!`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\uD83C\uDF89 ClicksHQ Connected!", emoji: true } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*ClicksHQ* has been successfully connected to *${teamName}*!\n\nYou'll now receive notifications here for:`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "\u2022 \uD83D\uDCCB New tasks created\n\u2022 \u270F\uFE0F Task updates & status changes\n\u2022 \u2705 Task completions\n\u2022 \uD83D\uDC64 Task assignments\n\u2022 \uD83D\uDCAC New comments\n\u2022 \u23F0 Deadline reminders\n\u2022 \uD83D\uDD14 Mentions",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Head over to *ClicksHQ > Apps & Integrations > Slack* to configure your default channel and per-project channel mappings.",
        },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "Powered by *ClicksHQ*" }] },
    ],
  };
}

// ==================== SPACE TASK MESSAGE BUILDERS ====================

interface SpaceTaskInfo {
  name: string;
  priority?: string | null;
  dueDate?: string | null;
  assigneeNames?: string[];
}

function spaceTaskFields(task: SpaceTaskInfo, taskUrl: string): any[] {
  return [
    { type: "mrkdwn", text: `*Task:*\n<${taskUrl}|${task.name}>` },
    { type: "mrkdwn", text: `*Priority:*\n${task.priority || "Not set"}` },
    { type: "mrkdwn", text: `*Assigned To:*\n${task.assigneeNames?.join(", ") || "Unassigned"}` },
    { type: "mrkdwn", text: `*Due Date:*\n${task.dueDate || "Not set"}` },
  ];
}

export function buildSpaceTaskCreatedMessage(task: SpaceTaskInfo, userName: string, taskUrl: string) {
  return {
    text: `New task created: ${task.name}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\uD83D\uDCCB New Task Created", emoji: true } },
      { type: "section", fields: spaceTaskFields(task, taskUrl) },
      { type: "context", elements: [{ type: "mrkdwn", text: `Created by *${userName}*` }] },
      { type: "divider" },
      actionButton(taskUrl),
    ],
  };
}

export function buildSpaceTaskUpdatedMessage(task: SpaceTaskInfo, changes: Record<string, any>, userName: string, taskUrl: string) {
  const changeLines = Object.entries(changes)
    .filter(([key]) => !["updatedAt", "createdAt", "order"].includes(key))
    .map(([key, value]) => `\u2022 *${key}*: ${value}`)
    .join("\n");

  return {
    text: `Task updated: ${task.name}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\u270F\uFE0F Task Updated", emoji: true } },
      { type: "section", fields: spaceTaskFields(task, taskUrl) },
      { type: "section", text: { type: "mrkdwn", text: `*Changes:*\n${changeLines || "No details"}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Updated by *${userName}*` }] },
      { type: "divider" },
      actionButton(taskUrl),
    ],
  };
}

export function buildSpaceTaskAssignedMessage(task: SpaceTaskInfo, assigneeName: string, assignerName: string, taskUrl: string) {
  return {
    text: `Task assigned: ${task.name}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "\uD83D\uDC64 Task Assigned", emoji: true } },
      { type: "section", fields: spaceTaskFields(task, taskUrl) },
      { type: "context", elements: [{ type: "mrkdwn", text: `*${assignerName}* assigned this task to *${assigneeName}*` }] },
      { type: "divider" },
      actionButton(taskUrl),
    ],
  };
}

export function isSlackConfigured(): boolean {
  return !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
}

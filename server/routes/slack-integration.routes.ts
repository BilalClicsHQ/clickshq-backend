/**
 * Slack Integration routes — extends existing notifications with:
 *   - Slash command receiver: /clicshq create-task <text>
 *   - Message action / shortcut: convert message → task
 *   - Mention-to-task AI suggestion (analyzes a message for actionable content)
 *   - Daily digest trigger (also auto-run by cron)
 *
 * Mounted at /api/integrations/slack.
 *
 *   POST /commands                      – Slack slash command receiver (Slack hits this)
 *   POST /interactivity                 – Slack message actions / button clicks
 *   POST /tasks/from-message            – Auth'd endpoint to convert message → task
 *   POST /suggest-task                  – AI: analyze message, suggest task creation
 *   POST /digest/send                   – Manually trigger digest send for current user
 */
import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { db } from "../db";
import { users, spaces, spaceStatuses } from "@shared/schema";
import { eq, and } from "drizzle-orm";

const router = Router();

// ── Slack signature verification middleware ────────────────────────────────
/**
 * Slack signs every request. We verify with SLACK_SIGNING_SECRET.
 * IMPORTANT: This requires the raw body (already captured by index.ts verify hook
 * for /api/webhooks/* — but Slack uses /api/integrations/slack/commands).
 * We add the path to the raw-body capture allowlist below.
 */
function verifySlackSignature(
  rawBody: Buffer | string | undefined,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!rawBody || !timestamp || !signature) return false;
  // Reject replays older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;
  const basestring = `v0:${timestamp}:${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const expected = `v0=${crypto.createHmac("sha256", secret).update(basestring).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Slash command receiver ──────────────────────────────────────────────────
/**
 * Slack sends POST application/x-www-form-urlencoded.
 * Command format: /clicshq <subcommand> <args>
 * Supported: `create-task <text>`
 */
router.post("/commands", async (req: Request, res: Response) => {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (signingSecret) {
    const rawBody = (req as any).rawBody;
    const ok = verifySlackSignature(
      rawBody,
      req.headers["x-slack-request-timestamp"] as string,
      req.headers["x-slack-signature"] as string,
      signingSecret,
    );
    if (!ok) {
      return res.status(401).send("invalid signature");
    }
  }

  const { command, text, user_id, channel_id, team_id, response_url } = req.body;

  // Quick acknowledge — Slack expects 200 within 3s
  res.status(200).json({
    response_type: "ephemeral",
    text: "⏳ Processing your request…",
  });

  // Process async
  (async () => {
    try {
      const parts = String(text || "").trim().split(/\s+/);
      const subcommand = parts.shift()?.toLowerCase();
      const taskText = parts.join(" ");

      if (subcommand === "create-task" && taskText) {
        // 1. Find clicsHQ user by Slack user_id mapping
        const [matchedUser] = await db
          .select()
          .from(users)
          .where(eq(users.slackUserId, user_id))
          .limit(1);

        if (!matchedUser) {
          await fetch(response_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              response_type: "ephemeral",
              text: `❌ Your Slack account is not linked to clicsHQ. Go to clicsHQ → Integrations → Slack to connect.`,
            }),
          });
          return;
        }

        // 2. Get user's first owned space + first status
        const [space] = await db
          .select()
          .from(spaces)
          .where(eq(spaces.ownerId, matchedUser.id))
          .limit(1);

        if (!space) {
          await fetch(response_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              response_type: "ephemeral",
              text: `❌ You don't have any spaces in clicsHQ. Create a space first.`,
            }),
          });
          return;
        }

        const [status] = await db
          .select()
          .from(spaceStatuses)
          .where(eq(spaceStatuses.spaceId, space.id))
          .limit(1);

        if (!status) {
          await fetch(response_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              response_type: "ephemeral",
              text: `❌ Your space has no statuses configured.`,
            }),
          });
          return;
        }

        // 3. Create task
        const task = await storage.createTask({
          spaceId: space.id,
          name: taskText.slice(0, 200),
          description: `Created via Slack slash command\nChannel: <#${channel_id}>`,
          statusId: status.id,
          priority: null,
          ownerId: matchedUser.id,
          assigneeIds: [matchedUser.id],
          attachments: [],
          labels: ["from-slack"],
        });

        await storage.createTaskActivity({
          taskId: task.id,
          type: "slack_task_created_from_message",
          actorUserId: matchedUser.id,
          payload: { channelId: channel_id, command: "slash" },
        }).catch(() => undefined);

        const frontendUrl = process.env.FRONTEND_URL ?? "https://nexus-frontend-sepia.vercel.app";
        await fetch(response_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            response_type: "ephemeral",
            text: `✅ Task created in *${space.name}*: <${frontendUrl}/spaces/${space.id}/tasks/${task.id}|TASK-${task.shortId ?? "?"} ${task.name}>`,
          }),
        });
      } else {
        await fetch(response_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            response_type: "ephemeral",
            text: `Usage: \`/clicshq create-task <description>\``,
          }),
        });
      }
    } catch (err) {
      console.error("[Slack Command] error:", err);
    }
  })();
});

// ── Interactivity receiver (message actions / shortcuts / buttons) ──────────
router.post("/interactivity", async (req: Request, res: Response) => {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (signingSecret) {
    const rawBody = (req as any).rawBody;
    const ok = verifySlackSignature(
      rawBody,
      req.headers["x-slack-request-timestamp"] as string,
      req.headers["x-slack-signature"] as string,
      signingSecret,
    );
    if (!ok) return res.status(401).send("invalid signature");
  }

  // Slack sends payload as form-encoded `payload` JSON string
  let payload: any = {};
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).send("invalid payload");
  }

  res.status(200).send(""); // Ack immediately

  // Process async based on type
  (async () => {
    try {
      if (payload.type === "message_action" && payload.callback_id === "create_task_from_message") {
        // Slack message action — message info is in payload.message
        console.log("[Slack Action] create_task_from_message:", payload.message?.text?.slice(0, 100));
        // TODO: open modal asking which space to create task in
      }
    } catch (err) {
      console.error("[Slack Interactivity] error:", err);
    }
  })();
});

// ── Authenticated endpoint: convert message → task (from frontend UI) ───────
router.post(
  "/tasks/from-message",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { spaceId, messageText, channelName, slackPermalink, authorName } = req.body;
      if (!spaceId || !messageText) {
        return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS" } });
      }

      const statuses = (await (storage as any).getSpaceStatuses?.(spaceId)) ?? [];
      const defaultStatusId = statuses[0]?.id;
      if (!defaultStatusId) {
        return res.status(400).json({ success: false, error: { code: "NO_STATUSES" } });
      }

      const firstLine = String(messageText).split("\n")[0]?.slice(0, 100) || "Task from Slack";
      const taskName = firstLine;
      const description = `From Slack${channelName ? ` #${channelName}` : ""}${authorName ? ` — ${authorName}` : ""}\n\n${messageText}${slackPermalink ? `\n\n🔗 ${slackPermalink}` : ""}`;

      const task = await storage.createTask({
        spaceId,
        name: taskName,
        description,
        statusId: defaultStatusId,
        priority: null,
        ownerId: user.id,
        assigneeIds: [],
        attachments: [],
        labels: ["from-slack"],
      });

      await storage.createTaskActivity({
        taskId: task.id,
        type: "slack_task_created_from_message",
        actorUserId: user.id,
        payload: {
          channelName,
          authorName,
          slackPermalink,
          messagePreview: String(messageText).slice(0, 200),
        },
      }).catch(() => undefined);

      return res.json({ success: true, data: { task } });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── AI Suggestion: analyze message for actionable content ──────────────────
/**
 * Uses the existing Groq agent infrastructure to analyze a message and decide
 * if a task should be created. Returns { isActionable, suggestedTaskName,
 * suggestedPriority, reasoning }.
 */
router.post(
  "/suggest-task",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { messageText } = req.body;
      if (!messageText) {
        return res.status(400).json({ success: false, error: { code: "MISSING_MESSAGE" } });
      }

      // Use Groq directly with a small prompt
      const groqKey = process.env.GROQ_API_KEY;
      if (!groqKey) {
        return res.json({
          success: true,
          data: { isActionable: false, reasoning: "AI not configured" },
        });
      }

      const prompt = `Analyze this chat message and decide if it represents an actionable task someone needs to do.

Message: "${messageText}"

Respond ONLY in this exact JSON format (no other text):
{
  "isActionable": true or false,
  "suggestedTaskName": "short task title if actionable, else null",
  "suggestedPriority": "low" | "normal" | "high" if actionable, else null,
  "reasoning": "1-sentence explanation"
}`;

      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 200,
          response_format: { type: "json_object" },
        }),
      });

      if (!resp.ok) {
        return res.json({
          success: true,
          data: { isActionable: false, reasoning: "AI service unavailable" },
        });
      }

      const data: any = await resp.json();
      const content = data.choices?.[0]?.message?.content ?? "{}";
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = { isActionable: false, reasoning: "Could not parse AI response" };
      }

      return res.json({ success: true, data: parsed });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Manually trigger daily digest ───────────────────────────────────────────
router.post(
  "/digest/send",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { sendSlackDailyDigest } = await import("../services/slackDailyDigestService");
      await sendSlackDailyDigest(user.id);
      return res.json({ success: true });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

export default router;

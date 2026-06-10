/**
 * MS Teams Integration routes.
 *
 * Mounted at /api/integrations/teams.
 *
 *   POST /tasks/from-chat-message       – Convert a Teams chat message into a task
 *   POST /test-notification             – Send a test notification to the user's Teams
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { getValidToken } from "../services/tokenService";
import { sendTeamsNotification } from "../services/msTeamsNotificationService";

const router = Router();

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function userTeamsToken(userId: string) {
  try {
    return await getValidToken(userId, "ms_teams");
  } catch {
    return null;
  }
}

async function graph(token: string, endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`${GRAPH_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error?.message || `Teams API error: ${res.status}`);
  }
  if (res.status === 204) return null;
  return await res.json();
}

// ── Convert a Teams message into a task ─────────────────────────────────────
/**
 * Body: { chatId, messageId, spaceId }
 *   - Reads the message via Graph
 *   - Strips HTML from body to get clean task description
 *   - Creates task with first line of message as name
 */
router.post(
  "/tasks/from-chat-message",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { chatId, messageId, spaceId } = req.body;
      if (!chatId || !messageId || !spaceId) {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_FIELDS" } });
      }

      const token = await userTeamsToken(user.id);
      if (!token) {
        return res
          .status(403)
          .json({ success: false, error: { code: "NOT_CONNECTED" } });
      }

      const msg: any = await graph(
        token.accessToken,
        `/chats/${chatId}/messages/${messageId}`,
      );

      // Extract content
      const htmlBody = msg.body?.content ?? "";
      const plainText = htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const firstLine = plainText.split(/[\.\n]/)[0]?.slice(0, 100) || "Task from Teams chat";
      const sender = msg.from?.user?.displayName ?? "Teams user";

      // Get default status
      const statuses = (await (storage as any).getSpaceStatuses?.(spaceId)) ?? [];
      const defaultStatusId = statuses[0]?.id;
      if (!defaultStatusId) {
        return res.status(400).json({ success: false, error: { code: "NO_STATUSES" } });
      }

      const task = await storage.createTask({
        spaceId,
        name: firstLine,
        description: `From Teams chat — ${sender}:\n\n${plainText}`,
        statusId: defaultStatusId,
        priority: null,
        ownerId: user.id,
        assigneeIds: [],
        attachments: [],
        labels: ["from-teams"],
      });

      await storage.createTaskActivity({
        taskId: task.id,
        type: "ms_teams_task_created_from_chat",
        actorUserId: user.id,
        payload: {
          chatId,
          messageId,
          sender,
          snippet: plainText.slice(0, 200),
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

// ── Test notification ───────────────────────────────────────────────────────
router.post(
  "/test-notification",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      await sendTeamsNotification(user.id, {
        title: "Hello from clicsHQ 👋",
        body: "Your Teams integration is working! You'll get notifications here when important task events happen.",
        link: process.env.FRONTEND_URL ?? "https://nexus-frontend-sepia.vercel.app",
        actionLabel: "Open clicsHQ",
      });
      return res.json({ success: true });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

export default router;

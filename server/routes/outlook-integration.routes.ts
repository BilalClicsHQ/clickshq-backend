/**
 * Outlook Integration routes — Email features for tasks.
 *
 * Mounted at /api/integrations/outlook.
 *
 *   GET    /tasks/:taskId/emails                – List emails linked to a task (timeline)
 *   POST   /tasks/:taskId/from-email            – Convert an Outlook email into a clicsHQ task
 *   POST   /tasks/:taskId/link-email            – Manually link an existing email
 *   POST   /tasks/:taskId/reply                 – Send a reply email from within task
 *   DELETE /tasks/:taskId/emails/:id            – Unlink an email
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { getValidToken } from "../services/tokenService";

const router = Router();

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function userOutlookToken(userId: string) {
  try {
    return await getValidToken(userId, "outlook_email");
  } catch {
    return null;
  }
}

async function graphCall(token: string, endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`${GRAPH_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let errMsg = `Outlook API error: ${res.status}`;
    try {
      const body = text ? JSON.parse(text) : null;
      if (body?.error?.message) errMsg = body.error.message;
    } catch { /* keep default */ }
    throw new Error(errMsg);
  }
  // Empty body responses: 202 Accepted (reply, send, etc.), 204 No Content (delete)
  if (res.status === 204 || res.status === 202) return null;
  // Some endpoints (e.g. some actions) return 200 with empty body — handle gracefully
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── List linked emails on a task ────────────────────────────────────────────
router.get(
  "/tasks/:taskId/emails",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const links = await storage.getTaskEmailLinks(req.params.taskId);
      return res.json({ success: true, data: links });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Convert an Outlook email into a task ────────────────────────────────────
/**
 * Body: { messageId, spaceId }
 *   - Fetches email from Outlook
 *   - Creates clicsHQ task with subject as name, snippet as description
 *   - Links the email to the new task
 */
router.post(
  "/tasks/from-email",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { messageId, spaceId } = req.body;
      if (!messageId || !spaceId) {
        return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS" } });
      }

      const token = await userOutlookToken(user.id);
      if (!token) {
        return res.status(403).json({ success: false, error: { code: "NOT_CONNECTED" } });
      }

      const msg: any = await graphCall(
        token.accessToken,
        `/me/messages/${messageId}?$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,internetMessageId,conversationId,webLink`,
      );

      // Get default status for the space
      const statuses = (await (storage as any).getSpaceStatuses?.(spaceId)) ?? [];
      const defaultStatusId = statuses[0]?.id;
      if (!defaultStatusId) {
        return res.status(400).json({ success: false, error: { code: "NO_STATUSES" } });
      }

      // Create task
      const task = await storage.createTask({
        spaceId,
        name: msg.subject || "(no subject)",
        description: msg.bodyPreview || "",
        statusId: defaultStatusId,
        priority: null,
        ownerId: user.id,
        assigneeIds: [],
        attachments: [],
        labels: ["from-email"],
      });

      // Link the email
      const link = await storage.createTaskEmailLink({
        taskId: task.id,
        provider: "outlook",
        messageId: msg.id,
        internetMessageId: msg.internetMessageId,
        conversationId: msg.conversationId,
        subject: msg.subject,
        fromAddress: msg.from?.emailAddress?.address,
        fromName: msg.from?.emailAddress?.name,
        toAddresses: (msg.toRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean),
        snippet: msg.bodyPreview,
        receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null,
        isReply: false,
        webUrl: msg.webLink,
        linkedBy: user.id,
      });

      await storage.createTaskActivity({
        taskId: task.id,
        type: "outlook_email_converted",
        actorUserId: user.id,
        payload: {
          messageId: msg.id,
          subject: msg.subject,
          from: msg.from?.emailAddress?.address,
          webUrl: msg.webLink,
        },
      }).catch(() => undefined);

      return res.json({ success: true, data: { task, link } });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Manually link an existing email to a task ───────────────────────────────
router.post(
  "/tasks/:taskId/link-email",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const { messageId } = req.body;
      if (!messageId) {
        return res.status(400).json({ success: false, error: { code: "MISSING_MESSAGE_ID" } });
      }

      // Dedupe
      const existing = await storage.findTaskEmailLink(taskId, "outlook", messageId);
      if (existing) {
        return res.json({ success: true, data: existing, deduped: true });
      }

      const token = await userOutlookToken(user.id);
      if (!token) {
        return res.status(403).json({ success: false, error: { code: "NOT_CONNECTED" } });
      }

      const msg: any = await graphCall(
        token.accessToken,
        `/me/messages/${messageId}?$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,internetMessageId,conversationId,webLink`,
      );

      const link = await storage.createTaskEmailLink({
        taskId,
        provider: "outlook",
        messageId: msg.id,
        internetMessageId: msg.internetMessageId,
        conversationId: msg.conversationId,
        subject: msg.subject,
        fromAddress: msg.from?.emailAddress?.address,
        fromName: msg.from?.emailAddress?.name,
        toAddresses: (msg.toRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean),
        snippet: msg.bodyPreview,
        receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null,
        isReply: false,
        webUrl: msg.webLink,
        linkedBy: user.id,
      });

      await storage.createTaskActivity({
        taskId,
        type: "outlook_email_linked",
        actorUserId: user.id,
        payload: { messageId: msg.id, subject: msg.subject, webUrl: msg.webLink },
      }).catch(() => undefined);

      return res.json({ success: true, data: link });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Send reply from task ────────────────────────────────────────────────────
/**
 * Body: { conversationId | replyToMessageId, body }
 *   - Uses Outlook reply API to send within thread
 *   - Logs the sent message as an email link (isReply: true)
 */
router.post(
  "/tasks/:taskId/reply",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const { replyToMessageId, body, replyAll } = req.body;
      if (!replyToMessageId || !body) {
        return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS" } });
      }

      const token = await userOutlookToken(user.id);
      if (!token) {
        return res.status(403).json({ success: false, error: { code: "NOT_CONNECTED" } });
      }

      // Send reply via Graph API
      const endpoint = replyAll
        ? `/me/messages/${replyToMessageId}/replyAll`
        : `/me/messages/${replyToMessageId}/reply`;
      await graphCall(token.accessToken, endpoint, {
        method: "POST",
        body: JSON.stringify({
          comment: body,
        }),
      });

      // Get original message metadata to link the reply
      const original: any = await graphCall(
        token.accessToken,
        `/me/messages/${replyToMessageId}?$select=subject,conversationId,from,toRecipients`,
      );

      // Log activity
      await storage.createTaskActivity({
        taskId,
        type: "outlook_email_replied",
        actorUserId: user.id,
        payload: {
          subject: original.subject,
          conversationId: original.conversationId,
          replyAll: !!replyAll,
          bodyPreview: String(body).slice(0, 200),
        },
      }).catch(() => undefined);

      return res.json({ success: true });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Unlink an email ─────────────────────────────────────────────────────────
router.delete(
  "/tasks/:taskId/emails/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const ok = await storage.deleteTaskEmailLink(req.params.id);
      return res.json({ success: ok });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Browse inbox (for "Convert email to task" picker) ──────────────────────
router.get(
  "/browse/messages",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const token = await userOutlookToken(user.id);
      if (!token) {
        return res.status(403).json({ success: false, error: { code: "NOT_CONNECTED" } });
      }
      const { search } = req.query;
      const top = "25";
      let url = `${GRAPH_BASE}/me/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&$select=id,subject,bodyPreview,from,receivedDateTime,isRead,conversationId`;
      if (search) {
        url += `&$search="${encodeURIComponent(String(search))}"`;
      }
      const data: any = await graphCall(token.accessToken, url.replace(GRAPH_BASE, ""));
      return res.json({ success: true, data: data.value ?? [] });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

export default router;

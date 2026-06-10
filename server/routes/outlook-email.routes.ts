import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { requireIntegration } from '../middleware/requireIntegration';

const router = Router();
const outlookMailAuth = [requireAuth, requireIntegration('outlook_email')];

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ─── GET /messages — List messages (inbox) ──────────────────────────────────
router.get('/messages', ...outlookMailAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { top, skip, search, folder } = req.query;
    const limit = top || '25';
    const offset = skip || '0';
    const folderId = folder || 'inbox';

    let url = `${GRAPH_BASE}/me/mailFolders/${folderId}/messages?$top=${limit}&$skip=${offset}&$orderby=receivedDateTime desc&$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,isRead,hasAttachments,flag`;
    if (search) {
      url += `&$search="${encodeURIComponent(String(search))}"`;
    }

    const graphRes = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch messages' } });
    }
    const data = await graphRes.json() as any;
    return res.json({ success: true, data: { messages: data.value || [], totalCount: data['@odata.count'] } });
  } catch (err: any) {
    console.error('[Outlook Email] Error fetching messages:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

// ─── GET /messages/:messageId — Get full message ────────────────────────────
router.get('/messages/:messageId', ...outlookMailAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { messageId } = req.params;

    const graphRes = await fetch(`${GRAPH_BASE}/me/messages/${messageId}?$select=id,subject,body,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,attachments`, {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch message' } });
    }
    const data = await graphRes.json();
    return res.json({ success: true, data });
  } catch (err: any) {
    console.error('[Outlook Email] Error fetching message:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

// ─── POST /send — Send an email ─────────────────────────────────────────────
router.post('/send', ...outlookMailAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { to, cc, subject, body, bodyType } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'to, subject, and body are required' } });
    }

    const toRecipients = (Array.isArray(to) ? to : [to]).map((email: string) => ({
      emailAddress: { address: email },
    }));

    const message: any = {
      message: {
        subject,
        body: { contentType: bodyType || 'HTML', content: body },
        toRecipients,
      },
    };

    if (cc?.length) {
      message.message.ccRecipients = (Array.isArray(cc) ? cc : [cc]).map((email: string) => ({
        emailAddress: { address: email },
      }));
    }

    const graphRes = await fetch(`${GRAPH_BASE}/me/sendMail`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!graphRes.ok && graphRes.status !== 202) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to send email' } });
    }
    return res.json({ success: true, data: { sent: true } });
  } catch (err: any) {
    console.error('[Outlook Email] Error sending email:', err.message);
    return res.status(500).json({ success: false, error: { code: 'SEND_FAILED', message: err.message } });
  }
});

// ─── PATCH /messages/:messageId/read — Mark as read ─────────────────────────
router.patch('/messages/:messageId/read', ...outlookMailAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { messageId } = req.params;

    const graphRes = await fetch(`${GRAPH_BASE}/me/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to mark as read' } });
    }
    return res.json({ success: true, data: { marked: true } });
  } catch (err: any) {
    console.error('[Outlook Email] Error marking read:', err.message);
    return res.status(500).json({ success: false, error: { code: 'UPDATE_FAILED', message: err.message } });
  }
});

// ─── DELETE /messages/:messageId — Delete a message ─────────────────────────
router.delete('/messages/:messageId', ...outlookMailAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { messageId } = req.params;

    const graphRes = await fetch(`${GRAPH_BASE}/me/messages/${messageId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok && graphRes.status !== 204) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to delete message' } });
    }
    return res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    console.error('[Outlook Email] Error deleting message:', err.message);
    return res.status(500).json({ success: false, error: { code: 'DELETE_FAILED', message: err.message } });
  }
});

// ─── GET /folders — List mail folders ───────────────────────────────────────
router.get('/folders', ...outlookMailAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const graphRes = await fetch(`${GRAPH_BASE}/me/mailFolders?$top=50`, {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch folders' } });
    }
    const data = await graphRes.json() as any;
    return res.json({ success: true, data: data.value || [] });
  } catch (err: any) {
    console.error('[Outlook Email] Error fetching folders:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

export default router;

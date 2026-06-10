import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { requireIntegration } from '../middleware/requireIntegration';
import {
  listMessages,
  getMessage,
  sendEmail,
  listLabels,
  markAsRead,
  trashMessage,
  getThread,
} from '../services/gmailService';

const router = Router();

// All routes require auth + valid Gmail token
const gmailGuard = [requireAuth, requireIntegration('gmail' as any)];

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/gmail/messages
// Lists inbox messages with pagination.
// Query: ?pageSize=20&pageToken=xxx&q=search&labelIds=INBOX
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/messages', ...gmailGuard, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { pageSize, pageToken, q, labelIds } = req.query;

    const result = await listMessages(token.accessToken, {
      refreshToken: token.refreshToken,
      pageSize: pageSize ? parseInt(pageSize as string, 10) : 20,
      pageToken: pageToken as string | undefined,
      query: q as string | undefined,
      labelIds: labelIds ? (labelIds as string).split(',') : undefined,
    });

    return res.json({ success: true, data: result });
  } catch (err: any) {
    console.error('Gmail messages error:', err.message);
    return res.status(mapGmailError(err)).json({
      success: false,
      error: {
        code: 'GMAIL_API_ERROR',
        message: `Failed to list messages: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/gmail/messages/:id
// Gets a single email with full body.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/messages/:id', ...gmailGuard, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const token = req.integrationToken!;

    const message = await getMessage(token.accessToken, id, token.refreshToken);
    return res.json({ success: true, data: { message } });
  } catch (err: any) {
    console.error('Gmail get message error:', err.message);
    return res.status(mapGmailError(err)).json({
      success: false,
      error: {
        code: 'GMAIL_API_ERROR',
        message: `Failed to get message: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/gmail/send
// Sends an email.
// Body: { to, subject, body, cc?, bcc?, inReplyTo?, threadId? }
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/send', ...gmailGuard, async (req: Request, res: Response) => {
  try {
    const { to, subject, body, cc, bcc, inReplyTo, threadId } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'to, subject, and body are required', retryable: false },
      });
    }

    const token = req.integrationToken!;
    const message = await sendEmail(
      token.accessToken,
      { to, subject, body, cc, bcc, inReplyTo, threadId },
      token.refreshToken
    );

    return res.json({ success: true, data: { message } });
  } catch (err: any) {
    console.error('Gmail send error:', err.message);
    return res.status(mapGmailError(err)).json({
      success: false,
      error: {
        code: 'GMAIL_API_ERROR',
        message: `Failed to send email: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/gmail/labels
// Lists all Gmail labels.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/labels', ...gmailGuard, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const labels = await listLabels(token.accessToken, token.refreshToken);
    return res.json({ success: true, data: { labels } });
  } catch (err: any) {
    console.error('Gmail labels error:', err.message);
    return res.status(mapGmailError(err)).json({
      success: false,
      error: {
        code: 'GMAIL_API_ERROR',
        message: `Failed to list labels: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/gmail/messages/:id/read
// Marks a message as read.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/messages/:id/read', ...gmailGuard, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const token = req.integrationToken!;

    await markAsRead(token.accessToken, id, token.refreshToken);
    return res.json({ success: true, data: { markedAsRead: true } });
  } catch (err: any) {
    console.error('Gmail mark read error:', err.message);
    return res.status(mapGmailError(err)).json({
      success: false,
      error: {
        code: 'GMAIL_API_ERROR',
        message: `Failed to mark as read: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/gmail/messages/:id
// Trashes an email.
// ═══════════════════════════════════════════════════════════════════════════════
router.delete('/messages/:id', ...gmailGuard, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const token = req.integrationToken!;

    await trashMessage(token.accessToken, id, token.refreshToken);
    return res.json({ success: true, data: { trashed: true } });
  } catch (err: any) {
    console.error('Gmail trash error:', err.message);
    return res.status(mapGmailError(err)).json({
      success: false,
      error: {
        code: 'GMAIL_API_ERROR',
        message: `Failed to trash message: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/gmail/threads/:id
// Gets a full email thread.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/threads/:id', ...gmailGuard, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const token = req.integrationToken!;

    const thread = await getThread(token.accessToken, id, token.refreshToken);
    return res.json({ success: true, data: { thread } });
  } catch (err: any) {
    console.error('Gmail thread error:', err.message);
    return res.status(mapGmailError(err)).json({
      success: false,
      error: {
        code: 'GMAIL_API_ERROR',
        message: `Failed to get thread: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ─── Error Helpers ───────────────────────────────────────────────────────────
function mapGmailError(err: any): number {
  const code = err.code || err.status || err.response?.status;
  if (code === 401) return 401;
  if (code === 403) return 403;
  if (code === 404) return 404;
  if (code === 429) return 429;
  return 500;
}

function isRetryable(err: any): boolean {
  const code = err.code || err.status || err.response?.status;
  return code === 429 || code === 503 || code === 504;
}

export default router;

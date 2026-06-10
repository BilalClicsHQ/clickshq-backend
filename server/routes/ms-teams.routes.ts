import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { requireIntegration } from '../middleware/requireIntegration';

const router = Router();

// All routes require auth + MS Teams integration token
const msTeamsAuth = [requireAuth, requireIntegration('ms_teams')];

// ─── GET /teams — List user's teams ─────────────────────────────────────────
router.get('/teams', ...msTeamsAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me/joinedTeams', {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch teams' } });
    }
    const data = await graphRes.json() as any;
    return res.json({ success: true, data: data.value || [] });
  } catch (err: any) {
    console.error('[MS Teams] Error fetching teams:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

// ─── GET /teams/:teamId/channels — List channels in a team ──────────────────
router.get('/teams/:teamId/channels', ...msTeamsAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { teamId } = req.params;
    const graphRes = await fetch(`https://graph.microsoft.com/v1.0/teams/${teamId}/channels`, {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch channels' } });
    }
    const data = await graphRes.json() as any;
    return res.json({ success: true, data: data.value || [] });
  } catch (err: any) {
    console.error('[MS Teams] Error fetching channels:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

// ─── GET /chats — List user's chats ─────────────────────────────────────────
router.get('/chats', ...msTeamsAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me/chats?$top=50', {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch chats' } });
    }
    const data = await graphRes.json() as any;
    return res.json({ success: true, data: data.value || [] });
  } catch (err: any) {
    console.error('[MS Teams] Error fetching chats:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

// ─── POST /chats/:chatId/messages — Send message to chat ────────────────────
router.post('/chats/:chatId/messages', ...msTeamsAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { chatId } = req.params;
    const { content } = req.body;
    if (!content) return res.status(400).json({ success: false, error: { code: 'MISSING_CONTENT', message: 'Message content is required' } });

    const graphRes = await fetch(`https://graph.microsoft.com/v1.0/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: { content } }),
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to send message' } });
    }
    const data = await graphRes.json();
    return res.json({ success: true, data });
  } catch (err: any) {
    console.error('[MS Teams] Error sending message:', err.message);
    return res.status(500).json({ success: false, error: { code: 'SEND_FAILED', message: err.message } });
  }
});

export default router;

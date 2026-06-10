import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { getToken } from '../services/tokenService';

const router = Router();

// Helper to get cloudId from token metadata
function getCloudId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    return parsed.cloudId || null;
  } catch {
    return null;
  }
}

// Helper to make Jira API calls
async function jiraApi(token: string, cloudId: string, endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err.errorMessages?.[0] || err.message || `Jira API error: ${res.status}`);
  }
  return res.json() as Promise<any>;
}

// Helper to get user's Jira token and cloudId
async function getJiraContext(req: Request, res: Response): Promise<{ token: string; cloudId: string } | null> {
  const user = req.user as any;
  if (!user?.id) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    return null;
  }
  const tokenData = await getToken(user.id, 'jira');
  if (!tokenData) {
    res.status(403).json({ success: false, error: { code: 'NOT_CONNECTED', message: 'Jira is not connected. Please connect first.' } });
    return null;
  }
  const cloudId = getCloudId(tokenData.metadata ?? null);
  if (!cloudId) {
    res.status(500).json({ success: false, error: { code: 'NO_CLOUD_ID', message: 'No Jira cloud site found. Please reconnect.' } });
    return null;
  }
  return { token: tokenData.accessToken, cloudId };
}

// ─── Get current user info ─────────────────────────────────────────────────
router.get('/myself', requireAuth, async (req: Request, res: Response) => {
  try {
    const ctx = await getJiraContext(req, res);
    if (!ctx) return;
    const user = await jiraApi(ctx.token, ctx.cloudId, '/myself');
    return res.json({ success: true, data: user });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'JIRA_API_ERROR', message: err.message } });
  }
});

// ─── List projects ─────────────────────────────────────────────────────────
router.get('/projects', requireAuth, async (req: Request, res: Response) => {
  try {
    const ctx = await getJiraContext(req, res);
    if (!ctx) return;
    const data = await jiraApi(ctx.token, ctx.cloudId, '/project/search?maxResults=50&orderBy=name');
    return res.json({ success: true, data: data.values || [] });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'JIRA_API_ERROR', message: err.message } });
  }
});

// ─── Get project details ───────────────────────────────────────────────────
router.get('/projects/:projectKey', requireAuth, async (req: Request, res: Response) => {
  try {
    const ctx = await getJiraContext(req, res);
    if (!ctx) return;
    const data = await jiraApi(ctx.token, ctx.cloudId, `/project/${req.params.projectKey}`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'JIRA_API_ERROR', message: err.message } });
  }
});

// ─── Search issues (JQL) ───────────────────────────────────────────────────
router.get('/issues', requireAuth, async (req: Request, res: Response) => {
  try {
    const ctx = await getJiraContext(req, res);
    if (!ctx) return;
    const { jql, maxResults = '50', startAt = '0', fields } = req.query;
    const params = new URLSearchParams({
      jql: String(jql || 'ORDER BY updated DESC'),
      maxResults: String(maxResults),
      startAt: String(startAt),
    });
    if (fields) params.set('fields', String(fields));
    const data = await jiraApi(ctx.token, ctx.cloudId, `/search?${params.toString()}`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'JIRA_API_ERROR', message: err.message } });
  }
});

// ─── Get single issue ──────────────────────────────────────────────────────
router.get('/issues/:issueKey', requireAuth, async (req: Request, res: Response) => {
  try {
    const ctx = await getJiraContext(req, res);
    if (!ctx) return;
    const data = await jiraApi(ctx.token, ctx.cloudId, `/issue/${req.params.issueKey}`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'JIRA_API_ERROR', message: err.message } });
  }
});

// ─── Create issue ──────────────────────────────────────────────────────────
router.post('/issues', requireAuth, async (req: Request, res: Response) => {
  try {
    const ctx = await getJiraContext(req, res);
    if (!ctx) return;
    const data = await jiraApi(ctx.token, ctx.cloudId, '/issue', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'JIRA_API_ERROR', message: err.message } });
  }
});

// ─── Update issue ──────────────────────────────────────────────────────────
router.put('/issues/:issueKey', requireAuth, async (req: Request, res: Response) => {
  try {
    const ctx = await getJiraContext(req, res);
    if (!ctx) return;
    await jiraApi(ctx.token, ctx.cloudId, `/issue/${req.params.issueKey}`, {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
    return res.json({ success: true, data: { updated: true } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'JIRA_API_ERROR', message: err.message } });
  }
});

// ─── Transition issue (change status) ──────────────────────────────────────
router.post('/issues/:issueKey/transitions', requireAuth, async (req: Request, res: Response) => {
  try {
    const ctx = await getJiraContext(req, res);
    if (!ctx) return;

    // If no transitionId provided, list available transitions
    if (!req.body.transition) {
      const data = await jiraApi(ctx.token, ctx.cloudId, `/issue/${req.params.issueKey}/transitions`);
      return res.json({ success: true, data: data.transitions || [] });
    }

    await jiraApi(ctx.token, ctx.cloudId, `/issue/${req.params.issueKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: req.body.transition }),
    });
    return res.json({ success: true, data: { transitioned: true } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'JIRA_API_ERROR', message: err.message } });
  }
});

// ─── Get issue types for a project ─────────────────────────────────────────
router.get('/projects/:projectKey/issuetypes', requireAuth, async (req: Request, res: Response) => {
  try {
    const ctx = await getJiraContext(req, res);
    if (!ctx) return;
    const data = await jiraApi(ctx.token, ctx.cloudId, `/project/${req.params.projectKey}`);
    return res.json({ success: true, data: data.issueTypes || [] });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'JIRA_API_ERROR', message: err.message } });
  }
});

// ─── Get statuses for a project ────────────────────────────────────────────
router.get('/projects/:projectKey/statuses', requireAuth, async (req: Request, res: Response) => {
  try {
    const ctx = await getJiraContext(req, res);
    if (!ctx) return;
    const data = await jiraApi(ctx.token, ctx.cloudId, `/project/${req.params.projectKey}/statuses`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'JIRA_API_ERROR', message: err.message } });
  }
});

export default router;

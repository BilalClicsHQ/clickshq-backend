import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { getToken } from '../services/tokenService';

const router = Router();

// Helper to make GitHub API calls
async function githubApi(token: string, endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Nexus-App',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err.message || `GitHub API error: ${res.status}`);
  }
  return res.json();
}

// Helper to get user's GitHub token
async function getGitHubToken(req: Request, res: Response): Promise<string | null> {
  const user = req.user as any;
  if (!user?.id) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    return null;
  }
  const token = await getToken(user.id, 'github');
  if (!token) {
    res.status(403).json({ success: false, error: { code: 'NOT_CONNECTED', message: 'GitHub is not connected. Please connect first.' } });
    return null;
  }
  return token.accessToken;
}

// ─── Get authenticated user info ────────────────────────────────────────────
router.get('/user', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const user = await githubApi(token, '/user');
    return res.json({ success: true, data: user });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

// ─── List user's repositories ───────────────────────────────────────────────
router.get('/repos', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const page = req.query.page || '1';
    const per_page = req.query.per_page || '30';
    const sort = req.query.sort || 'updated';
    const repos = await githubApi(token, `/user/repos?page=${page}&per_page=${per_page}&sort=${sort}&affiliation=owner,collaborator,organization_member`);
    return res.json({ success: true, data: repos });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

// ─── Get a specific repository ──────────────────────────────────────────────
router.get('/repos/:owner/:repo', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const { owner, repo } = req.params;
    const data = await githubApi(token, `/repos/${owner}/${repo}`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

// ─── List branches ──────────────────────────────────────────────────────────
router.get('/repos/:owner/:repo/branches', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const { owner, repo } = req.params;
    const branches = await githubApi(token, `/repos/${owner}/${repo}/branches?per_page=100`);
    return res.json({ success: true, data: branches });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

// ─── Create a branch ────────────────────────────────────────────────────────
router.post('/repos/:owner/:repo/branches', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const { owner, repo } = req.params;
    const { branch_name, source_branch } = req.body;

    if (!branch_name) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'branch_name is required' } });

    // Get SHA of source branch (default: main)
    const sourceRef = await githubApi(token, `/repos/${owner}/${repo}/git/ref/heads/${source_branch || 'main'}`);
    const sha = (sourceRef as any).object.sha;

    // Create new branch
    const ref = await githubApi(token, `/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch_name}`, sha }),
    });

    return res.json({ success: true, data: ref });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

// ─── List pull requests ─────────────────────────────────────────────────────
router.get('/repos/:owner/:repo/pulls', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const { owner, repo } = req.params;
    const state = req.query.state || 'open';
    const page = req.query.page || '1';
    const pulls = await githubApi(token, `/repos/${owner}/${repo}/pulls?state=${state}&page=${page}&per_page=30`);
    return res.json({ success: true, data: pulls });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

// ─── Create a pull request ──────────────────────────────────────────────────
router.post('/repos/:owner/:repo/pulls', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const { owner, repo } = req.params;
    const { title, head, base, body } = req.body;

    if (!title || !head || !base) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'title, head, and base are required' } });

    const pr = await githubApi(token, `/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, head, base, body: body || '' }),
    });

    return res.json({ success: true, data: pr });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

// ─── List issues ────────────────────────────────────────────────────────────
router.get('/repos/:owner/:repo/issues', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const { owner, repo } = req.params;
    const state = req.query.state || 'open';
    const page = req.query.page || '1';
    const issues = await githubApi(token, `/repos/${owner}/${repo}/issues?state=${state}&page=${page}&per_page=30`);
    return res.json({ success: true, data: issues });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

// ─── Create an issue ────────────────────────────────────────────────────────
router.post('/repos/:owner/:repo/issues', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const { owner, repo } = req.params;
    const { title, body, labels, assignees } = req.body;

    if (!title) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'title is required' } });

    const issue = await githubApi(token, `/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: body || '', labels: labels || [], assignees: assignees || [] }),
    });

    return res.json({ success: true, data: issue });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

// ─── List commits ───────────────────────────────────────────────────────────
router.get('/repos/:owner/:repo/commits', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const { owner, repo } = req.params;
    const sha = req.query.sha || 'main';
    const page = req.query.page || '1';
    const commits = await githubApi(token, `/repos/${owner}/${repo}/commits?sha=${sha}&page=${page}&per_page=30`);
    return res.json({ success: true, data: commits });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

// ─── List organizations ─────────────────────────────────────────────────────
router.get('/orgs', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req, res);
    if (!token) return;
    const orgs = await githubApi(token, '/user/orgs');
    return res.json({ success: true, data: orgs });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'GITHUB_API_ERROR', message: err.message } });
  }
});

export default router;

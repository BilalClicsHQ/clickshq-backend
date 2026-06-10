import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { getToken } from '../services/tokenService';

const router = Router();

// Helper to make Figma API calls
async function figmaApi(token: string, endpoint: string) {
  const res = await fetch(`https://api.figma.com/v1${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err.message || `Figma API error: ${res.status}`);
  }
  return res.json();
}

// Helper to get user's Figma token
async function getFigmaToken(req: Request, res: Response): Promise<string | null> {
  const user = req.user as any;
  if (!user?.id) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    return null;
  }
  const token = await getToken(user.id, 'figma');
  if (!token) {
    res.status(403).json({ success: false, error: { code: 'NOT_CONNECTED', message: 'Figma is not connected. Please connect first.' } });
    return null;
  }
  return token.accessToken;
}

// ─── Get authenticated user info ────────────────────────────────────────────
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getFigmaToken(req, res);
    if (!token) return;
    const user = await figmaApi(token, '/me');
    return res.json({ success: true, data: user });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'FIGMA_API_ERROR', message: err.message } });
  }
});

// ─── Get a file ─────────────────────────────────────────────────────────────
router.get('/files/:fileKey', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getFigmaToken(req, res);
    if (!token) return;
    const { fileKey } = req.params;
    const data = await figmaApi(token, `/files/${fileKey}`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'FIGMA_API_ERROR', message: err.message } });
  }
});

// ─── Get file thumbnails / images ───────────────────────────────────────────
router.get('/files/:fileKey/images', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getFigmaToken(req, res);
    if (!token) return;
    const { fileKey } = req.params;
    const ids = req.query.ids || '';
    const data = await figmaApi(token, `/images/${fileKey}?ids=${ids}&format=png`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'FIGMA_API_ERROR', message: err.message } });
  }
});

// ─── Get file comments ──────────────────────────────────────────────────────
router.get('/files/:fileKey/comments', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getFigmaToken(req, res);
    if (!token) return;
    const { fileKey } = req.params;
    const data = await figmaApi(token, `/files/${fileKey}/comments`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'FIGMA_API_ERROR', message: err.message } });
  }
});

// ─── Get team projects ──────────────────────────────────────────────────────
router.get('/teams/:teamId/projects', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getFigmaToken(req, res);
    if (!token) return;
    const { teamId } = req.params;
    const data = await figmaApi(token, `/teams/${teamId}/projects`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'FIGMA_API_ERROR', message: err.message } });
  }
});

// ─── Get project files ──────────────────────────────────────────────────────
router.get('/projects/:projectId/files', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getFigmaToken(req, res);
    if (!token) return;
    const { projectId } = req.params;
    const data = await figmaApi(token, `/projects/${projectId}/files`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'FIGMA_API_ERROR', message: err.message } });
  }
});

// ─── Get file versions ──────────────────────────────────────────────────────
router.get('/files/:fileKey/versions', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getFigmaToken(req, res);
    if (!token) return;
    const { fileKey } = req.params;
    const data = await figmaApi(token, `/files/${fileKey}/versions`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'FIGMA_API_ERROR', message: err.message } });
  }
});

// ─── Get file components ────────────────────────────────────────────────────
router.get('/files/:fileKey/components', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getFigmaToken(req, res);
    if (!token) return;
    const { fileKey } = req.params;
    const data = await figmaApi(token, `/files/${fileKey}/components`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'FIGMA_API_ERROR', message: err.message } });
  }
});

export default router;

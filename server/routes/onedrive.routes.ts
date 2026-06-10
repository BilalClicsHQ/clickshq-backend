import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { requireIntegration } from '../middleware/requireIntegration';

const router = Router();
const onedriveAuth = [requireAuth, requireIntegration('onedrive')];

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ─── GET /files — List files in root or folder ──────────────────────────────
router.get('/files', ...onedriveAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const folderId = req.query.folderId as string | undefined;
    const top = req.query.top || '50';

    const path = folderId
      ? `${GRAPH_BASE}/me/drive/items/${folderId}/children?$top=${top}&$orderby=lastModifiedDateTime desc`
      : `${GRAPH_BASE}/me/drive/root/children?$top=${top}&$orderby=lastModifiedDateTime desc`;

    const graphRes = await fetch(path, {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch files' } });
    }
    const data = await graphRes.json() as any;
    return res.json({ success: true, data: data.value || [] });
  } catch (err: any) {
    console.error('[OneDrive] Error fetching files:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

// ─── GET /files/:fileId — Get file metadata ─────────────────────────────────
router.get('/files/:fileId', ...onedriveAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { fileId } = req.params;

    const graphRes = await fetch(`${GRAPH_BASE}/me/drive/items/${fileId}`, {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch file' } });
    }
    const data = await graphRes.json();
    return res.json({ success: true, data });
  } catch (err: any) {
    console.error('[OneDrive] Error fetching file:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

// ─── GET /search — Search files ─────────────────────────────────────────────
router.get('/search', ...onedriveAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const query = req.query.q as string;
    if (!query) return res.status(400).json({ success: false, error: { code: 'MISSING_QUERY', message: 'Search query (q) is required' } });

    const graphRes = await fetch(`${GRAPH_BASE}/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=25`, {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Search failed' } });
    }
    const data = await graphRes.json() as any;
    return res.json({ success: true, data: data.value || [] });
  } catch (err: any) {
    console.error('[OneDrive] Error searching files:', err.message);
    return res.status(500).json({ success: false, error: { code: 'SEARCH_FAILED', message: err.message } });
  }
});

// ─── POST /folders — Create a folder ────────────────────────────────────────
router.post('/folders', ...onedriveAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { name, parentId } = req.body;
    if (!name) return res.status(400).json({ success: false, error: { code: 'MISSING_NAME', message: 'Folder name is required' } });

    const path = parentId
      ? `${GRAPH_BASE}/me/drive/items/${parentId}/children`
      : `${GRAPH_BASE}/me/drive/root/children`;

    const graphRes = await fetch(path, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to create folder' } });
    }
    const data = await graphRes.json();
    return res.status(201).json({ success: true, data });
  } catch (err: any) {
    console.error('[OneDrive] Error creating folder:', err.message);
    return res.status(500).json({ success: false, error: { code: 'CREATE_FAILED', message: err.message } });
  }
});

// ─── DELETE /files/:fileId — Delete a file or folder ────────────────────────
router.delete('/files/:fileId', ...onedriveAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { fileId } = req.params;

    const graphRes = await fetch(`${GRAPH_BASE}/me/drive/items/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok && graphRes.status !== 204) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to delete' } });
    }
    return res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    console.error('[OneDrive] Error deleting file:', err.message);
    return res.status(500).json({ success: false, error: { code: 'DELETE_FAILED', message: err.message } });
  }
});

// ─── GET /quota — Get drive storage quota ───────────────────────────────────
router.get('/quota', ...onedriveAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const graphRes = await fetch(`${GRAPH_BASE}/me/drive`, {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch quota' } });
    }
    const data = await graphRes.json() as any;
    return res.json({ success: true, data: data.quota || {} });
  } catch (err: any) {
    console.error('[OneDrive] Error fetching quota:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

export default router;

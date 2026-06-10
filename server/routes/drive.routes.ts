import { Router, Request, Response } from 'express';
import multer from 'multer';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../auth';
import { requireIntegration } from '../middleware/requireIntegration';
import { db } from '../db';
import { taskDriveAttachments } from '../../shared/schema';
import {
  listFiles,
  uploadFile,
  createFolder,
  shareFile,
  getFilePreview,
  trashFile,
} from '../services/driveService';

const router = Router();

// Multer for file uploads — 10MB limit, memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// All routes require auth + valid Google Drive token
const driveGuard = [requireAuth, requireIntegration('google_drive')];

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/drive/files
// Lists user's Drive files. Supports folder browsing, search, and pagination.
// Query: ?folderId=xxx&q=search&pageSize=25&pageToken=xxx
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/files', ...driveGuard, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { folderId, q, pageSize, pageToken } = req.query;

    const result = await listFiles(token.accessToken, {
      refreshToken: token.refreshToken,
      folderId: folderId as string | undefined,
      query: q as string | undefined,
      pageSize: pageSize ? parseInt(pageSize as string, 10) : 25,
      pageToken: pageToken as string | undefined,
    });

    return res.json({ success: true, data: result });
  } catch (err: any) {
    console.error('Drive files error:', err.message);
    return res.status(mapDriveError(err)).json({
      success: false,
      error: {
        code: 'DRIVE_API_ERROR',
        message: `Failed to list files: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/drive/upload
// Uploads a file to the user's Drive.
// Multipart form: file (required), folderId (optional)
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/upload', ...driveGuard, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'No file provided', retryable: false },
      });
    }

    const token = req.integrationToken!;
    const { folderId } = req.body;

    const driveFile = await uploadFile(
      token.accessToken,
      {
        name: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        folderId: folderId || undefined,
      },
      token.refreshToken
    );

    return res.json({ success: true, data: { file: driveFile } });
  } catch (err: any) {
    console.error('Drive upload error:', err.message);
    return res.status(mapDriveError(err)).json({
      success: false,
      error: {
        code: 'DRIVE_API_ERROR',
        message: `Failed to upload file: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/drive/folder
// Creates a project folder in Drive.
// Body: { name, parentFolderId? }
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/folder', ...driveGuard, async (req: Request, res: Response) => {
  try {
    const { name, parentFolderId } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Folder name is required', retryable: false },
      });
    }

    const token = req.integrationToken!;
    const folder = await createFolder(
      token.accessToken,
      name,
      parentFolderId || undefined,
      token.refreshToken
    );

    return res.json({ success: true, data: { folder } });
  } catch (err: any) {
    console.error('Drive folder error:', err.message);
    return res.status(mapDriveError(err)).json({
      success: false,
      error: {
        code: 'DRIVE_API_ERROR',
        message: `Failed to create folder: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/drive/task/:taskId/attachments
// Returns all Drive files attached to a specific task.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/task/:taskId/attachments', requireAuth, async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    const attachments = await db
      .select()
      .from(taskDriveAttachments)
      .where(eq(taskDriveAttachments.taskId, taskId))
      .orderBy(taskDriveAttachments.attachedAt);

    return res.json({ success: true, data: { attachments } });
  } catch (err: any) {
    console.error('Drive task attachments error:', err.message);
    return res.status(500).json({
      success: false,
      error: { code: 'FETCH_FAILED', message: `Failed to get attachments: ${err.message}`, retryable: true },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/drive/share
// Shares a Drive file with another user.
// Body: { fileId, email, role? }
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/share', ...driveGuard, async (req: Request, res: Response) => {
  try {
    const { fileId, email, role } = req.body;

    if (!fileId || !email) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'fileId and email are required', retryable: false },
      });
    }

    const token = req.integrationToken!;
    const result = await shareFile(
      token.accessToken,
      fileId,
      email,
      role || 'reader',
      token.refreshToken
    );

    return res.json({ success: true, data: result });
  } catch (err: any) {
    console.error('Drive share error:', err.message);
    return res.status(mapDriveError(err)).json({
      success: false,
      error: {
        code: 'DRIVE_API_ERROR',
        message: `Failed to share file: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/drive/preview/:fileId
// Returns webViewLink for embedding Drive preview in PMO.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/preview/:fileId', ...driveGuard, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const token = req.integrationToken!;

    const preview = await getFilePreview(token.accessToken, fileId, token.refreshToken);

    return res.json({ success: true, data: preview });
  } catch (err: any) {
    console.error('Drive preview error:', err.message);
    return res.status(mapDriveError(err)).json({
      success: false,
      error: {
        code: 'DRIVE_API_ERROR',
        message: `Failed to get preview: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/drive/attach
// Attaches a Google Drive file to a task.
// Body: { taskId, fileId, fileName, fileUrl, mimeType }
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/attach', ...driveGuard, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { taskId, fileId, fileName, mimeType, fileUrl } = req.body;

    if (!taskId || !fileId || !fileName) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'taskId, fileId, and fileName are required', retryable: false },
      });
    }

    // Get file metadata from Drive for webViewLink, iconLink, thumbnailLink
    const token = req.integrationToken!;
    let webViewLink = fileUrl || null;
    let iconLink: string | null = null;
    let thumbnailLink: string | null = null;

    try {
      const preview = await getFilePreview(token.accessToken, fileId, token.refreshToken);
      webViewLink = preview.webViewLink || webViewLink;
      thumbnailLink = preview.thumbnailLink || null;
    } catch {
      // Non-fatal — we can still save with the data we have
    }

    const [attachment] = await db.insert(taskDriveAttachments).values({
      taskId,
      userId: user.id,
      fileId,
      fileName,
      mimeType: mimeType || null,
      webViewLink,
      iconLink,
      thumbnailLink,
    }).returning();

    return res.json({ success: true, data: { attachment } });
  } catch (err: any) {
    console.error('Drive attach error:', err.message);
    return res.status(500).json({
      success: false,
      error: { code: 'ATTACH_FAILED', message: `Failed to attach file: ${err.message}`, retryable: true },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/drive/attach/:id
// Removes a Drive attachment from a task.
// ═══════════════════════════════════════════════════════════════════════════════
router.delete('/attach/:id', ...driveGuard, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { id } = req.params;

    const [deleted] = await db.delete(taskDriveAttachments)
      .where(and(
        eq(taskDriveAttachments.id, id),
        eq(taskDriveAttachments.userId, user.id)
      ))
      .returning();

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Attachment not found or not owned by you', retryable: false },
      });
    }

    return res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    console.error('Drive detach error:', err.message);
    return res.status(500).json({
      success: false,
      error: { code: 'DETACH_FAILED', message: `Failed to remove attachment: ${err.message}`, retryable: true },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/drive/search
// Searches user's Drive files by name (drive.file scope — only app-created files).
// Query: ?q=:query&pageSize=25&pageToken=xxx
// Minimum 2 characters required for search query.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/search', ...driveGuard, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { q, pageSize, pageToken } = req.query;

    if (!q || String(q).trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Search query must be at least 2 characters', retryable: false },
      });
    }

    const result = await listFiles(token.accessToken, {
      refreshToken: token.refreshToken,
      query: String(q).trim(),
      pageSize: pageSize ? parseInt(pageSize as string, 10) : 25,
      pageToken: pageToken as string | undefined,
    });

    return res.json({ success: true, data: result });
  } catch (err: any) {
    console.error('Drive search error:', err.message);
    return res.status(mapDriveError(err)).json({
      success: false,
      error: {
        code: 'DRIVE_API_ERROR',
        message: `Failed to search files: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/drive/files/:fileId
// Moves a file to trash (reversible).
// ═══════════════════════════════════════════════════════════════════════════════
router.delete('/files/:fileId', ...driveGuard, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const token = req.integrationToken!;

    await trashFile(token.accessToken, fileId, token.refreshToken);

    return res.json({ success: true, data: { trashed: true } });
  } catch (err: any) {
    console.error('Drive delete error:', err.message);
    return res.status(mapDriveError(err)).json({
      success: false,
      error: {
        code: 'DRIVE_API_ERROR',
        message: `Failed to trash file: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ─── Error Helpers ───────────────────────────────────────────────────────────
function mapDriveError(err: any): number {
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

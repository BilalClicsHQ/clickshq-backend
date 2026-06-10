/**
 * File Attachments — unified API for Drive / OneDrive / Dropbox.
 *
 * Mounted at /api/integrations/files.
 *
 *   GET    /tasks/:taskId/attachments
 *   POST   /tasks/:taskId/attachments               – Attach a file from any provider
 *   DELETE /tasks/:taskId/attachments/:id           – Remove
 *
 *   GET    /providers/google_drive/browse?folderId=&q=
 *   GET    /providers/onedrive/browse?folderId=&q=
 *   GET    /providers/dropbox/browse?path=&q=
 *
 *   POST   /tasks/:taskId/import-google-doc         – Drive Doc → clicsHQ Doc (creates doc + attaches)
 */
import { Router, Request, Response } from "express";
import multer from "multer";
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { getToken, getValidToken } from "../services/tokenService";

// In-memory upload for serverless compatibility; max 25 MB per file
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});
import {
  listFiles as listDriveFiles,
  getDriveFileMetadata,
  exportGoogleDocAsHtml,
} from "../services/driveService";
import {
  listOneDriveFiles,
  getOneDriveFileMetadata,
  createOneDriveEmbedLink,
} from "../services/oneDriveService";
import {
  listDropboxFiles,
  searchDropbox,
  getDropboxFileMetadata,
} from "../services/dropboxService";

const router = Router();

type Provider = "google_drive" | "onedrive" | "dropbox";

async function getProviderToken(userId: string, provider: Provider) {
  // getValidToken auto-refreshes if the access token has expired.
  // Falls back to getToken for Dropbox (which doesn't auto-refresh — long-lived tokens).
  try {
    return await getValidToken(userId, provider);
  } catch {
    const t = await getToken(userId, provider);
    return t ?? null;
  }
}

// ── List attachments on a task ──────────────────────────────────────────────

router.get(
  "/tasks/:taskId/attachments",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { taskId } = req.params;
      const data = await storage.getTaskFileAttachments(taskId);
      return res.json({ success: true, data });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Attach a file (any provider) ────────────────────────────────────────────

router.post(
  "/tasks/:taskId/attachments",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const { provider, externalId } = req.body as { provider: Provider; externalId: string };

      if (!provider || !externalId) {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_FIELDS", message: "provider and externalId required" } });
      }
      if (!["google_drive", "onedrive", "dropbox"].includes(provider)) {
        return res
          .status(400)
          .json({ success: false, error: { code: "INVALID_PROVIDER" } });
      }

      // Dedupe
      const existing = await storage.findFileAttachment(taskId, provider, externalId);
      if (existing) {
        return res.json({ success: true, data: existing, deduped: true });
      }

      // Fetch metadata from provider
      const token = await getProviderToken(user.id, provider);
      if (!token) {
        return res
          .status(403)
          .json({ success: false, error: { code: "NOT_CONNECTED", message: `Connect ${provider} first` } });
      }

      let meta: any;
      if (provider === "google_drive") {
        meta = await getDriveFileMetadata(token.accessToken, externalId, token.refreshToken);
      } else if (provider === "onedrive") {
        meta = await getOneDriveFileMetadata(token.accessToken, externalId);
        if (!meta.embedUrl) {
          meta.embedUrl = await createOneDriveEmbedLink(token.accessToken, externalId);
        }
      } else {
        meta = await getDropboxFileMetadata(token.accessToken, externalId);
      }

      const created = await storage.createFileAttachment({
        taskId,
        provider,
        externalId,
        name: meta.name,
        mimeType: meta.mimeType,
        size: meta.size,
        externalUrl: meta.externalUrl,
        downloadUrl: meta.downloadUrl,
        embedUrl: meta.embedUrl,
        thumbnailUrl: meta.thumbnailUrl,
        iconUrl: meta.iconUrl,
        ownerName: meta.ownerName,
        modifiedAt: meta.modifiedAt,
        attachedBy: user.id,
        metadata: meta.metadata ?? null,
      });

      // Render as a comment card with the file attached (ClickUp-style)
      await storage.createTaskActivity({
        taskId,
        type: "task_comment",
        actorUserId: user.id,
        payload: {
          text: "",
          attachment: {
            attachmentId: created.id,
            provider,
            name: meta.name,
            size: meta.size ?? null,
            mimeType: meta.mimeType ?? null,
            url: meta.externalUrl ?? null,
            externalId,
          },
        },
      }).catch(() => undefined);

      return res.json({ success: true, data: created });
    } catch (err: any) {
      console.error("[File attach] error:", err);
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Delete attachment ───────────────────────────────────────────────────────

router.delete(
  "/tasks/:taskId/attachments/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const ok = await storage.deleteFileAttachment(id);
      return res.json({ success: ok });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Browse: Google Drive ────────────────────────────────────────────────────

router.get(
  "/providers/google_drive/browse",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const t = await getProviderToken(user.id, "google_drive");
      if (!t) return res.status(403).json({ success: false, error: { code: "NOT_CONNECTED" } });

      const { folderId, q, mimeType } = req.query;
      const result = await listDriveFiles(t.accessToken, {
        refreshToken: t.refreshToken,
        folderId: folderId as string | undefined,
        query: q as string | undefined,
        mimeType: mimeType as string | undefined,
        pageSize: 30,
      });
      return res.json({ success: true, data: result });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Browse: OneDrive ────────────────────────────────────────────────────────

router.get(
  "/providers/onedrive/browse",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const t = await getProviderToken(user.id, "onedrive");
      if (!t) return res.status(403).json({ success: false, error: { code: "NOT_CONNECTED" } });

      const { folderId, q } = req.query;
      const files = await listOneDriveFiles(t.accessToken, {
        folderId: folderId as string | undefined,
        search: q as string | undefined,
        top: 30,
      });
      return res.json({ success: true, data: { files } });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Browse: Dropbox ─────────────────────────────────────────────────────────

router.get(
  "/providers/dropbox/browse",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const t = await getProviderToken(user.id, "dropbox");
      if (!t) return res.status(403).json({ success: false, error: { code: "NOT_CONNECTED" } });

      const { path, q } = req.query;
      console.log(`[Dropbox] browse called — userId=${user.id} path="${path ?? ""}" q="${q ?? ""}" tokenLen=${t.accessToken?.length}`);

      let entries: any[];
      try {
        if (q) {
          entries = await searchDropbox(t.accessToken, String(q), 30);
        } else {
          entries = await listDropboxFiles(t.accessToken, {
            path: (path as string) || "",
            limit: 50,
          });
        }
        console.log(`[Dropbox] returned ${entries.length} entries`);
      } catch (apiErr: any) {
        console.error(`[Dropbox] API error:`, apiErr?.message, apiErr?.response);
        // Surface Dropbox-specific error to frontend instead of swallowing
        return res.status(500).json({
          success: false,
          error: {
            code: "DROPBOX_API_ERROR",
            message: apiErr?.message ?? "Dropbox API call failed",
          },
        });
      }

      return res.json({ success: true, data: { entries } });
    } catch (err: any) {
      console.error(`[Dropbox] route error:`, err?.message);
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Direct file upload (multipart/form-data → memory → DB record) ──────────
// NOTE: Files are stored as base64 data URLs in metadata for small files.
// For production, hook this into GCS/S3 via objectStorageClient.
router.post(
  "/tasks/:taskId/upload",
  requireAuth,
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        return res
          .status(400)
          .json({ success: false, error: { code: "NO_FILE" } });
      }

      const sizeMB = file.size / (1024 * 1024);
      const dataUrl =
        sizeMB <= 2
          ? `data:${file.mimetype};base64,${file.buffer.toString("base64")}`
          : null;

      const attachment = await storage.createFileAttachment({
        taskId,
        provider: "upload",
        externalId: `local-${Date.now()}`,
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        externalUrl: dataUrl,
        downloadUrl: dataUrl,
        embedUrl: dataUrl,
        thumbnailUrl: file.mimetype.startsWith("image/") ? dataUrl : null,
        iconUrl: null,
        ownerName: null,
        modifiedAt: new Date(),
        attachedBy: user.id,
        metadata: {
          uploadedDirectly: true,
          tooLargeForInline: dataUrl === null,
        },
      });

      // Render as a comment card with the file attached (ClickUp-style)
      await storage
        .createTaskActivity({
          taskId,
          type: "task_comment",
          actorUserId: user.id,
          payload: {
            text: "",
            attachment: {
              attachmentId: attachment.id,
              name: file.originalname,
              size: file.size,
              mimeType: file.mimetype,
              url: dataUrl ?? null,
            },
          },
        })
        .catch(() => undefined);

      return res.json({ success: true, data: { attachment } });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Import Google Doc as clicsHQ Doc ────────────────────────────────────────

router.post(
  "/tasks/:taskId/import-google-doc",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const { fileId } = req.body;
      if (!fileId) return res.status(400).json({ success: false, error: { code: "MISSING_FILE_ID" } });

      const t = await getProviderToken(user.id, "google_drive");
      if (!t) return res.status(403).json({ success: false, error: { code: "NOT_CONNECTED" } });

      const meta = await getDriveFileMetadata(t.accessToken, fileId, t.refreshToken);
      const html = await exportGoogleDocAsHtml(t.accessToken, fileId, t.refreshToken);

      // Attach the source file as a regular attachment too
      const attachment = await storage.createFileAttachment({
        taskId,
        provider: "google_drive",
        externalId: fileId,
        name: meta.name,
        mimeType: meta.mimeType,
        size: meta.size,
        externalUrl: meta.externalUrl,
        downloadUrl: meta.downloadUrl,
        embedUrl: meta.embedUrl,
        thumbnailUrl: meta.thumbnailUrl,
        iconUrl: meta.iconUrl,
        ownerName: meta.ownerName,
        modifiedAt: meta.modifiedAt,
        attachedBy: user.id,
        metadata: { imported: true, source: "google_doc" },
      });

      await storage.createTaskActivity({
        taskId,
        type: "google_drive_doc_imported",
        actorUserId: user.id,
        payload: { fileId, name: meta.name, externalUrl: meta.externalUrl },
      }).catch(() => undefined);

      return res.json({
        success: true,
        data: { attachment, html, name: meta.name },
      });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

export default router;

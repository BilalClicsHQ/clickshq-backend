/**
 * Figma Integration routes — task-level operations.
 *
 * Mounted at /api/integrations/figma.
 *
 *   GET    /tasks/:taskId/links              – List Figma links on a task
 *   POST   /tasks/:taskId/links              – Embed a Figma URL (file or frame)
 *   DELETE /tasks/:taskId/links/:linkId      – Unlink
 *   GET    /preview?url=                     – Resolve metadata for a URL (used by paste preview)
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { getToken, getValidToken } from "../services/tokenService";
import {
  getFigmaFile,
  renderFigmaNode,
  parseFigmaUrl,
  buildFigmaEmbedUrl,
  buildFigmaFileUrl,
} from "../services/figmaService";

const router = Router();

async function userToken(userId: string) {
  try {
    return await getValidToken(userId, "figma");
  } catch {
    return await getToken(userId, "figma");
  }
}

// ── List Figma links on a task ──────────────────────────────────────────────
router.get(
  "/tasks/:taskId/links",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { taskId } = req.params;
      const links = await storage.getTaskFigmaLinks(taskId);
      return res.json({ success: true, data: links });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Preview a Figma URL (for paste detection) ───────────────────────────────
// IMPORTANT: never 500 here. Preview is best-effort metadata enrichment.
// Always return parsed info; enrich only if Figma token is present AND API succeeds.
router.get(
  "/preview",
  requireAuth,
  async (req: Request, res: Response) => {
    const user = req.user as any;
    const url = String(req.query.url ?? "");
    const parsed = parseFigmaUrl(url);
    if (!parsed) {
      return res.status(400).json({ success: false, error: { code: "INVALID_URL" } });
    }

    // Build the always-available fallback payload first
    const fallback = {
      fileKey: parsed.fileKey,
      nodeId: parsed.nodeId,
      name: parsed.fileName ?? "Figma design",
      embedUrl: buildFigmaEmbedUrl(parsed.fileKey, parsed.nodeId),
      fileUrl: url,
      thumbnailUrl: null as string | null,
      lastModified: null as string | null,
      connected: false,
    };

    // Try to enrich with token if available — but never throw
    let token: any = null;
    try {
      token = await userToken(user.id);
    } catch {
      // ignore — fallback works
    }

    if (!token) {
      return res.json({ success: true, data: fallback });
    }

    try {
      const file = await getFigmaFile(token.accessToken, parsed.fileKey);
      let thumbnailUrl: string | null = file.thumbnailUrl ?? null;

      if (parsed.nodeId) {
        try {
          const rendered = await renderFigmaNode(
            token.accessToken,
            parsed.fileKey,
            parsed.nodeId,
            "png",
            2,
          );
          if (rendered) thumbnailUrl = rendered;
        } catch {
          // node render is optional
        }
      }

      return res.json({
        success: true,
        data: {
          ...fallback,
          name: file.name || fallback.name,
          fileUrl: buildFigmaFileUrl(parsed.fileKey, parsed.nodeId, file.name),
          thumbnailUrl,
          lastModified: file.lastModified ?? null,
          connected: true,
        },
      });
    } catch {
      // Token exists but file fetch failed (private file, wrong scope, expired) — show fallback
      return res.json({ success: true, data: fallback });
    }
  },
);

// ── Embed a Figma URL to a task ─────────────────────────────────────────────
router.post(
  "/tasks/:taskId/links",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const { url } = req.body;
      if (!url) {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_URL" } });
      }

      const parsed = parseFigmaUrl(url);
      if (!parsed) {
        return res
          .status(400)
          .json({ success: false, error: { code: "INVALID_URL", message: "Not a valid Figma URL" } });
      }

      // Dedupe
      const existing = await storage.findTaskFigmaLink(taskId, parsed.fileKey, parsed.nodeId);
      if (existing) {
        return res.json({ success: true, data: existing, deduped: true });
      }

      // Try to fetch metadata if connected (best-effort)
      const token = await userToken(user.id);
      let name = parsed.fileName ?? "Figma file";
      let thumbnailUrl: string | null = null;
      let lastModified: Date | null = null;
      if (token) {
        try {
          const file = await getFigmaFile(token.accessToken, parsed.fileKey);
          name = file.name || name;
          thumbnailUrl = file.thumbnailUrl ?? null;
          lastModified = file.lastModified ? new Date(file.lastModified) : null;
          if (parsed.nodeId) {
            const rendered = await renderFigmaNode(
              token.accessToken,
              parsed.fileKey,
              parsed.nodeId,
              "png",
              2,
            );
            if (rendered) thumbnailUrl = rendered;
          }
        } catch {
          // Continue without metadata — link still saves
        }
      }

      const created = await storage.createTaskFigmaLink({
        taskId,
        fileKey: parsed.fileKey,
        nodeId: parsed.nodeId,
        name,
        fileUrl: buildFigmaFileUrl(parsed.fileKey, parsed.nodeId, name),
        embedUrl: buildFigmaEmbedUrl(parsed.fileKey, parsed.nodeId),
        thumbnailUrl,
        lastModified,
        linkedBy: user.id,
        metadata: { originalUrl: url },
      });

      await storage.createTaskActivity({
        taskId,
        type: "figma_design_linked",
        actorUserId: user.id,
        payload: { name, fileUrl: created.fileUrl, fileKey: parsed.fileKey, nodeId: parsed.nodeId },
      }).catch(() => undefined);

      return res.json({ success: true, data: created });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Unlink ──────────────────────────────────────────────────────────────────
router.delete(
  "/tasks/:taskId/links/:linkId",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { linkId } = req.params;
      const ok = await storage.deleteTaskFigmaLink(linkId);
      return res.json({ success: ok });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

export default router;

import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import { versionStorage } from "../../storage/versionStorage";

/**
 * GET /api/docs/:id/versions
 * List versions for a document (paginated)
 */
export async function getDocVersionsHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;

    const doc = await storage.getDocument(docId);
    if (!doc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    // User must be owner or have share access
    const isOwner = doc.ownerId === userId;
    if (!isOwner) {
      const share = await storage.getShareInDocumentTree(docId, userId);
      if (!share) {
        res.status(403).json({ message: "Access denied" });
        return;
      }
    }

    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await versionStorage.getDocumentVersions(docId, limit, offset);
    res.json(result);
  } catch (error) {
    console.error("Error fetching versions:", error);
    res.status(500).json({ message: "Failed to fetch versions" });
  }
}

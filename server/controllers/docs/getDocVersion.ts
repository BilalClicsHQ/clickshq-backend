import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import { versionStorage } from "../../storage/versionStorage";

/**
 * GET /api/docs/:id/versions/:versionId
 * Get a specific version's full content
 */
export async function getDocVersionHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;

    const doc = await storage.getDocument(docId);
    if (!doc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    const isOwner = doc.ownerId === userId;
    if (!isOwner) {
      const share = await storage.getShareInDocumentTree(docId, userId);
      if (!share) {
        res.status(403).json({ message: "Access denied" });
        return;
      }
    }

    const version = await versionStorage.getDocumentVersion(req.params.versionId);
    if (!version || version.documentId !== docId) {
      res.status(404).json({ message: "Version not found" });
      return;
    }

    res.json(version);
  } catch (error) {
    console.error("Error fetching version:", error);
    res.status(500).json({ message: "Failed to fetch version" });
  }
}

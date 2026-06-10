import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import { versionStorage } from "../../storage/versionStorage";
import { createManualVersion } from "./versionHelper";

/**
 * POST /api/docs/:id/versions/:versionId/restore
 * Restore document to a previous version.
 * Creates a snapshot of current state first (safety net), then overwrites content.
 */
export async function restoreDocVersionHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;

    const doc = await storage.getDocument(docId);
    if (!doc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    // Only owner or editors can restore versions
    const isOwner = doc.ownerId === userId;
    if (!isOwner) {
      const share = await storage.getShareInDocumentTree(docId, userId);
      if (!share || (share.permission !== "edit" && share.permission !== "edit_comment")) {
        res.status(403).json({ message: "Permission denied" });
        return;
      }
    }

    const version = await versionStorage.getDocumentVersion(req.params.versionId);
    if (!version || version.documentId !== docId) {
      res.status(404).json({ message: "Version not found" });
      return;
    }

    // Safety: snapshot current state before restoring
    await createManualVersion(doc, userId, "restore");

    // Restore content from the version
    const restored = await storage.updateDocument(docId, {
      title: version.title,
      content: version.content || "",
      lastUpdatedBy: userId,
    }, true);

    res.json(restored);
  } catch (error) {
    console.error("Error restoring version:", error);
    res.status(500).json({ message: "Failed to restore version" });
  }
}

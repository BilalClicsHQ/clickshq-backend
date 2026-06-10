import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Restore a soft-deleted document (and its children)
 * POST /api/docs/:id/restore
 */
export async function restoreDocHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const docId = req.params.id;
    const doc = await storage.getDocument(docId);
    if (!doc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    // Only owner can restore
    if (doc.ownerId !== userId) {
      res.status(403).json({ message: "Only the document owner can restore this document" });
      return;
    }

    // Check it's actually deleted
    if (!doc.deletedAt) {
      res.status(400).json({ message: "Document is not in trash" });
      return;
    }

    const success = await storage.restoreDocument(docId);
    if (!success) {
      res.status(500).json({ message: "Failed to restore document" });
      return;
    }

    res.json({ message: "Document restored successfully" });
  } catch (error) {
    console.error("Error restoring document:", error);
    res.status(500).json({ message: "Failed to restore document" });
  }
}

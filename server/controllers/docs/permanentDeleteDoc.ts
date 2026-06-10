import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Permanently delete a document from trash
 * DELETE /api/docs/:id/permanent
 */
export async function permanentDeleteDocHandler(req: Request, res: Response) {
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

    // Only owner can permanently delete
    if (doc.ownerId !== userId) {
      res.status(403).json({ message: "Only the document owner can permanently delete" });
      return;
    }

    // Must be soft-deleted first
    if (!doc.deletedAt) {
      res.status(400).json({ message: "Document must be in trash before permanent deletion" });
      return;
    }

    const success = await storage.permanentlyDeleteDocument(docId);
    if (!success) {
      res.status(500).json({ message: "Failed to permanently delete document" });
      return;
    }

    res.status(204).send();
  } catch (error) {
    console.error("Error permanently deleting document:", error);
    res.status(500).json({ message: "Failed to permanently delete document" });
  }
}

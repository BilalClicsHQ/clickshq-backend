import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Mark document as viewed (update lastViewedAt)
 * PATCH /api/docs/:id/view
 */
export async function markAsViewedHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;

    // First check if document exists
    const doc = await storage.getDocument(docId);
    if (!doc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    // Update lastViewedAt based on whether viewer is owner or shared user
    if (doc.ownerId === userId) {
      // Owner viewing their own document - update document's lastViewedAt
      const updated = await storage.updateDocumentLastViewed(docId);
      res.json({ id: updated?.id, lastViewedAt: updated?.lastViewedAt });
    } else {
      // Shared user viewing document - update their share record's lastViewedAt
      const updated = await storage.updateSharedUserLastViewed(docId, userId);
      res.json({ id: doc.id, lastViewedAt: updated?.lastViewedAt, sharedView: true });
    }
  } catch (error) {
    console.error("Error marking document as viewed:", error);
    res.status(500).json({ message: "Failed to mark document as viewed" });
  }
}

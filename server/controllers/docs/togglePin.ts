import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Toggle pinned status of a document
 * PATCH /api/docs/:id/pin
 */
export async function togglePinHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;
    const { isPinned } = req.body;

    console.log("[TogglePin] User:", userId, "Doc:", docId, "isPinned:", isPinned);

    // Get the document first to check if it exists
    const existingDoc = await storage.getDocument(docId);
    if (!existingDoc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    // Check if user has access (owner or shared with them)
    const isOwner = existingDoc.ownerId === userId;
    const sharePermission = await storage.getDocumentShareForUser(docId, userId);

    if (!isOwner && !sharePermission) {
      res.status(403).json({ message: "You don't have access to this document" });
      return;
    }

    console.log("[TogglePin] isOwner:", isOwner, "sharePermission:", sharePermission);

    // Update the document
    const doc = await storage.updateDocument(docId, { isPinned });

    if (!doc) {
      res.status(500).json({ message: "Failed to update document" });
      return;
    }

    console.log("[TogglePin] Updated doc isPinned:", doc.isPinned);

    res.json({ id: doc.id, isPinned: doc.isPinned });
  } catch (error) {
    console.error("[TogglePin] Error:", error);
    res.status(500).json({ message: "Failed to toggle pin" });
  }
}

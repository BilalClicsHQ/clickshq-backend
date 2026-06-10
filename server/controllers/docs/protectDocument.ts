import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Toggle document protection status
 * PATCH /api/docs/:id/protect
 *
 * Only document owners can protect/unprotect documents.
 * When protected, only the owner can edit the document.
 */
export async function protectDocumentHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const documentId = req.params.id;
    const { isProtected } = req.body;

    if (typeof isProtected !== "boolean") {
      return res.status(400).json({ message: "isProtected must be a boolean" });
    }

    // Get document
    const doc = await storage.getDocument(documentId);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Only owner can protect/unprotect
    if (doc.ownerId !== userId) {
      return res.status(403).json({ message: "Only the document owner can change protection status" });
    }

    // Update document
    const updated = await storage.updateDocument(documentId, { isProtected });
    if (!updated) {
      return res.status(500).json({ message: "Failed to update document" });
    }

    res.json(updated);
  } catch (error) {
    console.error("Error updating document protection:", error);
    res.status(500).json({ message: "Failed to update document protection" });
  }
}

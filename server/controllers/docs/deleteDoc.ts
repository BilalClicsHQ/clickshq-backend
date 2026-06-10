import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import { versionStorage } from "../../storage/versionStorage";

/**
 * Delete a document
 * DELETE /api/docs/:id
 * Only the document owner can delete documents/pages.
 */
export async function deleteDocHandler(req: Request, res: Response) {
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

    // For pages (child documents), check the root document's owner
    // For root documents, check the document's own owner
    let ownerId = doc.ownerId;
    if (doc.parentDocumentId) {
      const rootDoc = await storage.getRootDocument(docId);
      if (rootDoc) {
        ownerId = rootDoc.ownerId;
      }
    }

    // Only the owner can delete
    if (ownerId !== userId) {
      res.status(403).json({ message: "Only the document owner can delete this document" });
      return;
    }

    // Clean up version history before deleting
    await versionStorage.deleteVersionsByDocumentId(docId);

    const success = await storage.deleteDocument(docId);
    if (!success) {
      res.status(404).json({ message: "Document not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting document:", error);
    res.status(500).json({ message: "Failed to delete document" });
  }
}

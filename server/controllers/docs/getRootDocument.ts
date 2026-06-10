import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Get the root document for any document (traverses up the hierarchy)
 * GET /api/docs/:id/root
 *
 * Returns the root document info (the top-level document in the hierarchy)
 * If the document has no parent, it returns itself
 */
export async function getRootDocumentHandler(req: Request, res: Response) {
  try {
    const documentId = req.params.id;

    // Get the document first
    const doc = await storage.getDocument(documentId);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    // If no parent, this is already the root
    if (!doc.parentDocumentId) {
      return res.json({
        id: doc.id,
        title: doc.title,
        isRoot: true,
      });
    }

    // Traverse up to find the root
    const rootDoc = await storage.getRootDocument(documentId);
    if (!rootDoc) {
      return res.status(404).json({ message: "Root document not found" });
    }

    return res.json({
      id: rootDoc.id,
      title: rootDoc.title,
      isRoot: true,
    });
  } catch (error) {
    console.error("Error getting root document:", error);
    res.status(500).json({ message: "Failed to get root document" });
  }
}

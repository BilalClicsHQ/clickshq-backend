import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Get the full page tree for a document
 * GET /api/docs/:id/page-tree
 */
export async function getDocPageTreeHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const documentId = req.params.id;

    // Check if document exists
    const doc = await storage.getDocument(documentId);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Check if user has access (owner or shared anywhere in the document tree)
    let hasAccess = doc.ownerId === userId;
    if (!hasAccess) {
      const share = await storage.getShareInDocumentTree(documentId, userId);
      hasAccess = !!share;
    }

    if (!hasAccess) {
      return res.status(403).json({ message: "You don't have access to this document" });
    }

    const pageTree = await storage.getPageTree(documentId);
    res.json(pageTree);
  } catch (error) {
    console.error("Error fetching page tree:", error);
    res.status(500).json({ message: "Failed to fetch page tree" });
  }
}

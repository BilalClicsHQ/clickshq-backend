import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";


export async function createDocPageHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const parentDocumentId = req.params.id;
    const { title } = req.body;

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return res.status(400).json({ message: "Page title is required" });
    }

    // Check if parent document exists
    const parentDoc = await storage.getDocument(parentDocumentId);
    if (!parentDoc) {
      return res.status(404).json({ message: "Parent document not found" });
    }

    if (parentDoc.deletedAt) {
      return res.status(400).json({ message: "Cannot add pages to a document that is in trash" });
    }

    // Check if user can edit (owner or has edit/edit_comment permission anywhere in the document tree)
    let canEdit = parentDoc.ownerId === userId;
    if (!canEdit) {
      const share = await storage.getShareInDocumentTree(parentDocumentId, userId);
      if (share && (share.permission === "edit" || share.permission === "edit_comment")) {
        canEdit = true;
      }
    }

    if (!canEdit) {
      return res.status(403).json({ message: "You don't have permission to add pages to this document" });
    }

    // Create the new page (inherit owner from parent document)
    const newPage = await storage.createDocumentPage(
      parentDocumentId,
      title.trim(),
      parentDoc.ownerId // Pages inherit ownership from parent
    );

    res.status(201).json(newPage);
  } catch (error) {
    console.error("Error creating document page:", error);
    res.status(500).json({ message: "Failed to create document page" });
  }
}

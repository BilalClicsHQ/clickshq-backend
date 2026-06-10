import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import { createManualVersion } from "./versionHelper";

/**
 * POST /api/docs/:id/versions
 * Manually create a version snapshot
 */
export async function createDocVersionHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;

    const doc = await storage.getDocument(docId);
    if (!doc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    // Only owner or editors can create manual versions
    const isOwner = doc.ownerId === userId;
    if (!isOwner) {
      const share = await storage.getShareInDocumentTree(docId, userId);
      if (!share || (share.permission !== "edit" && share.permission !== "edit_comment")) {
        res.status(403).json({ message: "Permission denied" });
        return;
      }
    }

    await createManualVersion(doc, userId);
    res.status(201).json({ message: "Version created" });
  } catch (error) {
    console.error("Error creating version:", error);
    res.status(500).json({ message: "Failed to create version" });
  }
}

import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import { z } from "zod";

const createCommentSchema = z.object({
  content: z.string()
    .min(1, "Comment cannot be empty")
    .max(5000, "Comment too long (max 5000 characters)")
    .trim(),
  mentionedUserIds: z.array(z.string()).optional().default([])
});

export async function createCommentHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;

    // Validate input
    const validation = createCommentSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        message: "Invalid input",
        errors: validation.error.flatten().fieldErrors
      });
      return;
    }

    const { content, mentionedUserIds } = validation.data;

    // Check if document exists and user has permission
    const document = await storage.getDocument(req.params.id);
    if (!document) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    if (document.deletedAt) {
      res.status(400).json({ message: "Cannot comment on a document that is in trash" });
      return;
    }

    // Check if user has comment permission
    // "view" and "edit" only users CANNOT comment. Only owner, comment, and edit_comment can.
    const share = await storage.getShareInDocumentTree(req.params.id, userId);
    const hasPermission = document.ownerId === userId ||
      (share && ['comment', 'edit_comment'].includes(share.permission));

    if (!hasPermission) {
      res.status(403).json({ message: "You don't have permission to comment on this document" });
      return;
    }

    const comment = await storage.createDocumentComment({
      documentId: req.params.id,
      userId,
      content,
      status: 'open',
      mentionedUserIds
    });

    res.status(201).json(comment);
  } catch (error) {
    console.error("Error creating comment:", error);
    res.status(500).json({ message: "Failed to create comment" });
  }
}

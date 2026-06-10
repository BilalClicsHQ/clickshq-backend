import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import { z } from "zod";

const updateCommentSchema = z.object({
  content: z.string()
    .min(1, "Comment cannot be empty")
    .max(5000, "Comment too long (max 5000 characters)")
    .trim()
    .optional(),
  status: z.enum(['open', 'resolved']).optional()
}).refine(data => data.content !== undefined || data.status !== undefined, {
  message: "At least one field (content or status) must be provided"
});

/**
 * Update a comment
 * PUT /api/docs/:docId/comments/:commentId
 *
 * Permission rules:
 * - Editing content: only the comment author can edit their own comment
 * - Resolving/reopening: requires at least comment permission on the document
 * - View-only users cannot modify comments at all
 */
export async function updateCommentHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const { docId, commentId } = req.params;

    // Validate input
    const validation = updateCommentSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        message: "Invalid input",
        errors: validation.error.flatten().fieldErrors
      });
      return;
    }

    const { content, status } = validation.data;

    // Check document exists
    const doc = await storage.getDocument(docId);
    if (!doc || doc.deletedAt) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    // Determine user's permission
    const isOwner = doc.ownerId === userId;
    let userPermission: string | null = isOwner ? "owner" : null;
    if (!isOwner) {
      const share = await storage.getShareInDocumentTree(docId, userId);
      if (share) userPermission = share.permission;
    }

    if (!userPermission) {
      res.status(403).json({ message: "You don't have access to this document" });
      return;
    }

    // View-only users cannot modify comments
    if (userPermission === "view") {
      res.status(403).json({ message: "View-only users cannot modify comments" });
      return;
    }

    // For content edits, only the comment author can edit
    if (content !== undefined) {
      const existingComment = await storage.getDocumentComment(commentId);
      if (!existingComment) {
        res.status(404).json({ message: "Comment not found" });
        return;
      }
      if (existingComment.userId !== userId) {
        res.status(403).json({ message: "You can only edit your own comments" });
        return;
      }
    }

    const comment = await storage.updateDocumentComment(commentId, {
      content,
      status
    });

    if (!comment) {
      res.status(404).json({ message: "Comment not found" });
      return;
    }

    res.json(comment);
  } catch (error) {
    console.error("Error updating comment:", error);
    res.status(500).json({ message: "Failed to update comment" });
  }
}

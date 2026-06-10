import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Delete a comment
 * DELETE /api/docs/:docId/comments/:commentId
 *
 * Permission rules:
 * - Only the comment author or the document owner can delete a comment
 * - View-only users cannot delete comments
 */
export async function deleteCommentHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const { docId, commentId } = req.params;

    // Check document exists
    const doc = await storage.getDocument(docId);
    if (!doc || doc.deletedAt) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    // Fetch the comment to check ownership
    const comment = await storage.getDocumentComment(commentId);
    if (!comment) {
      res.status(404).json({ message: "Comment not found" });
      return;
    }

    // Only the comment author or document owner can delete
    const isDocOwner = doc.ownerId === userId;
    const isCommentAuthor = comment.userId === userId;

    if (!isDocOwner && !isCommentAuthor) {
      res.status(403).json({ message: "You can only delete your own comments" });
      return;
    }

    const success = await storage.deleteDocumentComment(commentId);
    if (!success) {
      res.status(404).json({ message: "Comment not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting comment:", error);
    res.status(500).json({ message: "Failed to delete comment" });
  }
}

import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Remove document share for a user
 * DELETE /api/docs/:documentId/shares/:shareUserId
 *
 * Features:
 * - Activity logging for audit trail
 */
export async function removeDocumentShareHandler(req: Request, res: Response) {
  try {
    const currentUserId = (req.user as any)?.id;
    const { documentId, shareUserId } = req.params;

    // Check if document exists and user owns it
    const doc = await storage.getDocument(documentId);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    if (doc.ownerId !== currentUserId) {
      return res.status(403).json({ message: "Only the document owner can remove shares" });
    }

    // Get share details before removal for logging
    const existingShare = await storage.getDocumentShareForUser(documentId, shareUserId);
    if (!existingShare) {
      return res.status(404).json({ message: "Share not found" });
    }

    // Get user details for logging
    const targetUser = await storage.getUser(shareUserId);

    const success = await storage.removeDocumentShare(documentId, shareUserId);
    if (!success) {
      return res.status(404).json({ message: "Share not found" });
    }

    // Log activity for audit trail
    try {
      await storage.logActivity({
        userId: currentUserId,
        action: "document_share_removed",
        details: JSON.stringify({
          documentId,
          documentTitle: doc.title,
          removedUserId: shareUserId,
          removedUserEmail: targetUser?.email || null,
          removedUserName: targetUser?.displayName || null,
          previousPermission: existingShare.permission,
        }),
        ipAddress: req.ip || req.socket.remoteAddress || null,
        userAgent: req.headers["user-agent"] || null,
      });
    } catch (logError) {
      console.error("Failed to log share removal activity:", logError);
    }

    res.status(204).send();
  } catch (error) {
    console.error("Error removing document share:", error);
    res.status(500).json({ message: "Failed to remove document share" });
  }
}

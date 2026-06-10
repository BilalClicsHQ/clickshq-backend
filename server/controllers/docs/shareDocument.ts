import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import { shareDocumentRequestSchema } from "@shared/schema";

/**
 * Share document with a user
 * POST /api/docs/:documentId/shares
 *
 * Features:
 * - Zod validation for request body
 * - Uses userId instead of email for better security
 * - Activity logging for audit trail
 * - Supports both email (legacy) and userId
 */
export async function shareDocumentHandler(req: Request, res: Response) {
  try {
    const currentUserId = (req.user as any)?.id;
    const { documentId } = req.params;

    // Support both legacy email format and new userId format
    let targetUserId: string;
    let permission: string;

    // Check if using new userId format
    if (req.body.userId) {
      // Validate request body with Zod
      const parseResult = shareDocumentRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        const errors = parseResult.error.flatten();
        return res.status(400).json({
          message: "Validation failed",
          errors: errors.fieldErrors,
        });
      }
      targetUserId = parseResult.data.userId;
      permission = parseResult.data.permission;
    } else if (req.body.userEmail) {
      // Legacy support: find user by email
      const targetUser = await storage.getUserByEmail(req.body.userEmail);
      if (!targetUser) {
        return res.status(404).json({ message: "User not found with this email" });
      }
      targetUserId = targetUser.id;
      permission = req.body.permission;

      // Validate permission for legacy format
      const validPermissions = ["view", "edit", "comment", "edit_comment"];
      if (!permission || !validPermissions.includes(permission)) {
        return res.status(400).json({
          message: "Permission must be one of: view, edit, comment, edit_comment",
        });
      }
    } else {
      return res.status(400).json({
        message: "Either userId or userEmail is required",
      });
    }

    // Verify target user exists
    const targetUser = await storage.getUser(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Can't share with yourself
    if (targetUserId === currentUserId) {
      return res.status(400).json({ message: "Cannot share document with yourself" });
    }

    // Check if document exists and user has access to share it
    const doc = await storage.getDocument(documentId);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    if (doc.deletedAt) {
      return res.status(400).json({ message: "Cannot share a document that is in trash" });
    }

    // Allow owner OR anyone the document is shared with to re-share it
    // Non-owners can only grant up to their own permission level
    const PERMISSION_LEVELS: Record<string, number> = {
      view: 1,
      comment: 2,
      edit: 3,
      edit_comment: 4,
    };

    if (doc.ownerId !== currentUserId) {
      const currentUserShare = await storage.getShareInDocumentTree(documentId, currentUserId);
      if (!currentUserShare) {
        return res.status(403).json({ message: "You don't have access to share this document" });
      }

      // Cap permission to the sharer's own permission level
      const sharerLevel = PERMISSION_LEVELS[currentUserShare.permission] || 0;
      const requestedLevel = PERMISSION_LEVELS[permission] || 0;
      if (requestedLevel > sharerLevel) {
        permission = currentUserShare.permission;
      }
    }

    // Check if share already exists to determine if this is new or update
    const existingShare = await storage.getDocumentShareForUser(documentId, targetUserId);
    const isUpdate = !!existingShare;

    // Create or update the share
    const share = await storage.shareDocument({
      documentId,
      userId: targetUserId,
      permission: permission as "view" | "edit" | "comment" | "edit_comment",
      sharedBy: currentUserId,
    });

    // Log activity for audit trail
    try {
      await storage.logActivity({
        userId: currentUserId,
        action: isUpdate ? "document_share_updated" : "document_shared",
        details: JSON.stringify({
          documentId,
          documentTitle: doc.title,
          sharedWithUserId: targetUserId,
          sharedWithEmail: targetUser.email,
          sharedWithName: targetUser.displayName,
          permission,
          previousPermission: existingShare?.permission || null,
        }),
        ipAddress: req.ip || req.socket.remoteAddress || null,
        userAgent: req.headers["user-agent"] || null,
      });
    } catch (logError) {
      // Don't fail the request if logging fails
      console.error("Failed to log share activity:", logError);
    }

    res.status(isUpdate ? 200 : 201).json({
      ...share,
      user: {
        id: targetUser.id,
        displayName: targetUser.displayName,
        email: targetUser.email,
        profilePicture: targetUser.profilePicture,
      },
    });
  } catch (error) {
    console.error("Error sharing document:", error);
    res.status(500).json({ message: "Failed to share document" });
  }
}

import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import { updateSharePermissionRequestSchema } from "@shared/schema";

/**
 * Update share permission for a user
 * PATCH /api/docs/:documentId/shares/:shareUserId
 *
 * Features:
 * - Zod validation for permission
 * - Activity logging for audit trail
 */
export async function updateSharePermissionHandler(req: Request, res: Response) {
  try {
    const currentUserId = (req.user as any)?.id;
    const { documentId, shareUserId } = req.params;

    // Validate request body with Zod
    const parseResult = updateSharePermissionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const errors = parseResult.error.flatten();
      return res.status(400).json({
        message: "Validation failed",
        errors: errors.fieldErrors,
      });
    }
    const { permission } = parseResult.data;

    // Check if document exists and user owns it
    const doc = await storage.getDocument(documentId);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    if (doc.ownerId !== currentUserId) {
      return res.status(403).json({ message: "Only the document owner can update sharing permissions" });
    }

    // Get existing share to log the change
    const existingShare = await storage.getDocumentShareForUser(documentId, shareUserId);
    if (!existingShare) {
      return res.status(404).json({ message: "Share not found" });
    }

    const previousPermission = existingShare.permission;

    const updated = await storage.updateDocumentSharePermission(documentId, shareUserId, permission);
    if (!updated) {
      return res.status(404).json({ message: "Share not found" });
    }

    // Get user details for logging
    const targetUser = await storage.getUser(shareUserId);

    // Log activity for audit trail
    try {
      await storage.logActivity({
        userId: currentUserId,
        action: "document_share_permission_updated",
        details: JSON.stringify({
          documentId,
          documentTitle: doc.title,
          sharedWithUserId: shareUserId,
          sharedWithEmail: targetUser?.email || null,
          sharedWithName: targetUser?.displayName || null,
          previousPermission,
          newPermission: permission,
        }),
        ipAddress: req.ip || req.socket.remoteAddress || null,
        userAgent: req.headers["user-agent"] || null,
      });
    } catch (logError) {
      console.error("Failed to log permission update activity:", logError);
    }

    res.json(updated);
  } catch (error) {
    console.error("Error updating share permission:", error);
    res.status(500).json({ message: "Failed to update share permission" });
  }
}

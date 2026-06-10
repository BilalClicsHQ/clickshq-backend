import type { Request, Response } from "express";
import crypto from "crypto";
import { documentStorage as storage } from "../../storage/documentStorage";
import { inviteByEmailRequestSchema } from "@shared/schema";
import { db } from "../../db";
import { documentInvites } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { sendDocumentInviteEmail } from "../../services/emailService";

/**
 * Invite a user to a document by email
 * POST /api/docs/:documentId/invites
 *
 * If the user exists in the system, shares directly.
 * If the user doesn't exist, creates an invite that can be accepted after registration.
 *
 * Features:
 * - Zod validation for email and permission
 * - Automatic share if user exists
 * - Creates invite with unique token for unregistered users
 * - Activity logging for audit trail
 */
export async function inviteByEmailHandler(req: Request, res: Response) {
  try {
    const currentUserId = (req.user as any)?.id;
    const { documentId } = req.params;

    // Validate request body with Zod
    const parseResult = inviteByEmailRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const errors = parseResult.error.flatten();
      return res.status(400).json({
        message: "Validation failed",
        errors: errors.fieldErrors,
      });
    }
    const { email } = parseResult.data;
    let { permission } = parseResult.data;

    // Check if document exists and user has access to share it
    const doc = await storage.getDocument(documentId);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Allow owner OR anyone the document is shared with to invite others
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

    // Can't invite yourself
    const existingUser = await storage.getUserByEmail(email);
    if (existingUser && existingUser.id === currentUserId) {
      return res.status(400).json({ message: "Cannot invite yourself" });
    }

    // Check if there's already a pending invite
    const [existingInvite] = await db
      .select()
      .from(documentInvites)
      .where(
        and(
          eq(documentInvites.documentId, documentId),
          eq(documentInvites.email, email.toLowerCase()),
          eq(documentInvites.status, "pending")
        )
      );

    if (existingInvite) {
      // Update existing invite's permission and expiry
      const [updatedInvite] = await db
        .update(documentInvites)
        .set({
          permission: permission as "view" | "edit" | "comment" | "edit_comment",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        })
        .where(eq(documentInvites.id, existingInvite.id))
        .returning();

      return res.status(200).json({
        type: "invite_updated",
        message: "Invite updated successfully",
        invite: updatedInvite,
      });
    }

    // Create new invite with unique token
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const [newInvite] = await db
      .insert(documentInvites)
      .values({
        documentId,
        email: email.toLowerCase(),
        permission: permission as "view" | "edit" | "comment" | "edit_comment",
        invitedBy: currentUserId,
        token,
        expiresAt,
        status: "pending",
      })
      .returning();

    // Log activity
    try {
      await storage.logActivity({
        userId: currentUserId,
        action: "document_invite_created",
        details: JSON.stringify({
          documentId,
          documentTitle: doc.title,
          invitedEmail: email,
          permission,
          inviteId: newInvite.id,
          expiresAt: expiresAt.toISOString(),
        }),
        ipAddress: req.ip || req.socket.remoteAddress || null,
        userAgent: req.headers["user-agent"] || null,
      });
    } catch (logError) {
      console.error("Failed to log invite activity:", logError);
    }

    // Send invite email (fire-and-forget)
    const inviter = await storage.getUser(currentUserId);
    // Use FRONTEND_URL for invite links (where users will accept invites)
    // Fall back to APP_URL for backwards compatibility
    const frontendUrl = process.env.FRONTEND_URL || process.env.APP_URL;

    if (!frontendUrl) {
      console.warn("⚠️  FRONTEND_URL not set - invite emails will have broken links");
    }

    const acceptUrl = frontendUrl ? `${frontendUrl}/accept-invite/${token}` : `/accept-invite/${token}`;

    sendDocumentInviteEmail({
      to: email,
      inviterName: inviter?.displayName || "Someone",
      documentTitle: doc.title || "Untitled",
      acceptUrl,
    }).catch((err) => console.error("Failed to send invite email:", err));

    res.status(201).json({
      type: "invite_created",
      message: "Invite sent successfully. The user will be able to access the document after registering.",
      invite: {
        id: newInvite.id,
        email: newInvite.email,
        permission: newInvite.permission,
        expiresAt: newInvite.expiresAt,
        // Don't expose token in response for security
      },
    });
  } catch (error) {
    console.error("Error inviting user:", error);
    res.status(500).json({ message: "Failed to invite user" });
  }
}

/**
 * Get pending invites for a document
 * GET /api/docs/:documentId/invites
 */
export async function getDocumentInvitesHandler(req: Request, res: Response) {
  try {
    const currentUserId = (req.user as any)?.id;
    const { documentId } = req.params;

    // Check if document exists and user owns it
    const doc = await storage.getDocument(documentId);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    if (doc.ownerId !== currentUserId) {
      return res.status(403).json({ message: "Only the document owner can view invites" });
    }

    const invites = await db
      .select({
        id: documentInvites.id,
        email: documentInvites.email,
        permission: documentInvites.permission,
        status: documentInvites.status,
        expiresAt: documentInvites.expiresAt,
        createdAt: documentInvites.createdAt,
      })
      .from(documentInvites)
      .where(eq(documentInvites.documentId, documentId));

    res.json(invites);
  } catch (error) {
    console.error("Error getting document invites:", error);
    res.status(500).json({ message: "Failed to get invites" });
  }
}

/**
 * Revoke/delete a document invite
 * DELETE /api/docs/:documentId/invites/:inviteId
 */
export async function revokeDocumentInviteHandler(req: Request, res: Response) {
  try {
    const currentUserId = (req.user as any)?.id;
    const { documentId, inviteId } = req.params;

    // Check if document exists and user owns it
    const doc = await storage.getDocument(documentId);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    if (doc.ownerId !== currentUserId) {
      return res.status(403).json({ message: "Only the document owner can revoke invites" });
    }

    // Get invite details before deletion for logging
    const [invite] = await db
      .select()
      .from(documentInvites)
      .where(
        and(
          eq(documentInvites.id, inviteId),
          eq(documentInvites.documentId, documentId)
        )
      );

    if (!invite) {
      return res.status(404).json({ message: "Invite not found" });
    }

    // Update status to revoked instead of deleting (for audit trail)
    await db
      .update(documentInvites)
      .set({ status: "revoked" })
      .where(eq(documentInvites.id, inviteId));

    // Log activity
    try {
      await storage.logActivity({
        userId: currentUserId,
        action: "document_invite_revoked",
        details: JSON.stringify({
          documentId,
          documentTitle: doc.title,
          revokedEmail: invite.email,
          inviteId,
        }),
        ipAddress: req.ip || req.socket.remoteAddress || null,
        userAgent: req.headers["user-agent"] || null,
      });
    } catch (logError) {
      console.error("Failed to log invite revocation:", logError);
    }

    res.status(204).send();
  } catch (error) {
    console.error("Error revoking invite:", error);
    res.status(500).json({ message: "Failed to revoke invite" });
  }
}

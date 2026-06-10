/**
 * Regenerate Public Link Handler
 *
 * POST /api/docs/:id/public-link/regenerate
 *
 * Generates a new token for an existing public link.
 * Useful when:
 * - User wants to revoke access for people who have the old link
 * - Token may have been compromised
 * - User wants to start fresh with sharing
 */

import type { Request, Response } from "express";
import { publicDocumentService, PublicDocumentError } from "../../services/publicDocumentService";

export async function regeneratePublicLinkHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;
    const { expiresAt } = req.body;

    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    // Parse expiry date if provided
    let expiryDate: Date | null | undefined = undefined;
    if (expiresAt !== undefined) {
      if (expiresAt === null) {
        expiryDate = null; // Remove expiry
      } else {
        expiryDate = new Date(expiresAt);
        if (isNaN(expiryDate.getTime())) {
          return res.status(400).json({ message: "Invalid expiry date format" });
        }
        if (expiryDate < new Date()) {
          return res.status(400).json({ message: "Expiry date must be in the future" });
        }
      }
    }

    const result = await publicDocumentService.regenerateToken(docId, userId, expiryDate);

    res.json({
      publicLinkEnabled: result.enabled,
      publicLinkToken: result.token,
      publicLinkPermission: result.permission,
      publicLinkExpiresAt: result.expiresAt,
      publicLinkCreatedAt: result.createdAt,
      publicLinkUrl: result.url,
      message: "Public link regenerated successfully. Old links will no longer work.",
    });
  } catch (error) {
    if (error instanceof PublicDocumentError) {
      return res.status(error.statusCode).json({ message: error.message });
    }

    console.error("Error regenerating public link:", error);
    res.status(500).json({ message: "Failed to regenerate public link" });
  }
}

/**
 * Update Public Link Expiry Handler
 *
 * PATCH /api/docs/:id/public-link/expiry
 *
 * Updates only the expiry date without regenerating the token.
 */
export async function updatePublicLinkExpiryHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;
    const { expiresAt } = req.body;

    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    // Parse expiry date
    let expiryDate: Date | null = null;
    if (expiresAt) {
      expiryDate = new Date(expiresAt);
      if (isNaN(expiryDate.getTime())) {
        return res.status(400).json({ message: "Invalid expiry date format" });
      }
      if (expiryDate < new Date()) {
        return res.status(400).json({ message: "Expiry date must be in the future" });
      }
    }

    const result = await publicDocumentService.updateExpiry(docId, userId, expiryDate);

    res.json({
      publicLinkEnabled: result.enabled,
      publicLinkToken: result.token,
      publicLinkPermission: result.permission,
      publicLinkExpiresAt: result.expiresAt,
      publicLinkCreatedAt: result.createdAt,
      publicLinkUrl: result.url,
    });
  } catch (error) {
    if (error instanceof PublicDocumentError) {
      return res.status(error.statusCode).json({ message: error.message });
    }

    console.error("Error updating public link expiry:", error);
    res.status(500).json({ message: "Failed to update expiry" });
  }
}

/**
 * Get Public Link Info Handler
 *
 * GET /api/docs/:id/public-link
 *
 * Returns current public link settings for a document.
 */
export async function getPublicLinkInfoHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;

    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const result = await publicDocumentService.getPublicLinkInfo(docId, userId);

    res.json({
      publicLinkEnabled: result.enabled,
      publicLinkToken: result.token,
      publicLinkPermission: result.permission,
      publicLinkExpiresAt: result.expiresAt,
      publicLinkCreatedAt: result.createdAt,
      publicLinkUrl: result.url,
    });
  } catch (error) {
    if (error instanceof PublicDocumentError) {
      return res.status(error.statusCode).json({ message: error.message });
    }

    console.error("Error getting public link info:", error);
    res.status(500).json({ message: "Failed to get public link info" });
  }
}

/**
 * Update Public Link Permission Handler
 *
 * PATCH /api/docs/:id/public-link/permission
 *
 * Updates only the permission level without regenerating the token.
 */
export async function updatePublicLinkPermissionHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;
    const { permission } = req.body;

    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    // Validate permission
    const validPermissions = ["view", "edit", "comment", "edit_comment"];
    if (!permission || !validPermissions.includes(permission)) {
      return res.status(400).json({ message: "Invalid permission. Must be one of: view, edit, comment, edit_comment" });
    }

    const result = await publicDocumentService.updatePermission(docId, userId, permission);

    res.json({
      publicLinkEnabled: result.enabled,
      publicLinkToken: result.token,
      publicLinkPermission: result.permission,
      publicLinkExpiresAt: result.expiresAt,
      publicLinkCreatedAt: result.createdAt,
      publicLinkUrl: result.url,
    });
  } catch (error) {
    if (error instanceof PublicDocumentError) {
      return res.status(error.statusCode).json({ message: error.message });
    }

    console.error("Error updating public link permission:", error);
    res.status(500).json({ message: "Failed to update permission" });
  }
}

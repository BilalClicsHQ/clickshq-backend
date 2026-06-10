/**
 * Toggle Public Link Handler
 *
 * PATCH /api/docs/:id/public-link
 *
 * Production-grade implementation:
 * - ALWAYS regenerates token when enabling (prevents old tokens from working)
 * - Supports optional expiry date
 * - Uses service layer for clean architecture
 * - Only document owner can manage public links
 */

import type { Request, Response } from "express";
import { publicDocumentService, PublicDocumentError } from "../../services/publicDocumentService";

export async function togglePublicLinkHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;
    const { enabled, expiresAt, permission } = req.body;

    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (typeof enabled !== "boolean") {
      return res.status(400).json({ message: "enabled field must be a boolean" });
    }

    // Validate permission if provided
    const validPermissions = ["view", "edit", "comment", "edit_comment"];
    const linkPermission = permission && validPermissions.includes(permission) ? permission : "view";

    // Parse expiry date if provided
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

    let result;
    if (enabled) {
      // Enable public link - ALWAYS generates a new token
      result = await publicDocumentService.enablePublicLink(docId, userId, expiryDate, linkPermission);
    } else {
      // Disable public link - clears the token
      result = await publicDocumentService.disablePublicLink(docId, userId);
    }

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

    console.error("Error toggling public link:", error);
    res.status(500).json({ message: "Failed to toggle public link" });
  }
}

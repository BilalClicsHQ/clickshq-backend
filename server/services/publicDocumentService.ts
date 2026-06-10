/**
 * Public Document Service
 *
 * Production-grade service layer for public document sharing.
 * Implements clean architecture pattern: Controller -> Service -> Storage
 *
 * Features:
 * - Token generation with cryptographic security
 * - Expiry management
 * - Access logging
 * - Rate limiting support
 */

import { randomBytes } from "crypto";
import { documentStorage as storage } from "../storage/documentStorage";
import type { Document } from "@shared/schema";

// ============================================================================
// TYPES
// ============================================================================

export interface PublicLinkSettings {
  enabled: boolean;
  expiresAt?: Date | null;
  permission?: "view" | "edit" | "comment" | "edit_comment";
}

export interface PublicDocumentResponse {
  id: string;
  title: string;
  content: string;
  pageStyles: {
    fontStyle: string;
    fontSize: string;
    pageWidth: string;
    showLastModified: boolean;
  };
  updatedAt: Date | null;
  createdAt: Date | null;
  ownerName: string;
  expiresAt: Date | null;
  isExpired: boolean;
  permission: "view" | "edit" | "comment" | "edit_comment";
}

export interface PublicLinkInfo {
  enabled: boolean;
  token: string | null;
  expiresAt: Date | null;
  createdAt: Date | null;
  url: string | null;
  permission: "view" | "edit" | "comment" | "edit_comment";
}

export interface AccessLogEntry {
  documentId: string;
  token: string;
  timestamp: Date;
  ip: string;
  userAgent: string;
}

// ============================================================================
// SERVICE CLASS
// ============================================================================

class PublicDocumentService {
  // In-memory access log (in production, use a database or logging service)
  private accessLog: AccessLogEntry[] = [];
  private readonly MAX_LOG_ENTRIES = 10000;

  /**
   * Generate a cryptographically secure token for public links
   * Uses 32 bytes of randomness (256 bits) for security
   */
  generateToken(): string {
    return randomBytes(32).toString("hex");
  }

  /**
   * Enable public link for a document
   * ALWAYS generates a new token to prevent old links from working
   */
  async enablePublicLink(
    docId: string,
    userId: string,
    expiresAt?: Date | null,
    permission: "view" | "edit" | "comment" | "edit_comment" = "view"
  ): Promise<PublicLinkInfo> {
    const doc = await storage.getDocument(docId);
    if (!doc) {
      throw new PublicDocumentError("Document not found", 404);
    }

    if (doc.ownerId !== userId) {
      throw new PublicDocumentError("Only the document owner can manage public links", 403);
    }

    // ALWAYS generate a new token when enabling
    // This prevents old tokens from becoming valid again
    const newToken = this.generateToken();
    const now = new Date();

    const updatedDoc = await storage.updateDocument(docId, {
      publicLinkEnabled: true,
      publicLinkToken: newToken,
      publicLinkPermission: permission,
      publicLinkExpiresAt: expiresAt || null,
      publicLinkCreatedAt: now,
    }, false);

    if (!updatedDoc) {
      throw new PublicDocumentError("Failed to update document", 500);
    }

    console.log(`[PublicDoc] Public link enabled for document ${docId} by user ${userId} with permission: ${permission}`);

    return {
      enabled: true,
      token: newToken,
      expiresAt: expiresAt || null,
      createdAt: now,
      url: `/public/docs/${newToken}`,
      permission,
    };
  }

  /**
   * Disable public link for a document
   * Clears the token to invalidate any existing links
   */
  async disablePublicLink(docId: string, userId: string): Promise<PublicLinkInfo> {
    const doc = await storage.getDocument(docId);
    if (!doc) {
      throw new PublicDocumentError("Document not found", 404);
    }

    if (doc.ownerId !== userId) {
      throw new PublicDocumentError("Only the document owner can manage public links", 403);
    }

    // Clear the token when disabling to invalidate existing links
    const updatedDoc = await storage.updateDocument(docId, {
      publicLinkEnabled: false,
      publicLinkToken: null,
      publicLinkExpiresAt: null,
      publicLinkCreatedAt: null,
    }, false);

    if (!updatedDoc) {
      throw new PublicDocumentError("Failed to update document", 500);
    }

    console.log(`[PublicDoc] Public link disabled for document ${docId} by user ${userId}`);

    return {
      enabled: false,
      token: null,
      expiresAt: null,
      createdAt: null,
      url: null,
      permission: "view",
    };
  }

  /**
   * Regenerate public link token
   * Creates a new token while keeping the link enabled
   */
  async regenerateToken(
    docId: string,
    userId: string,
    expiresAt?: Date | null
  ): Promise<PublicLinkInfo> {
    const doc = await storage.getDocument(docId);
    if (!doc) {
      throw new PublicDocumentError("Document not found", 404);
    }

    if (doc.ownerId !== userId) {
      throw new PublicDocumentError("Only the document owner can regenerate public links", 403);
    }

    if (!doc.publicLinkEnabled) {
      throw new PublicDocumentError("Public link is not enabled for this document", 400);
    }

    const newToken = this.generateToken();
    const now = new Date();

    const updatedDoc = await storage.updateDocument(docId, {
      publicLinkToken: newToken,
      publicLinkExpiresAt: expiresAt !== undefined ? expiresAt : doc.publicLinkExpiresAt,
      publicLinkCreatedAt: now,
    }, false);

    if (!updatedDoc) {
      throw new PublicDocumentError("Failed to regenerate token", 500);
    }

    console.log(`[PublicDoc] Token regenerated for document ${docId} by user ${userId}`);

    return {
      enabled: true,
      token: newToken,
      expiresAt: expiresAt !== undefined ? expiresAt : doc.publicLinkExpiresAt,
      createdAt: now,
      url: `/public/docs/${newToken}`,
      permission: (doc.publicLinkPermission as "view" | "edit" | "comment" | "edit_comment") || "view",
    };
  }

  /**
   * Update public link expiry
   */
  async updateExpiry(
    docId: string,
    userId: string,
    expiresAt: Date | null
  ): Promise<PublicLinkInfo> {
    const doc = await storage.getDocument(docId);
    if (!doc) {
      throw new PublicDocumentError("Document not found", 404);
    }

    if (doc.ownerId !== userId) {
      throw new PublicDocumentError("Only the document owner can update public link expiry", 403);
    }

    const updatedDoc = await storage.updateDocument(docId, {
      publicLinkExpiresAt: expiresAt,
    }, false);

    if (!updatedDoc) {
      throw new PublicDocumentError("Failed to update expiry", 500);
    }

    return {
      enabled: updatedDoc.publicLinkEnabled || false,
      token: updatedDoc.publicLinkToken || null,
      expiresAt: expiresAt,
      createdAt: updatedDoc.publicLinkCreatedAt || null,
      url: updatedDoc.publicLinkToken ? `/public/docs/${updatedDoc.publicLinkToken}` : null,
      permission: (updatedDoc.publicLinkPermission as "view" | "edit" | "comment" | "edit_comment") || "view",
    };
  }

  /**
   * Get public link info for a document
   */
  async getPublicLinkInfo(docId: string, userId: string): Promise<PublicLinkInfo> {
    const doc = await storage.getDocument(docId);
    if (!doc) {
      throw new PublicDocumentError("Document not found", 404);
    }

    if (doc.ownerId !== userId) {
      throw new PublicDocumentError("Only the document owner can view public link info", 403);
    }

    return {
      enabled: doc.publicLinkEnabled || false,
      token: doc.publicLinkToken || null,
      expiresAt: doc.publicLinkExpiresAt || null,
      createdAt: doc.publicLinkCreatedAt || null,
      url: doc.publicLinkToken ? `/public/docs/${doc.publicLinkToken}` : null,
      permission: (doc.publicLinkPermission as "view" | "edit" | "comment" | "edit_comment") || "view",
    };
  }

  /**
   * Update public link permission
   */
  async updatePermission(
    docId: string,
    userId: string,
    permission: "view" | "edit" | "comment" | "edit_comment"
  ): Promise<PublicLinkInfo> {
    const doc = await storage.getDocument(docId);
    if (!doc) {
      throw new PublicDocumentError("Document not found", 404);
    }

    if (doc.ownerId !== userId) {
      throw new PublicDocumentError("Only the document owner can update public link permission", 403);
    }

    const updatedDoc = await storage.updateDocument(docId, {
      publicLinkPermission: permission,
    }, false);

    if (!updatedDoc) {
      throw new PublicDocumentError("Failed to update permission", 500);
    }

    console.log(`[PublicDoc] Permission updated for document ${docId} to ${permission}`);

    return {
      enabled: updatedDoc.publicLinkEnabled || false,
      token: updatedDoc.publicLinkToken || null,
      expiresAt: updatedDoc.publicLinkExpiresAt || null,
      createdAt: updatedDoc.publicLinkCreatedAt || null,
      url: updatedDoc.publicLinkToken ? `/public/docs/${updatedDoc.publicLinkToken}` : null,
      permission,
    };
  }

  /**
   * Get public document by token
   * Validates token, checks expiry, and logs access
   */
  async getPublicDocument(
    token: string,
    requestInfo: { ip: string; userAgent: string }
  ): Promise<PublicDocumentResponse> {
    // Validate token format (64 hex characters)
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      throw new PublicDocumentError("Invalid token format", 400);
    }

    const doc = await storage.getDocumentByPublicToken(token);
    if (!doc) {
      throw new PublicDocumentError("Document not found", 404);
    }

    // Check if public link is enabled
    if (!doc.publicLinkEnabled) {
      throw new PublicDocumentError("Public link is disabled for this document", 403);
    }

    // Check expiry
    const isExpired = doc.publicLinkExpiresAt && new Date(doc.publicLinkExpiresAt) < new Date();
    if (isExpired) {
      throw new PublicDocumentError("This public link has expired", 410); // 410 Gone
    }

    // Log access
    this.logAccess({
      documentId: doc.id,
      token,
      timestamp: new Date(),
      ip: requestInfo.ip,
      userAgent: requestInfo.userAgent,
    });

    // Get owner info
    const owner = await storage.getUser(doc.ownerId);
    const ownerName = owner?.displayName || "Unknown";

    console.log(`[PublicDoc] Document accessed: ${doc.id} (${doc.title}) from IP: ${requestInfo.ip}`);

    return {
      id: doc.id,
      title: doc.title,
      content: doc.content || "",
      pageStyles: {
        fontStyle: doc.fontStyle || "system",
        fontSize: doc.fontSize || "default",
        pageWidth: doc.pageWidth || "default",
        showLastModified: true,
      },
      updatedAt: doc.updatedAt,
      createdAt: doc.createdAt,
      ownerName,
      expiresAt: doc.publicLinkExpiresAt,
      isExpired: false,
      permission: (doc.publicLinkPermission as "view" | "edit" | "comment" | "edit_comment") || "view",
    };
  }

  /**
   * Log public document access
   */
  private logAccess(entry: AccessLogEntry): void {
    this.accessLog.push(entry);

    // Keep log size bounded
    if (this.accessLog.length > this.MAX_LOG_ENTRIES) {
      this.accessLog = this.accessLog.slice(-this.MAX_LOG_ENTRIES / 2);
    }
  }

  /**
   * Get access logs for a document (for analytics)
   */
  getAccessLogs(docId: string, limit: number = 100): AccessLogEntry[] {
    return this.accessLog
      .filter(log => log.documentId === docId)
      .slice(-limit);
  }

  /**
   * Get cache headers for public document responses
   */
  getCacheHeaders(): Record<string, string> {
    return {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      "Vary": "Accept-Encoding",
    };
  }
}

// ============================================================================
// ERROR CLASS
// ============================================================================

export class PublicDocumentError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "PublicDocumentError";
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const publicDocumentService = new PublicDocumentService();

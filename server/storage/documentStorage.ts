import {
  documents,
  documentComments,
  documentShares,
  users,
  type Document,
  type InsertDocument,
  type UpdateDocument,
  type DocumentComment,
  type InsertDocumentComment,
  type UpdateDocumentComment,
  type DocumentWithOwner,
  type PageTreeNode,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, sql, inArray, isNull, isNotNull, asc, gt, or, like, ne } from "drizzle-orm";
import { wasDeleted, buildOwnerObject, escapeRegex, fetchLastUpdaterMap, getLastUpdaterIds } from "./helpers";

// Helper condition: document is NOT soft-deleted
const notDeleted = isNull(documents.deletedAt);

// Helper condition: document is a ROOT document (has no parent)
// This checks for BOTH null and empty string to handle any data inconsistency
const isRootDocument = or(
  isNull(documents.parentDocumentId),
  eq(documents.parentDocumentId, '')
);

// Pagination options for document queries
export interface PaginationOptions {
  page?: number;
  limit?: number;
  sortField?: 'created_at' | 'updated_at' | 'title' | 'last_viewed_at';
  sortDirection?: 'asc' | 'desc';
  search?: string;
}

// Paginated response with metadata
export interface PaginatedDocuments {
  documents: DocumentWithOwner[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

export interface IDocumentStorage {
  // Documents
  getAllDocuments(): Promise<DocumentWithOwner[]>;
  getDocument(id: string): Promise<Document | undefined>;
  getDocumentByPublicToken(token: string): Promise<Document | undefined>;
  getDocumentsByOwner(ownerId: string): Promise<DocumentWithOwner[]>;
  getDocumentsByOwnerPaginated(ownerId: string, options?: PaginationOptions): Promise<PaginatedDocuments>;
  getDocumentsByCategory(category: 'blank' | 'meeting_notes' | 'project_overview'): Promise<DocumentWithOwner[]>;
  createDocument(doc: InsertDocument): Promise<Document>;
  updateDocument(id: string, updates: UpdateDocument, updateTimestamp?: boolean): Promise<Document | undefined>;
  deleteDocument(id: string): Promise<boolean>;
  updateDocumentLastViewed(id: string): Promise<Document | undefined>;
  getShareCounts(documentIds: string[]): Promise<Map<string, number>>;

  // Document Name Uniqueness
  isDocumentNameUnique(title: string, excludeDocId?: string): Promise<boolean>;
  generateUniqueDocumentName(baseTitle: string): Promise<string>;
  getDocumentByTitle(title: string): Promise<Document | undefined>;

  // Document Sharing
  shareDocument(share: { documentId: string; userId: string; permission: "view" | "edit" | "comment" | "edit_comment"; sharedBy: string }): Promise<any>;
  removeDocumentShare(documentId: string, userId: string): Promise<boolean>;
  getDocumentShares(documentId: string): Promise<any[]>;
  getDocumentShareForUser(documentId: string, userId: string): Promise<{ permission: "view" | "edit" | "comment" | "edit_comment" } | null>;
  getDocumentsSharedWithUser(userId: string): Promise<DocumentWithOwner[]>;
  getDocumentsSharedWithUserPaginated(userId: string, options?: PaginationOptions): Promise<PaginatedDocuments>;
  getAllUserDocumentsPaginated(userId: string, options?: PaginationOptions): Promise<PaginatedDocuments>;
  updateDocumentSharePermission(documentId: string, userId: string, permission: "view" | "edit" | "comment" | "edit_comment"): Promise<any>;
  updateSharedUserLastViewed(documentId: string, userId: string): Promise<any>;

  // Document Comments
  getDocumentComments(documentId: string): Promise<DocumentComment[]>;
  getDocumentComment(id: string): Promise<DocumentComment | undefined>;
  createDocumentComment(comment: InsertDocumentComment): Promise<DocumentComment>;
  updateDocumentComment(id: string, updates: UpdateDocumentComment): Promise<DocumentComment | undefined>;
  deleteDocumentComment(id: string): Promise<boolean>;

  // Document Pages (Hierarchy)
  getDocumentPages(parentDocumentId: string): Promise<Document[]>;
  createDocumentPage(parentDocumentId: string, title: string, ownerId: string): Promise<Document>;
  getPageTree(rootDocumentId: string): Promise<PageTreeNode[]>;
  reorderPage(documentId: string, newOrder: number): Promise<Document | undefined>;
  getRootDocument(documentId: string): Promise<Document | undefined>;
  getShareInDocumentTree(documentId: string, userId: string): Promise<{ permission: "view" | "edit" | "comment" | "edit_comment" } | null>;
  getAllDescendantIds(parentId: string, includeDeleted?: boolean): Promise<string[]>;

  // Trash operations
  restoreDocument(id: string): Promise<boolean>;
  permanentlyDeleteDocument(id: string): Promise<boolean>;
  getDeletedDocumentsByOwner(ownerId: string): Promise<DocumentWithOwner[]>;

  // User lookups (needed by doc controllers)
  getUser(userId: string): Promise<{ id: string; displayName: string; email: string; profilePicture: string | null } | undefined>;
  getUserByEmail(email: string): Promise<{ id: string; displayName: string; email: string; profilePicture: string | null } | undefined>;
  searchUsers(query: string, excludeUserId: string, limit?: number): Promise<{ id: string; displayName: string; email: string; profilePicture: string | null }[]>;

  // Activity logging (stub for audit trail)
  logActivity(entry: any): Promise<void>;
}

export class DocumentStorage implements IDocumentStorage {
  // Documents Implementation
  async getAllDocuments(): Promise<DocumentWithOwner[]> {
    const rows = await db
      .select({
        doc: documents,
        ownerId: users.id,
        ownerDisplayName: users.displayName,
        ownerEmail: users.email,
        ownerProfilePicture: users.profilePicture,
      })
      .from(documents)
      .leftJoin(users, eq(documents.ownerId, users.id))
      .where(notDeleted)
      .orderBy(desc(documents.updatedAt));

    return rows.map(row => ({
      ...row.doc,
      owner: buildOwnerObject(row),
    }));
  }

  async getDocument(id: string): Promise<Document | undefined> {
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, id));
    return doc || undefined;
  }

  async getDocumentByPublicToken(token: string): Promise<Document | undefined> {
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.publicLinkToken, token), notDeleted));
    return doc || undefined;
  }

  async getDocumentsByOwner(ownerId: string): Promise<DocumentWithOwner[]> {
    const rows = await db
      .select({
        doc: documents,
        ownerId: users.id,
        ownerDisplayName: users.displayName,
        ownerEmail: users.email,
        ownerProfilePicture: users.profilePicture,
      })
      .from(documents)
      .leftJoin(users, eq(documents.ownerId, users.id))
      .where(and(eq(documents.ownerId, ownerId), notDeleted, isRootDocument))
      .orderBy(desc(documents.updatedAt));

    const lastUpdaterIds = getLastUpdaterIds(rows.map(r => r.doc));
    const lastUpdaterMap = await fetchLastUpdaterMap(lastUpdaterIds);

    // Get share counts for all documents
    const documentIds = rows.map(r => r.doc.id);
    const shareCounts = await this.getShareCounts(documentIds);

    return rows.map(row => ({
      ...row.doc,
      owner: buildOwnerObject(row),
      lastUpdater: row.doc.lastUpdatedBy ? lastUpdaterMap.get(row.doc.lastUpdatedBy) || null : null,
      shareCount: shareCounts.get(row.doc.id) || 0,
    }));
  }

  async getDocumentsByOwnerPaginated(ownerId: string, options: PaginationOptions = {}): Promise<PaginatedDocuments> {
    const {
      page = 1,
      limit = 20,
      sortField = 'updated_at',
      sortDirection = 'desc',
      search = ''
    } = options;

    const offset = (page - 1) * limit;

    // Build sort order
    const sortColumn = sortField === 'created_at' ? documents.createdAt
      : sortField === 'title' ? documents.title
      : sortField === 'last_viewed_at' ? documents.lastViewedAt
      : documents.updatedAt;
    const orderFn = sortDirection === 'asc' ? asc : desc;

    // Build where conditions - only show root documents (not sub-pages)
    const whereConditions = [eq(documents.ownerId, ownerId), notDeleted, isRootDocument];
    if (search) {
      whereConditions.push(sql`LOWER(${documents.title}) LIKE ${'%' + search.toLowerCase() + '%'}`);
    }

    // Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(documents)
      .where(and(...whereConditions));
    const total = Number(countResult?.count || 0);

    // Get paginated documents
    const rows = await db
      .select({
        doc: documents,
        ownerId: users.id,
        ownerDisplayName: users.displayName,
        ownerEmail: users.email,
        ownerProfilePicture: users.profilePicture,
      })
      .from(documents)
      .leftJoin(users, eq(documents.ownerId, users.id))
      .where(and(...whereConditions))
      .orderBy(orderFn(sortColumn))
      .limit(limit)
      .offset(offset);

    const lastUpdaterIds = getLastUpdaterIds(rows.map(r => r.doc));
    const lastUpdaterMap = await fetchLastUpdaterMap(lastUpdaterIds);

    // Get share counts for all documents
    const documentIds = rows.map(r => r.doc.id);
    const shareCounts = await this.getShareCounts(documentIds);

    const docs = rows.map(row => ({
      ...row.doc,
      owner: buildOwnerObject(row),
      lastUpdater: row.doc.lastUpdatedBy ? lastUpdaterMap.get(row.doc.lastUpdatedBy) || null : null,
      shareCount: shareCounts.get(row.doc.id) || 0,
    }));

    const totalPages = Math.ceil(total / limit);

    return {
      documents: docs,
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  async getDocumentsByCategory(category: 'blank' | 'meeting_notes'): Promise<DocumentWithOwner[]> {
    const rows = await db
      .select({
        doc: documents,
        ownerId: users.id,
        ownerDisplayName: users.displayName,
        ownerEmail: users.email,
        ownerProfilePicture: users.profilePicture,
      })
      .from(documents)
      .leftJoin(users, eq(documents.ownerId, users.id))
      .where(and(eq(documents.category, category), notDeleted, isRootDocument))
      .orderBy(desc(documents.updatedAt));

    const lastUpdaterIds = getLastUpdaterIds(rows.map(r => r.doc));
    const lastUpdaterMap = await fetchLastUpdaterMap(lastUpdaterIds);

    // Get share counts for all documents
    const documentIds = rows.map(r => r.doc.id);
    const shareCounts = await this.getShareCounts(documentIds);

    return rows.map(row => ({
      ...row.doc,
      owner: buildOwnerObject(row),
      lastUpdater: row.doc.lastUpdatedBy ? lastUpdaterMap.get(row.doc.lastUpdatedBy) || null : null,
      shareCount: shareCounts.get(row.doc.id) || 0,
    }));
  }

  async createDocument(doc: InsertDocument): Promise<Document> {
    const [newDoc] = await db
      .insert(documents)
      .values(doc)
      .returning();
    return newDoc;
  }

  async updateDocument(id: string, updates: UpdateDocument, updateTimestamp: boolean = false): Promise<Document | undefined> {
    // Only update updatedAt if content or title changed (passed via updateTimestamp flag)
    const setData = updateTimestamp
      ? { ...updates, updatedAt: sql`CURRENT_TIMESTAMP` }
      : { ...updates };

    const [updated] = await db
      .update(documents)
      .set(setData)
      .where(eq(documents.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteDocument(id: string): Promise<boolean> {
    // Soft-delete: set deletedAt on this document and all its children
    const descendantIds = await this.getAllDescendantIds(id);
    const allIds = [id, ...descendantIds];

    const [updated] = await db
      .update(documents)
      .set({ deletedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(inArray(documents.id, allIds), notDeleted))
      .returning();
    return !!updated;
  }

  async updateDocumentLastViewed(id: string): Promise<Document | undefined> {
    const [updated] = await db
      .update(documents)
      .set({ lastViewedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(documents.id, id))
      .returning();
    return updated || undefined;
  }

  // Document Name Uniqueness Implementation
  async isDocumentNameUnique(title: string, excludeDocId?: string): Promise<boolean> {
    // Case-insensitive check for document name
    const normalizedTitle = title.trim().toLowerCase();

    const existingDocs = await db
      .select()
      .from(documents)
      .where(and(sql`LOWER(TRIM(${documents.title})) = ${normalizedTitle}`, notDeleted));

    // If excluding a specific document (for update scenarios)
    if (excludeDocId) {
      const filteredDocs = existingDocs.filter(doc => doc.id !== excludeDocId);
      return filteredDocs.length === 0;
    }

    return existingDocs.length === 0;
  }

  async generateUniqueDocumentName(baseTitle: string): Promise<string> {
    const trimmedTitle = baseTitle.trim();

    // Check if original title is unique
    const isUnique = await this.isDocumentNameUnique(trimmedTitle);
    if (isUnique) {
      return trimmedTitle;
    }

    // Find all documents with similar names (base title or base title with number)
    const normalizedBase = trimmedTitle.toLowerCase();
    const existingDocs = await db
      .select({ title: documents.title })
      .from(documents)
      .where(and(sql`LOWER(TRIM(${documents.title})) LIKE ${normalizedBase + '%'}`, notDeleted));

    // Extract existing numbers from titles like "My Doc (1)", "My Doc (2)", etc.
    const existingNumbers: number[] = [];
    const pattern = new RegExp(`^${escapeRegex(normalizedBase)}\\s*\\((\\d+)\\)$`, 'i');

    for (const doc of existingDocs) {
      const match = doc.title.trim().toLowerCase().match(pattern);
      if (match) {
        existingNumbers.push(parseInt(match[1], 10));
      }
    }

    // Find the next available number
    let nextNumber = 1;
    if (existingNumbers.length > 0) {
      nextNumber = Math.max(...existingNumbers) + 1;
    }

    // Generate unique name
    const uniqueTitle = `${trimmedTitle} (${nextNumber})`;

    // Double-check that the generated name is unique
    const isNewUnique = await this.isDocumentNameUnique(uniqueTitle);
    if (!isNewUnique) {
      // Recursively try with the new title
      return this.generateUniqueDocumentName(uniqueTitle);
    }

    return uniqueTitle;
  }

  async getDocumentByTitle(title: string): Promise<Document | undefined> {
    const normalizedTitle = title.trim().toLowerCase();

    const [doc] = await db
      .select()
      .from(documents)
      .where(and(sql`LOWER(TRIM(${documents.title})) = ${normalizedTitle}`, notDeleted));

    return doc || undefined;
  }

  // Document Comments Implementation
  async getDocumentComments(documentId: string): Promise<DocumentComment[]> {
    const comments = await db
      .select()
      .from(documentComments)
      .where(eq(documentComments.documentId, documentId))
      .orderBy(documentComments.createdAt);
    return comments;
  }

  async getDocumentComment(id: string): Promise<DocumentComment | undefined> {
    const [comment] = await db
      .select()
      .from(documentComments)
      .where(eq(documentComments.id, id));
    return comment || undefined;
  }

  async createDocumentComment(comment: InsertDocumentComment): Promise<DocumentComment> {
    const [newComment] = await db
      .insert(documentComments)
      .values(comment)
      .returning();
    return newComment;
  }

  async updateDocumentComment(id: string, updates: UpdateDocumentComment): Promise<DocumentComment | undefined> {
    const [updated] = await db
      .update(documentComments)
      .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(documentComments.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteDocumentComment(id: string): Promise<boolean> {
    const result = await db.delete(documentComments).where(eq(documentComments.id, id));
    return wasDeleted(result);
  }

  // Get share counts for multiple documents efficiently
  async getShareCounts(documentIds: string[]): Promise<Map<string, number>> {
    if (documentIds.length === 0) {
      return new Map();
    }

    const shareCounts = await db
      .select({
        documentId: documentShares.documentId,
        count: sql<number>`count(*)`,
      })
      .from(documentShares)
      .where(inArray(documentShares.documentId, documentIds))
      .groupBy(documentShares.documentId);

    return new Map(shareCounts.map(s => [s.documentId, Number(s.count)]));
  }

  // Document Sharing Implementation
  async shareDocument(share: { documentId: string; userId: string; permission: "view" | "edit" | "comment" | "edit_comment"; sharedBy: string }): Promise<any> {
    // Check if share already exists
    const existing = await db
      .select()
      .from(documentShares)
      .where(and(
        eq(documentShares.documentId, share.documentId),
        eq(documentShares.userId, share.userId)
      ));

    if (existing.length > 0) {
      // Update existing share permission
      const [updated] = await db
        .update(documentShares)
        .set({ permission: share.permission })
        .where(and(
          eq(documentShares.documentId, share.documentId),
          eq(documentShares.userId, share.userId)
        ))
        .returning();
      return updated;
    }

    // Create new share
    const [newShare] = await db
      .insert(documentShares)
      .values({
        documentId: share.documentId,
        userId: share.userId,
        permission: share.permission,
        sharedBy: share.sharedBy
      })
      .returning();

    // Update document isShared flag
    await db
      .update(documents)
      .set({ isShared: true })
      .where(eq(documents.id, share.documentId));

    return newShare;
  }

  async removeDocumentShare(documentId: string, userId: string): Promise<boolean> {
    const result = await db
      .delete(documentShares)
      .where(and(
        eq(documentShares.documentId, documentId),
        eq(documentShares.userId, userId)
      ));

    // Check if there are any remaining shares
    const remainingShares = await db
      .select()
      .from(documentShares)
      .where(eq(documentShares.documentId, documentId));

    // Update document isShared flag if no more shares
    if (remainingShares.length === 0) {
      await db
        .update(documents)
        .set({ isShared: false })
        .where(eq(documents.id, documentId));
    }

    return wasDeleted(result);
  }

  async getDocumentShares(documentId: string): Promise<any[]> {
    const shares = await db
      .select({
        id: documentShares.id,
        documentId: documentShares.documentId,
        userId: documentShares.userId,
        permission: documentShares.permission,
        sharedBy: documentShares.sharedBy,
        sharedAt: documentShares.sharedAt,
        user: {
          id: users.id,
          displayName: users.displayName,
          email: users.email,
          profilePicture: users.profilePicture
        }
      })
      .from(documentShares)
      .leftJoin(users, eq(documentShares.userId, users.id))
      .where(eq(documentShares.documentId, documentId));

    return shares;
  }

  async getDocumentShareForUser(documentId: string, userId: string): Promise<{ permission: "view" | "edit" | "comment" | "edit_comment" } | null> {
    const [share] = await db
      .select({
        permission: documentShares.permission
      })
      .from(documentShares)
      .where(and(
        eq(documentShares.documentId, documentId),
        eq(documentShares.userId, userId)
      ));

    return share || null;
  }

  async updateDocumentSharePermission(documentId: string, userId: string, permission: "view" | "edit" | "comment" | "edit_comment"): Promise<any> {
    const [updated] = await db
      .update(documentShares)
      .set({ permission })
      .where(and(
        eq(documentShares.documentId, documentId),
        eq(documentShares.userId, userId)
      ))
      .returning();
    return updated || undefined;
  }

  async updateSharedUserLastViewed(documentId: string, userId: string): Promise<any> {
    const [updated] = await db
      .update(documentShares)
      .set({ lastViewedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(
        eq(documentShares.documentId, documentId),
        eq(documentShares.userId, userId)
      ))
      .returning();
    return updated || undefined;
  }

  async getDocumentsSharedWithUser(userId: string): Promise<DocumentWithOwner[]> {
    // Get all document shares for this user with their lastViewedAt
    const sharedDocs = await db
      .select({
        documentId: documentShares.documentId,
        permission: documentShares.permission,
        sharedUserLastViewedAt: documentShares.lastViewedAt
      })
      .from(documentShares)
      .where(eq(documentShares.userId, userId));

    if (sharedDocs.length === 0) {
      return [];
    }

    // Create a map of documentId to shared user's lastViewedAt
    const shareInfoMap = new Map(sharedDocs.map(s => [s.documentId, s.sharedUserLastViewedAt]));

    // Get the actual documents with owner info - only root documents (not sub-pages)
    const documentIds = sharedDocs.map(s => s.documentId);
    const docsWithOwner = await db
      .select({
        id: documents.id,
        title: documents.title,
        content: documents.content,
        ownerId: documents.ownerId,
        category: documents.category,
        tags: documents.tags,
        fontStyle: documents.fontStyle,
        fontSize: documents.fontSize,
        pageWidth: documents.pageWidth,
        backgroundColor: documents.backgroundColor,
        textColor: documents.textColor,
        headingColor: documents.headingColor,
        h1Color: documents.h1Color,
        h2Color: documents.h2Color,
        h3Color: documents.h3Color,
        h4Color: documents.h4Color,
        h5Color: documents.h5Color,
        h6Color: documents.h6Color,
        linkColor: documents.linkColor,
        codeBlockBg: documents.codeBlockBg,
        codeBlockText: documents.codeBlockText,
        blockquoteBg: documents.blockquoteBg,
        blockquoteText: documents.blockquoteText,
        tableBorderColor: documents.tableBorderColor,
        tableHeaderBg: documents.tableHeaderBg,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
        lastViewedAt: documents.lastViewedAt,
        isFavorite: documents.isFavorite,
        isPinned: documents.isPinned,
        isShared: documents.isShared,
        isProtected: documents.isProtected,
        showPageOutline: documents.showPageOutline,
        lastUpdatedBy: documents.lastUpdatedBy,
        owner: {
          id: users.id,
          displayName: users.displayName,
          email: users.email,
          profilePicture: users.profilePicture
        }
      })
      .from(documents)
      .leftJoin(users, eq(documents.ownerId, users.id))
      .where(and(inArray(documents.id, documentIds), notDeleted, isRootDocument));

    const lastUpdaterIds = getLastUpdaterIds(docsWithOwner);
    const lastUpdaterMap = await fetchLastUpdaterMap(lastUpdaterIds);

    // Get share counts for all documents (shared docs don't need shareCount for the viewer, but keeping consistent)
    const shareCounts = await this.getShareCounts(documentIds);

    // Override lastViewedAt with the shared user's own view time
    return docsWithOwner.map(doc => ({
      ...doc,
      lastViewedAt: shareInfoMap.get(doc.id) || null, // Use shared user's lastViewedAt
      lastUpdater: doc.lastUpdatedBy ? lastUpdaterMap.get(doc.lastUpdatedBy) || null : null,
      shareCount: shareCounts.get(doc.id) || 0,
    })) as DocumentWithOwner[];
  }

  async getDocumentsSharedWithUserPaginated(userId: string, options: PaginationOptions = {}): Promise<PaginatedDocuments> {
    const {
      page = 1,
      limit = 20,
      sortField = 'updated_at',
      sortDirection = 'desc',
      search = ''
    } = options;

    const offset = (page - 1) * limit;

    // Build sort column reference
    const sortColumn = sortField === 'created_at' ? documents.createdAt
      : sortField === 'title' ? documents.title
      : sortField === 'last_viewed_at' ? documents.lastViewedAt
      : documents.updatedAt;
    const orderFn = sortDirection === 'asc' ? asc : desc;

    // Get shared document IDs first
    const sharedDocs = await db
      .select({
        documentId: documentShares.documentId,
        sharedUserLastViewedAt: documentShares.lastViewedAt
      })
      .from(documentShares)
      .where(eq(documentShares.userId, userId));

    if (sharedDocs.length === 0) {
      return { documents: [], total: 0, page, limit, totalPages: 0, hasMore: false };
    }

    const shareInfoMap = new Map(sharedDocs.map(s => [s.documentId, s.sharedUserLastViewedAt]));
    const documentIds = sharedDocs.map(s => s.documentId);

    // Build where conditions for search - only show root documents (not sub-pages)
    const whereConditions = [inArray(documents.id, documentIds), notDeleted, isRootDocument];
    if (search) {
      whereConditions.push(sql`LOWER(${documents.title}) LIKE ${'%' + search.toLowerCase() + '%'}`);
    }

    // Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(documents)
      .where(and(...whereConditions));
    const total = Number(countResult?.count || 0);

    // Get paginated documents
    const rows = await db
      .select({
        id: documents.id,
        title: documents.title,
        content: documents.content,
        ownerId: documents.ownerId,
        category: documents.category,
        tags: documents.tags,
        fontStyle: documents.fontStyle,
        fontSize: documents.fontSize,
        pageWidth: documents.pageWidth,
        backgroundColor: documents.backgroundColor,
        textColor: documents.textColor,
        headingColor: documents.headingColor,
        h1Color: documents.h1Color,
        h2Color: documents.h2Color,
        h3Color: documents.h3Color,
        h4Color: documents.h4Color,
        h5Color: documents.h5Color,
        h6Color: documents.h6Color,
        linkColor: documents.linkColor,
        codeBlockBg: documents.codeBlockBg,
        codeBlockText: documents.codeBlockText,
        blockquoteBg: documents.blockquoteBg,
        blockquoteText: documents.blockquoteText,
        tableBorderColor: documents.tableBorderColor,
        tableHeaderBg: documents.tableHeaderBg,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
        lastViewedAt: documents.lastViewedAt,
        isFavorite: documents.isFavorite,
        isPinned: documents.isPinned,
        isShared: documents.isShared,
        isProtected: documents.isProtected,
        showPageOutline: documents.showPageOutline,
        lastUpdatedBy: documents.lastUpdatedBy,
        owner: {
          id: users.id,
          displayName: users.displayName,
          email: users.email,
          profilePicture: users.profilePicture
        }
      })
      .from(documents)
      .leftJoin(users, eq(documents.ownerId, users.id))
      .where(and(...whereConditions))
      .orderBy(orderFn(sortColumn))
      .limit(limit)
      .offset(offset);

    const lastUpdaterIds = getLastUpdaterIds(rows);
    const lastUpdaterMap = await fetchLastUpdaterMap(lastUpdaterIds);

    // Get share counts for all documents
    const allDocIds = rows.map(r => r.id);
    const shareCounts = await this.getShareCounts(allDocIds);

    const docs = rows.map(doc => ({
      ...doc,
      lastViewedAt: shareInfoMap.get(doc.id) || null,
      lastUpdater: doc.lastUpdatedBy ? lastUpdaterMap.get(doc.lastUpdatedBy) || null : null,
      shareCount: shareCounts.get(doc.id) || 0,
    })) as DocumentWithOwner[];

    const totalPages = Math.ceil(total / limit);

    return {
      documents: docs,
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  async getAllUserDocumentsPaginated(userId: string, options: PaginationOptions = {}): Promise<PaginatedDocuments> {
    const {
      page = 1,
      limit = 20,
      sortField = 'updated_at',
      sortDirection = 'desc',
      search = ''
    } = options;

    const offset = (page - 1) * limit;

    // Build sort column reference
    const sortColumn = sortField === 'created_at' ? documents.createdAt
      : sortField === 'title' ? documents.title
      : sortField === 'last_viewed_at' ? documents.lastViewedAt
      : documents.updatedAt;
    const orderFn = sortDirection === 'asc' ? asc : desc;

    // Get owned document IDs (exclude soft-deleted)
    const ownedDocs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.ownerId, userId), notDeleted));

    // Get shared document IDs
    const sharedDocs = await db
      .select({
        documentId: documentShares.documentId,
        sharedUserLastViewedAt: documentShares.lastViewedAt
      })
      .from(documentShares)
      .where(eq(documentShares.userId, userId));

    const shareInfoMap = new Map(sharedDocs.map(s => [s.documentId, s.sharedUserLastViewedAt]));
    const allDocumentIds = [...new Set([...ownedDocs.map(d => d.id), ...sharedDocs.map(s => s.documentId)])];

    if (allDocumentIds.length === 0) {
      return { documents: [], total: 0, page, limit, totalPages: 0, hasMore: false };
    }

    // Build where conditions - only show root documents (not sub-pages)
    const whereConditions = [inArray(documents.id, allDocumentIds), notDeleted, isRootDocument];
    if (search) {
      whereConditions.push(sql`LOWER(${documents.title}) LIKE ${'%' + search.toLowerCase() + '%'}`);
    }

    // Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(documents)
      .where(and(...whereConditions));
    const total = Number(countResult?.count || 0);

    // Get paginated documents
    const rows = await db
      .select({
        doc: documents,
        ownerId: users.id,
        ownerDisplayName: users.displayName,
        ownerEmail: users.email,
        ownerProfilePicture: users.profilePicture,
      })
      .from(documents)
      .leftJoin(users, eq(documents.ownerId, users.id))
      .where(and(...whereConditions))
      .orderBy(orderFn(sortColumn))
      .limit(limit)
      .offset(offset);

    const lastUpdaterIds = getLastUpdaterIds(rows.map(r => r.doc));
    const lastUpdaterMap = await fetchLastUpdaterMap(lastUpdaterIds);

    // Get share counts for all documents
    const documentIds = rows.map(r => r.doc.id);
    const shareCounts = await this.getShareCounts(documentIds);

    const docs = rows.map(row => {
      const isSharedDoc = row.doc.ownerId !== userId;
      return {
        ...row.doc,
        owner: buildOwnerObject(row),
        lastViewedAt: isSharedDoc ? (shareInfoMap.get(row.doc.id) || null) : row.doc.lastViewedAt,
        lastUpdater: row.doc.lastUpdatedBy ? lastUpdaterMap.get(row.doc.lastUpdatedBy) || null : null,
        shareCount: shareCounts.get(row.doc.id) || 0,
      };
    });

    const totalPages = Math.ceil(total / limit);

    return {
      documents: docs,
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  // Document Pages (Hierarchy) Implementation
  async getDocumentPages(parentDocumentId: string): Promise<Document[]> {
    const pages = await db
      .select()
      .from(documents)
      .where(and(eq(documents.parentDocumentId, parentDocumentId), notDeleted))
      .orderBy(asc(documents.pageOrder));
    return pages;
  }

  async createDocumentPage(parentDocumentId: string, title: string, ownerId: string): Promise<Document> {
    // Get the next page order for this parent
    const existingPages = await this.getDocumentPages(parentDocumentId);
    const nextOrder = existingPages.length > 0
      ? Math.max(...existingPages.map(p => p.pageOrder || 0)) + 1
      : 0;

    const [newPage] = await db
      .insert(documents)
      .values({
        title,
        ownerId,
        parentDocumentId,
        pageOrder: nextOrder,
        content: "",
        category: "blank",
      })
      .returning();

    return newPage;
  }

  async getPageTree(rootDocumentId: string): Promise<PageTreeNode[]> {
    // Get all descendants of a document recursively
    const buildTree = async (parentId: string): Promise<PageTreeNode[]> => {
      const children = await db
        .select({
          id: documents.id,
          title: documents.title,
          pageOrder: documents.pageOrder,
          parentDocumentId: documents.parentDocumentId,
        })
        .from(documents)
        .where(and(eq(documents.parentDocumentId, parentId), notDeleted))
        .orderBy(asc(documents.pageOrder));

      const nodes: PageTreeNode[] = [];
      for (const child of children) {
        const grandchildren = await buildTree(child.id);
        nodes.push({
          id: child.id,
          title: child.title,
          pageOrder: child.pageOrder || 0,
          parentDocumentId: child.parentDocumentId,
          children: grandchildren,
        });
      }
      return nodes;
    };

    return buildTree(rootDocumentId);
  }

  async reorderPage(documentId: string, newOrder: number): Promise<Document | undefined> {
    const [updated] = await db
      .update(documents)
      .set({ pageOrder: newOrder })
      .where(eq(documents.id, documentId))
      .returning();
    return updated || undefined;
  }

  async getRootDocument(documentId: string): Promise<Document | undefined> {
    // Traverse up the hierarchy to find the root document
    let currentDoc = await this.getDocument(documentId);

    while (currentDoc && currentDoc.parentDocumentId) {
      currentDoc = await this.getDocument(currentDoc.parentDocumentId);
    }

    return currentDoc;
  }

  async getShareInDocumentTree(documentId: string, userId: string): Promise<{ permission: "view" | "edit" | "comment" | "edit_comment" } | null> {
    // 1. Check direct share on this document
    const directShare = await this.getDocumentShareForUser(documentId, userId);
    if (directShare) return directShare;

    // 2. Find the root document
    const rootDoc = await this.getRootDocument(documentId);
    if (!rootDoc) return null;

    // 3. Check share on root (if different from current doc)
    if (rootDoc.id !== documentId) {
      const rootShare = await this.getDocumentShareForUser(rootDoc.id, userId);
      if (rootShare) return rootShare;
    }

    // 4. Check shares on all child documents of the root
    const allChildren = await this.getAllDescendantIds(rootDoc.id);
    for (const childId of allChildren) {
      if (childId === documentId) continue; // already checked
      const childShare = await this.getDocumentShareForUser(childId, userId);
      if (childShare) return childShare;
    }

    return null;
  }

  async getAllDescendantIds(parentId: string, includeDeleted: boolean = false): Promise<string[]> {
    const whereCondition = includeDeleted
      ? eq(documents.parentDocumentId, parentId)
      : and(eq(documents.parentDocumentId, parentId), notDeleted);

    const children = await db
      .select({ id: documents.id })
      .from(documents)
      .where(whereCondition);

    const ids: string[] = children.map(c => c.id);
    for (const child of children) {
      const grandChildren = await this.getAllDescendantIds(child.id, includeDeleted);
      ids.push(...grandChildren);
    }
    return ids;
  }

  // Trash operations
  async restoreDocument(id: string): Promise<boolean> {
    // Restore this document and all its children
    const descendantIds = await this.getAllDescendantIds(id, true);
    const allIds = [id, ...descendantIds];

    const [updated] = await db
      .update(documents)
      .set({ deletedAt: null })
      .where(and(inArray(documents.id, allIds), isNotNull(documents.deletedAt)))
      .returning();
    return !!updated;
  }

  async permanentlyDeleteDocument(id: string): Promise<boolean> {
    // Get all descendant IDs (including deleted)
    const descendantIds = await this.getAllDescendantIds(id, true);
    const allIds = [id, ...descendantIds];

    // Delete comments for all documents in the tree
    await db.delete(documentComments).where(inArray(documentComments.documentId, allIds));

    // Delete shares for all documents in the tree
    await db.delete(documentShares).where(inArray(documentShares.documentId, allIds));

    // Delete children first, then the document
    if (descendantIds.length > 0) {
      await db.delete(documents).where(inArray(documents.id, descendantIds));
    }

    const result = await db.delete(documents).where(eq(documents.id, id));
    return wasDeleted(result);
  }

  async getDeletedDocumentsByOwner(ownerId: string): Promise<DocumentWithOwner[]> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const rows = await db
      .select({
        doc: documents,
        ownerId: users.id,
        ownerDisplayName: users.displayName,
        ownerEmail: users.email,
        ownerProfilePicture: users.profilePicture,
      })
      .from(documents)
      .leftJoin(users, eq(documents.ownerId, users.id))
      .where(and(
        eq(documents.ownerId, ownerId),
        isNotNull(documents.deletedAt),
        gt(documents.deletedAt, thirtyDaysAgo),
        isRootDocument, // Only show root docs in trash
      ))
      .orderBy(desc(documents.deletedAt));

    return rows.map(row => ({
      ...row.doc,
      owner: buildOwnerObject(row),
    }));
  }

  // User lookup helpers (used by doc controllers for sharing, activity logging, etc.)

  async getUser(userId: string): Promise<{ id: string; displayName: string; email: string; profilePicture: string | null } | undefined> {
    const [user] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        profilePicture: users.profilePicture,
      })
      .from(users)
      .where(eq(users.id, userId));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<{ id: string; displayName: string; email: string; profilePicture: string | null } | undefined> {
    const [user] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        profilePicture: users.profilePicture,
      })
      .from(users)
      .where(eq(users.email, email));
    return user || undefined;
  }

  async searchUsers(
    query: string,
    excludeUserId: string,
    limit: number = 10
  ): Promise<{ id: string; displayName: string; email: string; profilePicture: string | null }[]> {
    const pattern = `%${query.toLowerCase()}%`;
    const results = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        profilePicture: users.profilePicture,
      })
      .from(users)
      .where(
        and(
          ne(users.id, excludeUserId),
          or(
            sql`LOWER(${users.displayName}) LIKE ${pattern}`,
            sql`LOWER(${users.email}) LIKE ${pattern}`
          )
        )
      )
      .limit(limit);
    return results;
  }

  async logActivity(entry: any): Promise<void> {
    // Stub: forward to console so callers don't break while full audit logging
    // lives in the main storage (server/storage.ts).
    console.log("[DocumentStorage.logActivity]", entry);
  }
}

export const documentStorage = new DocumentStorage();

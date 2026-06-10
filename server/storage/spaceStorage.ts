import {
  documentSpaces,
  documentSpaceMembers,
  documents,
  type DocumentSpace,
  type InsertDocumentSpace,
  type UpdateDocumentSpace,
  type DocumentSpaceWithMeta,
  type InsertDocumentSpaceMember,
  type DocumentSpaceMember,
  type Document,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, sql, isNull, inArray } from "drizzle-orm";
import { documentStorage } from "./documentStorage";

export interface ISpaceStorage {
  // Space CRUD
  getAllSpaces(userId: string): Promise<DocumentSpace[]>;
  getSpaceById(id: string): Promise<DocumentSpace | undefined>;
  getSpaceTree(userId: string): Promise<DocumentSpaceWithMeta[]>;
  getChildSpaces(parentId: string): Promise<DocumentSpace[]>;
  createSpace(space: InsertDocumentSpace): Promise<DocumentSpace>;
  updateSpace(id: string, updates: UpdateDocumentSpace): Promise<DocumentSpace | undefined>;
  deleteSpace(id: string): Promise<boolean>;

  // Space membership
  addDocumentToSpace(spaceId: string, documentId: string): Promise<DocumentSpaceMember>;
  removeDocumentFromSpace(spaceId: string, documentId: string): Promise<boolean>;
  getDocumentsInSpace(spaceId: string): Promise<string[]>;
  getSpacesForDocument(documentId: string): Promise<DocumentSpace[]>;
  moveDocumentToSpace(documentId: string, fromSpaceId: string | null, toSpaceId: string): Promise<void>;

  // Document access (delegated to documentStorage)
  getDocument(id: string): Promise<Document | undefined>;
  getShareInDocumentTree(documentId: string, userId: string): Promise<{ permission: "view" | "edit" | "comment" | "edit_comment" } | null>;
}

export class SpaceStorage implements ISpaceStorage {
  async getAllSpaces(userId: string): Promise<DocumentSpace[]> {
    return db
      .select()
      .from(documentSpaces)
      .where(eq(documentSpaces.ownerId, userId))
      .orderBy(documentSpaces.sortOrder, documentSpaces.name);
  }

  async getSpaceById(id: string): Promise<DocumentSpace | undefined> {
    const [space] = await db
      .select()
      .from(documentSpaces)
      .where(eq(documentSpaces.id, id));
    return space;
  }

  async getSpaceTree(userId: string): Promise<DocumentSpaceWithMeta[]> {
    // Get all spaces for the user
    const spaces = await this.getAllSpaces(userId);

    // Get document counts for each space
    const spaceCounts = await db
      .select({
        spaceId: documentSpaceMembers.spaceId,
        count: sql<number>`count(*)::int`,
      })
      .from(documentSpaceMembers)
      .where(inArray(documentSpaceMembers.spaceId, spaces.map(s => s.id)))
      .groupBy(documentSpaceMembers.spaceId);

    const countMap = new Map(spaceCounts.map(sc => [sc.spaceId, sc.count]));

    // Build the tree structure
    const buildTree = (parentId: string | null): DocumentSpaceWithMeta[] => {
      return spaces
        .filter(s => s.parentSpaceId === parentId)
        .map(space => ({
          ...space,
          documentCount: countMap.get(space.id) || 0,
          children: buildTree(space.id),
        }))
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    };

    return buildTree(null);
  }

  async getChildSpaces(parentId: string): Promise<DocumentSpace[]> {
    return db
      .select()
      .from(documentSpaces)
      .where(eq(documentSpaces.parentSpaceId, parentId))
      .orderBy(documentSpaces.sortOrder, documentSpaces.name);
  }

  async createSpace(space: InsertDocumentSpace): Promise<DocumentSpace> {
    const [newSpace] = await db
      .insert(documentSpaces)
      .values(space)
      .returning();
    return newSpace;
  }

  async updateSpace(id: string, updates: UpdateDocumentSpace): Promise<DocumentSpace | undefined> {
    const [updated] = await db
      .update(documentSpaces)
      .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(documentSpaces.id, id))
      .returning();
    return updated;
  }

  async deleteSpace(id: string): Promise<boolean> {
    // First, remove all document associations
    await db
      .delete(documentSpaceMembers)
      .where(eq(documentSpaceMembers.spaceId, id));

    // Move child spaces to parent (or make them root)
    const space = await this.getSpaceById(id);
    if (space) {
      await db
        .update(documentSpaces)
        .set({ parentSpaceId: space.parentSpaceId })
        .where(eq(documentSpaces.parentSpaceId, id));
    }

    // Delete the space
    const result = await db
      .delete(documentSpaces)
      .where(eq(documentSpaces.id, id));
    return (result as any).rowCount > 0;
  }

  async addDocumentToSpace(spaceId: string, documentId: string): Promise<DocumentSpaceMember> {
    // Check if already exists
    const [existing] = await db
      .select()
      .from(documentSpaceMembers)
      .where(and(
        eq(documentSpaceMembers.spaceId, spaceId),
        eq(documentSpaceMembers.documentId, documentId)
      ));

    if (existing) {
      return existing;
    }

    const [member] = await db
      .insert(documentSpaceMembers)
      .values({ spaceId, documentId })
      .returning();
    return member;
  }

  async removeDocumentFromSpace(spaceId: string, documentId: string): Promise<boolean> {
    const result = await db
      .delete(documentSpaceMembers)
      .where(and(
        eq(documentSpaceMembers.spaceId, spaceId),
        eq(documentSpaceMembers.documentId, documentId)
      ));
    return (result as any).rowCount > 0;
  }

  async getDocumentsInSpace(spaceId: string): Promise<string[]> {
    const members = await db
      .select({ documentId: documentSpaceMembers.documentId })
      .from(documentSpaceMembers)
      .where(eq(documentSpaceMembers.spaceId, spaceId));
    return members.map(m => m.documentId);
  }

  async getSpacesForDocument(documentId: string): Promise<DocumentSpace[]> {
    const members = await db
      .select({ spaceId: documentSpaceMembers.spaceId })
      .from(documentSpaceMembers)
      .where(eq(documentSpaceMembers.documentId, documentId));

    if (members.length === 0) return [];

    const spaceIds = members.map(m => m.spaceId);
    return db
      .select()
      .from(documentSpaces)
      .where(inArray(documentSpaces.id, spaceIds));
  }

  async moveDocumentToSpace(
    documentId: string,
    fromSpaceId: string | null,
    toSpaceId: string
  ): Promise<void> {
    // Remove from old space if specified
    if (fromSpaceId) {
      await this.removeDocumentFromSpace(fromSpaceId, documentId);
    }

    // Add to new space
    await this.addDocumentToSpace(toSpaceId, documentId);
  }

  // Document access — delegated to documentStorage so spaces controller
  // doesn't need a separate import.
  async getDocument(id: string): Promise<Document | undefined> {
    return documentStorage.getDocument(id);
  }

  async getShareInDocumentTree(
    documentId: string,
    userId: string
  ): Promise<{ permission: "view" | "edit" | "comment" | "edit_comment" } | null> {
    return documentStorage.getShareInDocumentTree(documentId, userId);
  }
}

export const spaceStorage = new SpaceStorage();

import {
  documentVersions,
  users,
  type DocumentVersion,
  type DocumentVersionWithCreator,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, sql, count } from "drizzle-orm";

export interface IVersionStorage {
  createDocumentVersion(version: {
    documentId: string;
    title: string;
    content: string;
    createdBy: string;
    versionNumber: number;
    changeType: string;
    wordCount: number;
  }): Promise<DocumentVersion>;
  getDocumentVersions(documentId: string, limit?: number, offset?: number): Promise<{ versions: DocumentVersionWithCreator[]; total: number }>;
  getDocumentVersion(versionId: string): Promise<DocumentVersion | undefined>;
  getLatestVersion(documentId: string): Promise<DocumentVersion | undefined>;
  getNextVersionNumber(documentId: string): Promise<number>;
  deleteVersionsByDocumentId(documentId: string): Promise<void>;
  getVersionCount(documentId: string): Promise<number>;
}

export class VersionStorage implements IVersionStorage {
  async createDocumentVersion(version: {
    documentId: string;
    title: string;
    content: string;
    createdBy: string;
    versionNumber: number;
    changeType: string;
    wordCount: number;
  }): Promise<DocumentVersion> {
    const [created] = await db.insert(documentVersions).values(version).returning();
    return created;
  }

  async getDocumentVersions(documentId: string, limit = 50, offset = 0): Promise<{ versions: DocumentVersionWithCreator[]; total: number }> {
    const [versions, totalResult] = await Promise.all([
      db
        .select({
          id: documentVersions.id,
          documentId: documentVersions.documentId,
          title: documentVersions.title,
          content: documentVersions.content,
          createdBy: documentVersions.createdBy,
          createdAt: documentVersions.createdAt,
          versionNumber: documentVersions.versionNumber,
          changeType: documentVersions.changeType,
          wordCount: documentVersions.wordCount,
          creatorDisplayName: users.displayName,
          creatorProfilePicture: users.profilePicture,
        })
        .from(documentVersions)
        .leftJoin(users, eq(documentVersions.createdBy, users.id))
        .where(eq(documentVersions.documentId, documentId))
        .orderBy(desc(documentVersions.versionNumber))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, documentId)),
    ]);

    const versionsWithCreator: DocumentVersionWithCreator[] = versions.map((v) => ({
      id: v.id,
      documentId: v.documentId,
      title: v.title,
      content: v.content,
      createdBy: v.createdBy,
      createdAt: v.createdAt,
      versionNumber: v.versionNumber,
      changeType: v.changeType,
      wordCount: v.wordCount,
      creator: v.creatorDisplayName
        ? {
            id: v.createdBy,
            displayName: v.creatorDisplayName,
            profilePicture: v.creatorProfilePicture,
          }
        : null,
    }));

    return {
      versions: versionsWithCreator,
      total: totalResult[0]?.count ?? 0,
    };
  }

  async getDocumentVersion(versionId: string): Promise<DocumentVersion | undefined> {
    const [version] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId));
    return version;
  }

  async getLatestVersion(documentId: string): Promise<DocumentVersion | undefined> {
    const [version] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.createdAt))
      .limit(1);
    return version;
  }

  async getNextVersionNumber(documentId: string): Promise<number> {
    const [result] = await db
      .select({ maxVersion: sql<number>`COALESCE(MAX(${documentVersions.versionNumber}), 0)` })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));
    return (result?.maxVersion ?? 0) + 1;
  }

  async deleteVersionsByDocumentId(documentId: string): Promise<void> {
    await db.delete(documentVersions).where(eq(documentVersions.documentId, documentId));
  }

  async getVersionCount(documentId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));
    return result?.count ?? 0;
  }
}

export const versionStorage = new VersionStorage();

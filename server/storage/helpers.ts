import { users } from "@shared/schema";
import { db } from "../db";
import { inArray } from "drizzle-orm";

// Helper function to escape special regex characters
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper: Check if delete was successful
export function wasDeleted(result: { rowCount: number | null }): boolean {
  return result.rowCount !== null && result.rowCount > 0;
}

// Helper: Build owner object from row
export function buildOwnerObject(row: { ownerId: string | null; ownerDisplayName: string | null; ownerEmail: string | null; ownerProfilePicture: string | null }) {
  return row.ownerId ? {
    id: row.ownerId,
    displayName: row.ownerDisplayName!,
    email: row.ownerEmail!,
    profilePicture: row.ownerProfilePicture,
  } : null;
}

// Helper: User info type for document last updater
export type UserInfo = { id: string; displayName: string; email: string; profilePicture: string | null };

// Helper: Fetch lastUpdater info for documents
export async function fetchLastUpdaterMap(lastUpdaterIds: string[]): Promise<Map<string, UserInfo>> {
  if (lastUpdaterIds.length === 0) return new Map();

  const lastUpdaters = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      profilePicture: users.profilePicture,
    })
    .from(users)
    .where(inArray(users.id, lastUpdaterIds));

  return new Map(lastUpdaters.map(u => [u.id, u]));
}

// Helper: Extract unique lastUpdatedBy IDs from rows
export function getLastUpdaterIds<T extends { lastUpdatedBy?: string | null }>(rows: T[]): string[] {
  const ids = rows.filter(r => r.lastUpdatedBy).map(r => r.lastUpdatedBy!);
  return Array.from(new Set(ids));
}

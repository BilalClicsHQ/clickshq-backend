import {
  slackIntegrations,
  slackNotificationLogs,
  slackChannelMappings,
  slackUserNotificationPreferences,
  type SlackIntegration,
  type InsertSlackIntegration,
  type UpdateSlackIntegration,
  type SlackNotificationLog,
  type InsertSlackNotificationLog,
  type UpdateSlackNotificationLog,
  type SlackChannelMapping,
  type InsertSlackChannelMapping,
  type SlackNotificationPreferences,
  type UpdateSlackNotificationPreferences,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, lte, sql } from "drizzle-orm";
import { wasDeleted } from "./helpers";

export class SlackStorage {
  // ==================== INTEGRATIONS ====================

  async getSlackIntegration(teamId: string): Promise<SlackIntegration | undefined> {
    const [integration] = await db
      .select()
      .from(slackIntegrations)
      .where(eq(slackIntegrations.teamId, teamId));
    return integration || undefined;
  }

  async getSlackIntegrationById(id: string): Promise<SlackIntegration | undefined> {
    const [integration] = await db
      .select()
      .from(slackIntegrations)
      .where(eq(slackIntegrations.id, id));
    return integration || undefined;
  }

  async getActiveIntegration(): Promise<SlackIntegration | undefined> {
    const [integration] = await db
      .select()
      .from(slackIntegrations)
      .where(eq(slackIntegrations.isEnabled, true))
      .limit(1);
    return integration || undefined;
  }

  async createSlackIntegration(data: InsertSlackIntegration): Promise<SlackIntegration> {
    const existing = await this.getSlackIntegration(data.teamId);
    if (existing) {
      const [updated] = await db
        .update(slackIntegrations)
        .set({ ...data, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(slackIntegrations.teamId, data.teamId))
        .returning();
      return updated;
    }
    const [integration] = await db
      .insert(slackIntegrations)
      .values(data)
      .returning();
    return integration;
  }

  async updateSlackIntegration(id: string, updates: UpdateSlackIntegration): Promise<SlackIntegration | undefined> {
    const [updated] = await db
      .update(slackIntegrations)
      .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(slackIntegrations.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteSlackIntegration(id: string): Promise<boolean> {
    await db.delete(slackChannelMappings).where(eq(slackChannelMappings.slackIntegrationId, id));
    const result = await db.delete(slackIntegrations).where(eq(slackIntegrations.id, id));
    return wasDeleted(result);
  }

  // ==================== CHANNEL MAPPINGS ====================

  async getChannelMappings(integrationId: string): Promise<SlackChannelMapping[]> {
    return await db
      .select()
      .from(slackChannelMappings)
      .where(eq(slackChannelMappings.slackIntegrationId, integrationId));
  }

  async getChannelMappingForProject(workspaceProjectId: string): Promise<SlackChannelMapping | undefined> {
    const [mapping] = await db
      .select()
      .from(slackChannelMappings)
      .where(eq(slackChannelMappings.workspaceProjectId, workspaceProjectId));
    return mapping || undefined;
  }

  async getChannelMappingForSpace(spaceId: string): Promise<SlackChannelMapping | undefined> {
    const [mapping] = await db
      .select()
      .from(slackChannelMappings)
      .where(eq(slackChannelMappings.spaceId, spaceId));
    return mapping || undefined;
  }

  async createChannelMapping(data: InsertSlackChannelMapping): Promise<SlackChannelMapping> {
    const [mapping] = await db
      .insert(slackChannelMappings)
      .values(data)
      .returning();
    return mapping;
  }

  async deleteChannelMapping(id: string): Promise<boolean> {
    const result = await db.delete(slackChannelMappings).where(eq(slackChannelMappings.id, id));
    return wasDeleted(result);
  }

  // ==================== NOTIFICATION LOGS ====================

  async createNotificationLog(data: InsertSlackNotificationLog): Promise<SlackNotificationLog> {
    const [log] = await db
      .insert(slackNotificationLogs)
      .values(data)
      .returning();
    return log;
  }

  async updateNotificationLog(id: string, updates: UpdateSlackNotificationLog): Promise<SlackNotificationLog | undefined> {
    const [updated] = await db
      .update(slackNotificationLogs)
      .set(updates)
      .where(eq(slackNotificationLogs.id, id))
      .returning();
    return updated || undefined;
  }

  async getPendingRetryNotifications(): Promise<SlackNotificationLog[]> {
    return await db
      .select()
      .from(slackNotificationLogs)
      .where(
        and(
          eq(slackNotificationLogs.status, "failed"),
          lte(slackNotificationLogs.nextRetryAt, sql`CURRENT_TIMESTAMP`),
          sql`${slackNotificationLogs.retryCount} < ${slackNotificationLogs.maxRetries}`
        )
      );
  }

  // ==================== NOTIFICATION PREFERENCES ====================

  async getNotificationPreferences(userId: string): Promise<SlackNotificationPreferences | undefined> {
    const [prefs] = await db
      .select()
      .from(slackUserNotificationPreferences)
      .where(eq(slackUserNotificationPreferences.userId, userId));
    return prefs || undefined;
  }

  async upsertNotificationPreferences(userId: string, updates: UpdateSlackNotificationPreferences): Promise<SlackNotificationPreferences> {
    const existing = await this.getNotificationPreferences(userId);
    if (existing) {
      const [updated] = await db
        .update(slackUserNotificationPreferences)
        .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(slackUserNotificationPreferences.userId, userId))
        .returning();
      return updated;
    }
    const [created] = await db
      .insert(slackUserNotificationPreferences)
      .values({ userId, ...updates })
      .returning();
    return created;
  }
}

export const slackStorage = new SlackStorage();

import {
  documentTemplates,
  type DocumentTemplate,
  type InsertDocumentTemplate,
  type UpdateDocumentTemplate,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, sql, and, or } from "drizzle-orm";

export interface ITemplateStorage {
  getAllTemplates(): Promise<DocumentTemplate[]>;
  getPublicTemplates(): Promise<DocumentTemplate[]>;
  getTemplateById(id: string): Promise<DocumentTemplate | undefined>;
  getTemplatesByCategory(category: string): Promise<DocumentTemplate[]>;
  createTemplate(template: InsertDocumentTemplate): Promise<DocumentTemplate>;
  updateTemplate(id: string, updates: UpdateDocumentTemplate): Promise<DocumentTemplate | undefined>;
  deleteTemplate(id: string): Promise<boolean>;
  incrementUsageCount(id: string): Promise<void>;
  seedDefaultTemplates(): Promise<void>;
}

// Default system templates
const DEFAULT_TEMPLATES: InsertDocumentTemplate[] = [
  {
    title: "Project Overview",
    description: "Summarize goals, scope, and milestones for your project",
    content: JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Project Overview" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goals" }] },
        { type: "paragraph", content: [{ type: "text", text: "Define the main objectives of this project..." }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Scope" }] },
        { type: "paragraph", content: [{ type: "text", text: "Outline what is included and excluded..." }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Milestones" }] },
        { type: "taskList", content: [
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Milestone 1" }] }] },
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Milestone 2" }] }] },
        ]},
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Timeline" }] },
        { type: "paragraph", content: [{ type: "text", text: "Add key dates and deadlines..." }] },
      ]
    }),
    category: "project",
    icon: "project",
    iconColor: "#3B82F6",
    isSystem: true,
    isPublic: true,
    sortOrder: 1,
  },
  {
    title: "Meeting Notes",
    description: "Capture agenda, notes, and action items from meetings",
    content: JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Meeting Notes" }] },
        { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "Date: " }, { type: "text", text: "[Add date]" }] },
        { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "Attendees: " }, { type: "text", text: "[Add attendees]" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Agenda" }] },
        { type: "bulletList", content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Topic 1" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Topic 2" }] }] },
        ]},
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Discussion Notes" }] },
        { type: "paragraph", content: [{ type: "text", text: "Key points discussed..." }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Action Items" }] },
        { type: "taskList", content: [
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Action item 1 - @owner" }] }] },
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Action item 2 - @owner" }] }] },
        ]},
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Next Steps" }] },
        { type: "paragraph", content: [{ type: "text", text: "Next meeting date and follow-up items..." }] },
      ]
    }),
    category: "meeting",
    icon: "meeting",
    iconColor: "#10B981",
    isSystem: true,
    isPublic: true,
    sortOrder: 2,
  },
  {
    title: "Weekly Status Report",
    description: "Track weekly progress, blockers, and upcoming tasks",
    content: JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Weekly Status Report" }] },
        { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "Week of: " }, { type: "text", text: "[Add date range]" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Completed This Week" }] },
        { type: "taskList", content: [
          { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Task completed" }] }] },
        ]},
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "In Progress" }] },
        { type: "taskList", content: [
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Task in progress" }] }] },
        ]},
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Blockers" }] },
        { type: "bulletList", content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Blocker 1" }] }] },
        ]},
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Next Week Plans" }] },
        { type: "bulletList", content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Planned task" }] }] },
        ]},
      ]
    }),
    category: "report",
    icon: "report",
    iconColor: "#8B5CF6",
    isSystem: true,
    isPublic: true,
    sortOrder: 3,
  },
  {
    title: "Bug Report",
    description: "Document bugs with steps to reproduce and expected behavior",
    content: JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Bug Report" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Summary" }] },
        { type: "paragraph", content: [{ type: "text", text: "Brief description of the issue..." }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Environment" }] },
        { type: "bulletList", content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "Browser: " }, { type: "text", text: "[Chrome/Firefox/Safari]" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "OS: " }, { type: "text", text: "[Windows/macOS/Linux]" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "Version: " }, { type: "text", text: "[App version]" }] }] },
        ]},
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps to Reproduce" }] },
        { type: "orderedList", content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Step 1" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Step 2" }] }] },
        ]},
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Expected Behavior" }] },
        { type: "paragraph", content: [{ type: "text", text: "What should happen..." }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Actual Behavior" }] },
        { type: "paragraph", content: [{ type: "text", text: "What actually happens..." }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Screenshots" }] },
        { type: "paragraph", content: [{ type: "text", text: "Add any relevant screenshots..." }] },
      ]
    }),
    category: "development",
    icon: "bug",
    iconColor: "#EF4444",
    isSystem: true,
    isPublic: true,
    sortOrder: 4,
  },
];

export class TemplateStorage implements ITemplateStorage {
  async getAllTemplates(): Promise<DocumentTemplate[]> {
    return db
      .select()
      .from(documentTemplates)
      .orderBy(documentTemplates.sortOrder, desc(documentTemplates.usageCount));
  }

  async getPublicTemplates(): Promise<DocumentTemplate[]> {
    return db
      .select()
      .from(documentTemplates)
      .where(eq(documentTemplates.isPublic, true))
      .orderBy(documentTemplates.sortOrder, desc(documentTemplates.usageCount));
  }

  async getTemplateById(id: string): Promise<DocumentTemplate | undefined> {
    const [template] = await db
      .select()
      .from(documentTemplates)
      .where(eq(documentTemplates.id, id));
    return template;
  }

  async getTemplatesByCategory(category: string): Promise<DocumentTemplate[]> {
    return db
      .select()
      .from(documentTemplates)
      .where(and(
        eq(documentTemplates.category, category),
        eq(documentTemplates.isPublic, true)
      ))
      .orderBy(documentTemplates.sortOrder, desc(documentTemplates.usageCount));
  }

  async createTemplate(template: InsertDocumentTemplate): Promise<DocumentTemplate> {
    const [newTemplate] = await db
      .insert(documentTemplates)
      .values(template)
      .returning();
    return newTemplate;
  }

  async updateTemplate(id: string, updates: UpdateDocumentTemplate): Promise<DocumentTemplate | undefined> {
    const [updated] = await db
      .update(documentTemplates)
      .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(documentTemplates.id, id))
      .returning();
    return updated;
  }

  async deleteTemplate(id: string): Promise<boolean> {
    // Check if it's a system template first
    const template = await this.getTemplateById(id);
    if (template?.isSystem) {
      throw new Error("Cannot delete system templates");
    }

    const result = await db
      .delete(documentTemplates)
      .where(eq(documentTemplates.id, id));
    return (result as any).rowCount > 0;
  }

  async incrementUsageCount(id: string): Promise<void> {
    await db
      .update(documentTemplates)
      .set({ usageCount: sql`${documentTemplates.usageCount} + 1` })
      .where(eq(documentTemplates.id, id));
  }

  async seedDefaultTemplates(): Promise<void> {
    // Check if templates already exist
    const existing = await db
      .select({ count: sql<number>`count(*)` })
      .from(documentTemplates)
      .where(eq(documentTemplates.isSystem, true));

    if (Number(existing[0]?.count || 0) > 0) {
      console.log("[Templates] Default templates already exist, skipping seed");
      return;
    }

    console.log("[Templates] Seeding default templates...");
    for (const template of DEFAULT_TEMPLATES) {
      await this.createTemplate(template);
    }
    console.log("[Templates] Default templates seeded successfully");
  }
}

export const templateStorage = new TemplateStorage();

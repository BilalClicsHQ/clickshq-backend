import type { Request, Response } from "express";
import { templateStorage as storage } from "../../storage/templateStorage";
import { documentStorage } from "../../storage/documentStorage";

/**
 * Get all public document templates
 * GET /api/docs/templates
 */
export async function getTemplatesHandler(req: Request, res: Response) {
  try {
    const { category } = req.query;

    let templates;
    if (category && typeof category === 'string') {
      templates = await storage.getTemplatesByCategory(category);
    } else {
      templates = await storage.getPublicTemplates();
    }

    res.json(templates);
  } catch (error) {
    console.error("[GetTemplates] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to fetch templates", error: errorMessage });
  }
}

/**
 * Get a single template by ID
 * GET /api/docs/templates/:id
 */
export async function getTemplateByIdHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const template = await storage.getTemplateById(id);

    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    res.json(template);
  } catch (error) {
    console.error("[GetTemplateById] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to fetch template", error: errorMessage });
  }
}

/**
 * Create a new template (admin only or custom user templates)
 * POST /api/docs/templates
 */
export async function createTemplateHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { title, description, content, category, icon, iconColor, isPublic } = req.body;

    if (!title) {
      return res.status(400).json({ message: "Title is required" });
    }

    const template = await storage.createTemplate({
      title,
      description,
      content,
      category: category || "general",
      icon,
      iconColor,
      isSystem: false,
      createdBy: userId,
      isPublic: isPublic ?? false,
    });

    res.status(201).json(template);
  } catch (error) {
    console.error("[CreateTemplate] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to create template", error: errorMessage });
  }
}

/**
 * Update a template
 * PATCH /api/docs/templates/:id
 */
export async function updateTemplateHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const template = await storage.getTemplateById(id);

    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    // Only creator or admin can update
    if (template.createdBy !== userId && template.isSystem) {
      return res.status(403).json({ message: "Not authorized to update this template" });
    }

    const { title, description, content, category, icon, iconColor, isPublic } = req.body;

    const updated = await storage.updateTemplate(id, {
      title,
      description,
      content,
      category,
      icon,
      iconColor,
      isPublic,
    });

    res.json(updated);
  } catch (error) {
    console.error("[UpdateTemplate] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to update template", error: errorMessage });
  }
}

/**
 * Delete a template
 * DELETE /api/docs/templates/:id
 */
export async function deleteTemplateHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const template = await storage.getTemplateById(id);

    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    if (template.isSystem) {
      return res.status(403).json({ message: "Cannot delete system templates" });
    }

    if (template.createdBy !== userId) {
      return res.status(403).json({ message: "Not authorized to delete this template" });
    }

    await storage.deleteTemplate(id);
    res.status(204).send();
  } catch (error) {
    console.error("[DeleteTemplate] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to delete template", error: errorMessage });
  }
}

/**
 * Use a template (creates a new document from template)
 * POST /api/docs/templates/:id/use
 */
export async function useTemplateHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const template = await storage.getTemplateById(id);

    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    // Create new document from template
    const document = await documentStorage.createDocument({
      title: template.title,
      content: template.content || "",
      ownerId: userId,
      category: template.category === "meeting" ? "meeting_notes" : "blank",
    });

    // Increment template usage count
    await storage.incrementUsageCount(id);

    res.status(201).json(document);
  } catch (error) {
    console.error("[UseTemplate] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to create document from template", error: errorMessage });
  }
}

/**
 * Seed default templates (admin only, run on startup)
 * POST /api/docs/templates/seed
 */
export async function seedTemplatesHandler(req: Request, res: Response) {
  try {
    await storage.seedDefaultTemplates();
    res.json({ message: "Default templates seeded successfully" });
  } catch (error) {
    console.error("[SeedTemplates] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to seed templates", error: errorMessage });
  }
}

import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";


export async function createDocHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    console.log("[CreateDoc] User ID:", userId);
    console.log("[CreateDoc] Request body:", req.body);

    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const {
      title,
      content,
      category,
      tags,
      fontStyle,
      fontSize,
      pageWidth,
      backgroundColor,
      textColor,
      headingColor,
      h1Color,
      h2Color,
      h3Color,
      h4Color,
      h5Color,
      h6Color,
      linkColor,
      codeBlockBg,
      codeBlockText,
      blockquoteBg,
      blockquoteText,
      tableBorderColor,
      tableHeaderBg,
      showPageOutline
    } = req.body;

    if (!title) {
      return res.status(400).json({ message: "Title is required" });
    }

    const doc = await storage.createDocument({
      title,
      content: content || "",
      ownerId: userId,
      category: category || 'blank',
      tags: tags || [],
      fontStyle: fontStyle || 'system',
      fontSize: fontSize || 'default',
      pageWidth: pageWidth || 'default',
      backgroundColor: backgroundColor || '#ffffff',
      textColor: textColor || '#1f2937',
      headingColor: headingColor || '#111827',
      h1Color: h1Color || '#111827',
      h2Color: h2Color || '#1f2937',
      h3Color: h3Color || '#374151',
      h4Color: h4Color || '#4b5563',
      h5Color: h5Color || '#6b7280',
      h6Color: h6Color || '#9ca3af',
      linkColor: linkColor || '#3b82f6',
      codeBlockBg: codeBlockBg || '#f3f4f6',
      codeBlockText: codeBlockText || '#1f2937',
      blockquoteBg: blockquoteBg || '#f9fafb',
      blockquoteText: blockquoteText || '#4b5563',
      tableBorderColor: tableBorderColor || '#e5e7eb',
      tableHeaderBg: tableHeaderBg || '#f3f4f6',
      showPageOutline: showPageOutline ?? false,
    });

    console.log("[CreateDoc] Document created:", doc.id);
    res.status(201).json(doc);
  } catch (error) {
    console.error("[CreateDoc] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to create document", error: errorMessage });
  }
}

import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import {
  type MulterFile,
  FileValidationError,
  FileParseError,
  validateFile,
  getFileExtension,
  isMulterError,
  parsePDF,
  parseDocx,
  parseXlsx,
  parseTxt,
  parseHtml,
  parseWordXml,
  parseDoc,
  parseOdt,
  parseWithOfficeParser,
  parseAsPlainText,
} from "./docImportUtils";

// Try multiple parsers in order, return first successful result
async function tryParsers(buffer: Buffer, parsers: Array<(buf: Buffer) => Promise<string> | string>): Promise<string> {
  let lastError: unknown;
  for (const parser of parsers) {
    try {
      return await parser(buffer);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// POST /api/docs/import
export async function importDocumentHandler(req: Request & { file?: MulterFile }, res: Response) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const file = req.file;
    const userId = (req.user as any)?.id;

    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    // Validate file first
    const validation = await validateFile(file);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.error });
    }

    const fileExtension = getFileExtension(file.originalname);
    const extractedTitle = file.originalname.replace(/\.[^/.]+$/, "");
    let extractedContent = "";

    // Parse based on file type
    if (fileExtension === ".pdf") {
      extractedContent = await parsePDF(file.buffer);
    } else if ([".docx", ".docm", ".dotx", ".dotm"].includes(fileExtension)) {
      // mammoth → officeparser → plain text extraction
      extractedContent = await tryParsers(file.buffer, [parseDocx, parseWithOfficeParser, parseAsPlainText]);
    } else if (fileExtension === ".xlsx") {
      extractedContent = await parseXlsx(file.buffer);
    } else if (fileExtension === ".txt") {
      extractedContent = parseTxt(file.buffer);
    } else if ([".doc", ".dot"].includes(fileExtension)) {
      // word-extractor → mammoth → officeparser → plain text extraction
      extractedContent = await tryParsers(file.buffer, [parseDoc, parseDocx, parseWithOfficeParser, parseAsPlainText]);
    } else if (fileExtension === ".odt") {
      extractedContent = await tryParsers(file.buffer, [parseOdt, parseAsPlainText]);
    } else if (fileExtension === ".rtf") {
      // officeParser supports RTF natively
      extractedContent = await tryParsers(file.buffer, [parseWithOfficeParser, parseAsPlainText]);
    } else if ([".htm", ".html", ".mht", ".mhtml"].includes(fileExtension)) {
      extractedContent = parseHtml(file.buffer);
    } else if ([".xml", ".xmll"].includes(fileExtension)) {
      extractedContent = await tryParsers(file.buffer, [parseWordXml, parseAsPlainText]);
    }

    // Save to database
    const newDoc = await storage.createDocument({
      title: extractedTitle,
      content: extractedContent,
      ownerId: userId,
      category: "blank",
    });

    res.status(201).json(newDoc);

  } catch (error: unknown) {
    // Log full error details for debugging
    console.error("[DocImport] Error:", error);
    if (error instanceof Error) {
      console.error("[DocImport] Error name:", error.name);
      console.error("[DocImport] Error message:", error.message);
      console.error("[DocImport] Error stack:", error.stack);
    }

    if (error instanceof FileValidationError) {
      return res.status(400).json({ message: error.message });
    }

    if (error instanceof FileParseError) {
      return res.status(422).json({ message: error.message });
    }

    if (isMulterError(error)) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ message: "File size exceeds 10MB limit" });
      }
      return res.status(400).json({ message: error.message });
    }

    // Return actual error message for debugging (in production, you might want to hide this)
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    res.status(500).json({ message: `Failed to import document: ${errorMessage}` });
  }
}

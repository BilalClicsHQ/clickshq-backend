import multer from "multer";
import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";
import * as XLSX from "xlsx";
// @ts-ignore — no type declarations available for word-extractor
import WordExtractor from "word-extractor";
import officeParser from "officeparser";
// pdf-parse, pdfjs-dist, tesseract.js are dynamically imported to avoid loading at startup

// Multer file type
export interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// Multer error interface
export interface MulterErrorType extends Error {
  code?: string;
}

// Allowed extensions — formats we can actively parse
export const ALLOWED_EXTENSIONS = [
  ".pdf", ".docx", ".xlsx",
  // Word ZIP-based variants (mammoth handles all of these)
  ".docm", ".dotx", ".dotm",
  // Legacy Word 97-2003 (word-extractor handles these)
  ".doc", ".dot",
  // OpenDocument
  ".odt",
  // Rich Text Format (officeParser handles this)
  ".rtf",
  // Plain text / HTML
  ".txt", ".htm", ".html", ".mht", ".mhtml",
  // Word XML
  ".xml", ".xmll",
];

// Formats we recognise but cannot parse — give a helpful conversion message
export const UNSUPPORTED_WITH_HINT: Record<string, string> = {
  ".xps":  "XPS format is not supported. Please convert to PDF or .docx first.",
  ".xls":  "Old .xls format is not supported. Please convert to .xlsx first.",
};

// Sanitize HTML config - XSS protection
export const sanitizeConfig: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "b", "i", "u", "strong", "em",
    "a", "ul", "ol", "li", "br", "span", "table",
    "thead", "tbody", "tr", "th", "td"
  ],
  allowedAttributes: {
    a: ["href"],
    span: ["style"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https"],
};

// Custom error classes
export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}

export class FileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileParseError";
  }
}

// Multer config - accepts any file for validation
export const uploadForValidation = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // Max 10MB
  },
});

// Multer config - PDF, DOCX, XLSX for import
export const uploadForImport = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // Max 10MB
  },
  fileFilter: (_req: Express.Request, file: MulterFile, cb: multer.FileFilterCallback) => {
    const fileExtension = "." + file.originalname.split(".").pop()?.toLowerCase();

    // Known but unsupported format — give helpful hint
    const hint = UNSUPPORTED_WITH_HINT[fileExtension];
    if (hint) {
      cb(new FileValidationError(hint));
      return;
    }

    if (ALLOWED_EXTENSIONS.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new FileValidationError(`File type '${fileExtension}' is not supported. Supported: PDF, DOCX, DOC, XLSX, ODT, TXT, HTML, and Word variants.`));
    }
  },
});

// Get file extension helper
export function getFileExtension(filename: string): string {
  return "." + filename.split(".").pop()?.toLowerCase();
}

// Map extension to expected type key
export function extensionToType(ext: string): "pdf" | "docx" | "xlsx" | "txt" | "html" | "xml" | "doc" | "odt" | "rtf" | null {
  const map: Record<string, "pdf" | "docx" | "xlsx" | "txt" | "html" | "xml" | "doc" | "odt" | "rtf"> = {
    ".pdf": "pdf",
    // Word ZIP-based (all parsed by mammoth)
    ".docx": "docx",
    ".docm": "docx",
    ".dotx": "docx",
    ".dotm": "docx",
    // Legacy Word 97-2003 (word-extractor)
    ".doc": "doc",
    ".dot": "doc",
    // OpenDocument
    ".odt": "odt",
    // Rich Text Format
    ".rtf": "rtf",
    // Spreadsheet
    ".xlsx": "xlsx",
    // Plain text
    ".txt": "txt",
    // HTML variants
    ".htm": "html",
    ".html": "html",
    ".mht": "html",
    ".mhtml": "html",
    // Word XML
    ".xml": "xml",
    ".xmll": "xml",
  };
  return map[ext] ?? null;
}

// Full file validation helper
// Lightweight check: extension + non-empty only. Deep parsing happens at import time.
export async function validateFile(file: MulterFile): Promise<{
  isValid: boolean;
  fileType: string | null;
  fileName: string;
  fileSize: number;
  error: string | null;
}> {
  const fileName = file.originalname;
  const fileSize = file.size;
  const fileExtension = getFileExtension(fileName);

  // Check for known-but-unsupported formats first
  const hint = UNSUPPORTED_WITH_HINT[fileExtension];
  if (hint) {
    return { isValid: false, fileType: fileExtension.replace(".", ""), fileName, fileSize, error: hint };
  }

  if (!ALLOWED_EXTENSIONS.includes(fileExtension)) {
    return {
      isValid: false,
      fileType: fileExtension.replace(".", ""),
      fileName,
      fileSize,
      error: `File type '${fileExtension}' is not supported. Supported: PDF, DOCX, DOC, XLSX, ODT, TXT, HTML, and Word variants.`
    };
  }

  if (fileSize === 0) {
    return { isValid: false, fileType: fileExtension.replace(".", ""), fileName, fileSize, error: "File is empty" };
  }

  const expectedType = extensionToType(fileExtension);
  return { isValid: true, fileType: expectedType, fileName, fileSize, error: null };
}

// Minimum characters to consider a PDF as having "real" text (not just metadata)
const MIN_PDF_TEXT_LENGTH = 50;
// Maximum pages to OCR (prevents timeout on huge documents)
const MAX_OCR_PAGES = 20;
// OCR timeout per page in milliseconds
const OCR_PAGE_TIMEOUT_MS = 30000;

// Helper: convert text to <p>-wrapped HTML
function textToHtml(text: string): string {
  const safeText = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
  return safeText
    .split("\n")
    .map((line) => `<p>${line.trimEnd()}</p>`)
    .join("");
}

// PDF parse helper — tries text extraction first, falls back to OCR for scanned PDFs
export async function parsePDF(buffer: Buffer): Promise<string> {
  // Step 1: Try text extraction via pdf-parse
  // @ts-ignore — no types for the internal path, but it works at runtime
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  let extractedText = "";
  try {
    const data = await pdfParse(buffer);
    extractedText = data.text?.trim() ?? "";
  } catch {
    // pdf-parse failed entirely — will attempt OCR below
  }

  // If we got meaningful text, use it (fast path)
  if (extractedText.length >= MIN_PDF_TEXT_LENGTH) {
    return textToHtml(extractedText);
  }

  // Step 2: Fall back to OCR for scanned/image-based PDFs
  console.log("[DocImport] PDF text extraction yielded minimal text, attempting OCR...");
  try {
    const ocrHtml = await ocrPdfPages(buffer);
    if (ocrHtml && ocrHtml.trim().length > 0) {
      return ocrHtml;
    }
  } catch (ocrError) {
    console.error("[DocImport] OCR fallback failed:", ocrError);
  }

  // Step 3: If we got some text (even < MIN_PDF_TEXT_LENGTH), use it rather than failing
  if (extractedText.length > 0) {
    return textToHtml(extractedText);
  }

  // Import with a placeholder note instead of throwing — user can still edit the doc
  return "<p><em>[Imported PDF — content could not be extracted. The PDF may contain only images or scanned pages.]</em></p>";
}

// Render PDF pages to images and OCR them using tesseract.js
async function ocrPdfPages(buffer: Buffer): Promise<string> {
  let createCanvas: any;
  try {
    const canvasModule = await import("@napi-rs/canvas");
    createCanvas = canvasModule.createCanvas;
  } catch {
    // @napi-rs/canvas not available on this platform — skip OCR
    return "";
  }
  const Tesseract = (await import("tesseract.js")).default;
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const uint8 = new Uint8Array(buffer);
  const pdfDoc = await (pdfjsLib as any).getDocument({ data: uint8 }).promise;
  const numPages = Math.min(pdfDoc.numPages, MAX_OCR_PAGES);

  if (numPages === 0) return "";

  const worker = await Tesseract.createWorker("eng");
  const allPageTexts: string[] = [];

  try {
    for (let i = 1; i <= numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const scale = 2.0;
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");

      await page.render({ canvasContext: ctx as any, viewport }).promise;

      const pngBuffer = canvas.toBuffer("image/png");

      // Run OCR with timeout per page
      const ocrResult = await Promise.race([
        worker.recognize(pngBuffer),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`OCR timeout on page ${i}`)), OCR_PAGE_TIMEOUT_MS)
        ),
      ]);

      const pageText = (ocrResult as any).data.text?.trim();
      if (pageText) {
        allPageTexts.push(pageText);
      }
    }
  } finally {
    await worker.terminate();
  }

  if (allPageTexts.length === 0) return "";

  return textToHtml(allPageTexts.join("\n\n"));
}

// DOCX parse helper — enriched sanitize config preserves Word formatting
export async function parseDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer });

  if (!result.value || result.value.trim().length === 0) {
    throw new FileParseError("Word document appears to be empty");
  }

  if (result.messages && result.messages.length > 0) {
    console.log("[DocImport] DOCX conversion warnings:", result.messages);
  }

  // Enriched config: allow div, img, blockquote, hr, pre, code that mammoth/Word produce
  const docxSanitizeConfig: sanitizeHtml.IOptions = {
    ...sanitizeConfig,
    allowedTags: [
      ...(sanitizeConfig.allowedTags as string[]),
      "div", "img", "blockquote", "hr", "pre", "code", "sub", "sup", "mark",
    ],
    allowedAttributes: {
      ...(sanitizeConfig.allowedAttributes as Record<string, string[]>),
      img: ["src", "alt", "width", "height"],
      div: ["style"],
      p: ["style"],
      span: ["style"],
      blockquote: ["style"],
    },
  };

  return sanitizeHtml(result.value, docxSanitizeConfig);
}

// XLSX parse helper — converts first sheet to HTML table
export async function parseXlsx(buffer: Buffer): Promise<string> {
  const wb = XLSX.read(buffer, { type: "buffer" });

  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new FileParseError("XLSX file contains no sheets");
  }

  const sheet = wb.Sheets[wb.SheetNames[0]];
  const html = XLSX.utils.sheet_to_html(sheet);

  if (!html || html.trim().length === 0) {
    throw new FileParseError("XLSX first sheet appears to be empty");
  }

  return sanitizeHtml(html, sanitizeConfig);
}

// TXT parse helper — each line becomes a <p>
export function parseTxt(buffer: Buffer): string {
  const text = buffer.toString("utf8");

  if (text.trim().length === 0) {
    throw new FileParseError("Text file appears to be empty");
  }

  // Sanitize to strip any injected tags, then wrap each line in <p>
  const safeText = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
  return safeText
    .split("\n")
    .map((line) => `<p>${line.trimEnd()}</p>`)
    .join("");
}

// HTML parse helper — sanitize and return
export function parseHtml(buffer: Buffer): string {
  const html = buffer.toString("utf8");

  if (html.trim().length === 0) {
    throw new FileParseError("HTML file appears to be empty");
  }

  // Strip <script>, <style>, <iframe> etc. and only allow safe tags
  const htmlSanitizeConfig: sanitizeHtml.IOptions = {
    ...sanitizeConfig,
    allowedTags: [
      ...(sanitizeConfig.allowedTags as string[]),
      "div", "img", "blockquote", "hr", "pre", "code", "sub", "sup", "mark",
    ],
    allowedAttributes: {
      ...(sanitizeConfig.allowedAttributes as Record<string, string[]>),
      img: ["src", "alt", "width", "height"],
      div: ["style"],
      p: ["style"],
      span: ["style"],
    },
  };

  return sanitizeHtml(html, htmlSanitizeConfig);
}

// Word XML parse helper — mammoth handles .xml Word documents
export async function parseWordXml(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.convertToHtml({ buffer });
    if (result.value && result.value.trim().length > 0) {
      const docxSanitizeConfig: sanitizeHtml.IOptions = {
        ...sanitizeConfig,
        allowedTags: [
          ...(sanitizeConfig.allowedTags as string[]),
          "div", "img", "blockquote", "hr", "pre", "code", "sub", "sup", "mark",
        ],
        allowedAttributes: {
          ...(sanitizeConfig.allowedAttributes as Record<string, string[]>),
          img: ["src", "alt", "width", "height"],
          div: ["style"],
          p: ["style"],
          span: ["style"],
        },
      };
      return sanitizeHtml(result.value, docxSanitizeConfig);
    }
  } catch {
    // mammoth can't parse this XML — fall through to plain text extraction
  }

  // Fallback: strip XML tags and treat as plain text
  const text = buffer.toString("utf8");
  const stripped = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
  if (stripped.trim().length === 0) {
    throw new FileParseError("XML file appears to be empty or contains no readable text");
  }
  return stripped
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => `<p>${line.trimEnd()}</p>`)
    .join("");
}

// Legacy .doc/.dot parse helper — extracts plain text via word-extractor
export async function parseDoc(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  const text = doc.getBody();

  if (!text || text.trim().length === 0) {
    throw new FileParseError("Legacy Word document appears to be empty");
  }

  return textToHtml(text);
}

// Universal fallback parser — officeparser handles most Office formats (.doc, .dot, .docx, .dotx, .odt, etc.)
export async function parseWithOfficeParser(buffer: Buffer): Promise<string> {
  const text = String(await officeParser.parseOffice(buffer));

  if (!text || text.trim().length === 0) {
    throw new FileParseError("Document appears to be empty or could not be read");
  }

  return textToHtml(text);
}

// ODT parse helper — uses officeparser to extract text
export async function parseOdt(buffer: Buffer): Promise<string> {
  // officeParser.parseOffice returns a string at runtime despite TS types saying OfficeParserAST
  const text = String(await officeParser.parseOffice(buffer));

  if (!text || text.trim().length === 0) {
    throw new FileParseError("ODT document appears to be empty");
  }

  return textToHtml(text);
}

// Last-resort parser — extract any readable text from binary files (.doc, .dot, etc.)
export async function parseAsPlainText(buffer: Buffer): Promise<string> {
  // Convert buffer to string, strip non-printable chars, keep readable text
  const raw = buffer.toString("utf8");
  // Extract runs of printable ASCII/unicode (min 4 chars to skip noise)
  const readable = raw.match(/[\x20-\x7E\u00A0-\uFFFF]{4,}/g);

  if (!readable || readable.length === 0) {
    throw new FileParseError("Could not extract any readable text from this file");
  }

  const text = readable.join("\n");
  return textToHtml(text);
}

// Check if error is MulterError
export function isMulterError(error: unknown): error is MulterErrorType {
  return error instanceof Error && error.name === "MulterError";
}

// Error handling middleware for multer errors
export function handleMulterError(err: Error, _req: import("express").Request, res: import("express").Response, next: (err?: Error) => void) {
  if (err instanceof FileValidationError) {
    return res.status(400).json({ isValid: false, error: err.message });
  }
  if (isMulterError(err)) {
    if ((err as MulterErrorType).code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ isValid: false, error: "File size exceeds 10MB limit" });
    }
    return res.status(400).json({ isValid: false, error: err.message });
  }
  next(err);
}

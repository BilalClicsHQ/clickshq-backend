/**
 * Writing-assist — single-shot AI rewrites for selected text in a doc.
 *
 * Uses the shared OpenAI client with a tightly-scoped prompt per action so the
 * model returns ONLY the rewritten text — no preamble, no explanation, no
 * markdown unless the action specifically asks for it.
 *
 *   POST /api/ai/writing-assist  { action, text } → { reply }
 */
import { createChatCompletion, describeOpenAIError, isOpenAIConfigured } from "./openaiService";

const NOT_CONFIGURED = "AI not configured (OPENAI_API_KEY missing)";

export type WritingAction =
  | "improve"
  | "grammar"
  | "longer"
  | "shorter"
  | "explain"
  | "summarize";

// Per-action system prompts. The shared rule at the bottom keeps output clean.
const PROMPTS: Record<WritingAction, { system: string; temperature: number }> = {
  improve: {
    system:
      "You improve writing. Rewrite the user's text to be clearer, more concise, and more engaging while preserving the original meaning, tone, and language. Keep the same approximate length and the same number of lines.",
    temperature: 0.4,
  },
  grammar: {
    system:
      "You are a grammar and spelling editor. Fix typos, grammatical errors, and awkward phrasing in the user's text. Do not change the meaning, tone, style, or sentence count. Keep the original language.",
    temperature: 0.1,
  },
  longer: {
    system:
      "You expand writing. Make the user's text longer by adding helpful detail and context inside the existing sentences. Preserve the original meaning, tone, voice, and language. Aim for ~1.5x to 2x the original length. Do NOT add new paragraphs or line breaks — keep the same number of lines as the input. If the input is one line, the output must also be one line.",
    temperature: 0.4,
  },
  shorter: {
    system:
      "You shorten writing. Make the user's text more concise while preserving the key meaning. Cut redundant words and merge phrases. Aim for ~half the original length. Keep the original language and the same number of lines as the input.",
    temperature: 0.3,
  },
  explain: {
    system:
      "You explain text. Rewrite the user's text so that the concepts are clearly explained, with brief context for any jargon. Keep the original language. Plain prose. Do not add bullet lists. Keep the same number of lines as the input.",
    temperature: 0.4,
  },
  summarize: {
    system:
      "You summarize text. Produce a brief summary (1-3 sentences, single line) of the user's text capturing its main points. Keep the original language. Do not add bullets or paragraph breaks.",
    temperature: 0.3,
  },
};

const SHARED_OUTPUT_RULE = `
CRITICAL OUTPUT RULES:
- Return ONLY the rewritten text. No preamble like "Here is..." or "Sure, ...".
- No explanations, no notes, no labels, no headings, no title.
- Do not wrap output in quotes or code fences.
- Do not add markdown formatting (no **bold**, no *italic*, no #, no -, no *, no >).
- Do not add bullets, numbers, or list markers — the host editor handles list formatting.
- Match the structure of the input: if the input is a single line/sentence, output a single line; if the input has line breaks, keep the same number of line breaks in the same positions.
- Do not introduce new paragraph breaks. Do not split a single line into multiple lines.
- Preserve the original language.
`.trim();

/* ─────────────────────────── Doc Chat (Ask AI) ─────────────────────────── */

export type ChatMessage = { role: "user" | "assistant"; content: string };

const DOC_CHAT_SYSTEM = `
You are a focused AI assistant embedded in a document editor. The user is reading or writing a document and asks questions about it or asks you to do something useful (summarize, list action items, extract decisions, etc.).

RULES:
- Be concise and to the point. Default to short answers (1-4 sentences) unless the user explicitly asks for detail or a list.
- If the user asks for a list, return a clean bulleted list using "- " (one item per line). No numbered lists unless they ask.
- Do not wrap output in code fences. Do not start with "Sure," "Here is," etc.
- If you don't have enough context from the document to answer confidently, say so briefly and ask what they'd like.
- Match the user's language.
`.trim();

export async function runDocChat(
  userMessage: string,
  history: ChatMessage[] = [],
  context: { docTitle?: string; docContent?: string } = {},
): Promise<{ success: true; reply: string } | { success: false; error: string }> {
  if (!isOpenAIConfigured()) {
    return { success: false, error: NOT_CONFIGURED };
  }
  const trimmed = (userMessage ?? "").trim();
  if (!trimmed) {
    return { success: false, error: "Message is empty" };
  }
  if (trimmed.length > 4000) {
    return { success: false, error: "Message too long (max 4000 chars)" };
  }

  // Build the system prompt with doc context (truncated to keep token use sane)
  let systemPrompt = DOC_CHAT_SYSTEM;
  if (context.docTitle || context.docContent) {
    const title = context.docTitle?.trim() || "Untitled";
    const body = (context.docContent ?? "").trim().slice(0, 12000);
    systemPrompt += `\n\nThe document being discussed:\nTitle: ${title}`;
    if (body) systemPrompt += `\n\n---\n${body}\n---`;
  }

  // Keep only the last 8 turns of history to bound token use
  const recentHistory = history.slice(-8).filter(
    (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
  );

  try {
    const reply = await createChatCompletion({
      temperature: 0.3,
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        ...recentHistory.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: trimmed },
      ],
    });
    if (!reply) return { success: false, error: "Empty response from AI" };
    return { success: true, reply };
  } catch (err: unknown) {
    console.error("[DocChat] error:", err instanceof Error ? err.message : err);
    return { success: false, error: describeOpenAIError(err) };
  }
}

/* ───────────────────────── Doc generation (Create with AI) ───────────────────────── */

const DOC_GEN_SYSTEM = `
You generate a complete, well-structured document from the user's prompt.

Return a JSON object with EXACTLY two fields:
- "title": a short, clear document title in plain text (no markdown, no quotes).
- "content": the document body as clean HTML using ONLY these tags: <h1>, <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>.

RULES:
- Write helpful, realistic, well-organised content that fully matches the user's request.
- Do NOT repeat the title as the first heading inside "content".
- Do NOT include <html>, <head>, <body>, markdown, or code fences.
- Match the user's language.
`.trim();

export async function runDocGeneration(
  prompt: string,
): Promise<{ success: true; title: string; content: string } | { success: false; error: string }> {
  if (!isOpenAIConfigured()) {
    return { success: false, error: NOT_CONFIGURED };
  }
  const trimmed = (prompt ?? "").trim();
  if (!trimmed) {
    return { success: false, error: "Prompt is empty" };
  }
  if (trimmed.length > 4000) {
    return { success: false, error: "Prompt too long (max 4000 chars)" };
  }

  try {
    const raw = await createChatCompletion({
      temperature: 0.6,
      maxTokens: 2048,
      json: true,
      messages: [
        { role: "system", content: DOC_GEN_SYSTEM },
        { role: "user", content: trimmed },
      ],
    });
    if (!raw) return { success: false, error: "Empty response from AI" };

    let parsed: { title?: string; content?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Fallback: treat the whole reply as the body if JSON parsing fails.
      parsed = { title: "Untitled", content: `<p>${raw.replace(/</g, "&lt;")}</p>` };
    }

    const title = (parsed.title || "Untitled").toString().trim().slice(0, 200);
    const content = (parsed.content || "").toString().trim();
    if (!content) return { success: false, error: "AI returned no content" };

    return { success: true, title, content };
  } catch (err: unknown) {
    console.error("[DocGeneration] error:", err instanceof Error ? err.message : err);
    return { success: false, error: describeOpenAIError(err) };
  }
}

/* ───────────────────────── Doc edit (Write with Clics AI) ───────────────────────── */

const DOC_EDIT_SYSTEM = `
You edit an existing document according to the user's instruction.

Return a JSON object with EXACTLY one field:
- "content": the FULL edited document as clean HTML using ONLY these tags: <h1>, <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>.

RULES:
- Apply the user's instruction to the CURRENT document. Keep everything the instruction does not ask to change.
- Return the COMPLETE edited document, not just the changed part.
- Do NOT include <html>, <head>, <body>, markdown, or code fences.
- Match the user's language.
`.trim();

export async function runDocEdit(
  instruction: string,
  currentHtml: string,
): Promise<{ success: true; content: string } | { success: false; error: string }> {
  if (!isOpenAIConfigured()) {
    return { success: false, error: NOT_CONFIGURED };
  }
  const trimmed = (instruction ?? "").trim();
  if (!trimmed) {
    return { success: false, error: "Instruction is empty" };
  }
  const doc = (currentHtml ?? "").slice(0, 16000);

  try {
    const raw = await createChatCompletion({
      temperature: 0.4,
      maxTokens: 3072,
      json: true,
      messages: [
        { role: "system", content: DOC_EDIT_SYSTEM },
        {
          role: "user",
          content: `INSTRUCTION:\n${trimmed}\n\nCURRENT DOCUMENT (HTML):\n${doc || "<p></p>"}`,
        },
      ],
    });
    if (!raw) return { success: false, error: "Empty response from AI" };

    let parsed: { content?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { content: `<p>${raw.replace(/</g, "&lt;")}</p>` };
    }
    const content = (parsed.content || "").toString().trim();
    if (!content) return { success: false, error: "AI returned no content" };
    return { success: true, content };
  } catch (err: unknown) {
    console.error("[DocEdit] error:", err instanceof Error ? err.message : err);
    return { success: false, error: describeOpenAIError(err) };
  }
}

export async function runWritingAssist(
  action: WritingAction,
  text: string,
): Promise<{ success: true; reply: string } | { success: false; error: string }> {
  if (!isOpenAIConfigured()) {
    return { success: false, error: NOT_CONFIGURED };
  }
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return { success: false, error: "No text to process" };
  }
  if (trimmed.length > 8000) {
    return { success: false, error: "Selection too long (max 8000 chars)" };
  }

  const cfg = PROMPTS[action];
  if (!cfg) {
    return { success: false, error: `Unknown action: ${action}` };
  }

  try {
    const reply = await createChatCompletion({
      temperature: cfg.temperature,
      maxTokens: 1024,
      messages: [
        { role: "system", content: `${cfg.system}\n\n${SHARED_OUTPUT_RULE}` },
        { role: "user", content: trimmed },
      ],
    });
    if (!reply) {
      return { success: false, error: "Empty response from AI" };
    }
    return { success: true, reply };
  } catch (err: unknown) {
    console.error("[WritingAssist] error:", err instanceof Error ? err.message : err);
    return { success: false, error: describeOpenAIError(err) };
  }
}

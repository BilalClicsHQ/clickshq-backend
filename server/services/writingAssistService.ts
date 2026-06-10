/**
 * Writing-assist — single-shot AI rewrites for selected text in a doc.
 *
 * Uses the same Groq client as agentService (same llama-3.3-70b-versatile model)
 * but with a tightly-scoped prompt per action so the model returns ONLY the
 * rewritten text — no preamble, no explanation, no markdown unless the action
 * specifically asks for it.
 *
 *   POST /api/ai/writing-assist  { action, text } → { reply }
 */
import Groq from "groq-sdk";

let groqClient: Groq | null = null;

function getGroq(): Groq | null {
  if (groqClient) return groqClient;
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    console.warn("[WritingAssist] GROQ_API_KEY is not set");
    return null;
  }
  groqClient = new Groq({ apiKey });
  return groqClient;
}

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
  const groq = getGroq();
  if (!groq) {
    return { success: false, error: "AI not configured (GROQ_API_KEY missing)" };
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
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        ...recentHistory.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: trimmed },
      ],
    });
    const reply = response.choices[0]?.message?.content?.trim() ?? "";
    if (!reply) return { success: false, error: "Empty response from AI" };
    return { success: true, reply };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[DocChat] error:", msg);
    if (msg.includes("401")) return { success: false, error: "Invalid GROQ_API_KEY" };
    if (msg.includes("429")) return { success: false, error: "Rate limit — wait a moment and try again" };
    if (msg.toLowerCase().includes("timeout")) return { success: false, error: "AI service timed out" };
    return { success: false, error: msg };
  }
}

export async function runWritingAssist(
  action: WritingAction,
  text: string,
): Promise<{ success: true; reply: string } | { success: false; error: string }> {
  const groq = getGroq();
  if (!groq) {
    return { success: false, error: "AI not configured (GROQ_API_KEY missing)" };
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
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: cfg.temperature,
      max_tokens: 1024,
      messages: [
        { role: "system", content: `${cfg.system}\n\n${SHARED_OUTPUT_RULE}` },
        { role: "user", content: trimmed },
      ],
    });

    const reply = response.choices[0]?.message?.content?.trim() ?? "";
    if (!reply) {
      return { success: false, error: "Empty response from AI" };
    }
    return { success: true, reply };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[WritingAssist] error:", msg);
    if (msg.includes("401")) return { success: false, error: "Invalid GROQ_API_KEY" };
    if (msg.includes("429")) return { success: false, error: "Rate limit — wait a moment and try again" };
    if (msg.toLowerCase().includes("timeout")) return { success: false, error: "AI service timed out" };
    return { success: false, error: msg };
  }
}

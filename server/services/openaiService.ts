/**
 * Shared OpenAI chat-completions client (plain fetch, no SDK dependency).
 *
 * Needs OPENAI_API_KEY. Model defaults to gpt-4o-mini; override with OPENAI_MODEL.
 */
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 60_000;

export type OpenAIMessage = { role: "system" | "user" | "assistant"; content: string };

export function isOpenAIConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function getOpenAIModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

/**
 * Returns the assistant's reply text. Throws an Error whose message starts with
 * the HTTP status (e.g. "401: ...") on API errors, so callers can map them.
 */
export async function createChatCompletion(opts: {
  messages: OpenAIMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: getOpenAIModel(),
      messages: opts.messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body: any = await resp.json();
      detail = body?.error?.message || detail;
    } catch {
      // non-JSON error body
    }
    throw new Error(`${resp.status}: ${detail}`);
  }

  const data: any = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Maps a thrown error to a short user-facing message. */
export function describeOpenAIError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("OPENAI_API_KEY is not set")) return "AI not configured (OPENAI_API_KEY missing)";
  if (msg.startsWith("401")) return "Invalid OPENAI_API_KEY";
  if (msg.startsWith("429")) return "Rate limit — wait a moment and try again";
  if (msg.toLowerCase().includes("timeout") || msg.includes("aborted")) return "AI service timed out";
  return msg;
}

/**
 * Space AI insights — the "AI insights" tab on a space.
 *
 * Builds a snapshot of the space (progress, deadlines, workload, recent activity)
 * and asks the LLM for six insight cards, each with its own system prompt.
 * Results are cached per space + card (space_ai_insights) and regenerated on
 * demand. Also powers the space chat ("Talk to AI Agent").
 */
import { db } from "../db";
import { aiConversations, aiInsightFeedback, aiMessages, spaceAiInsights, type Space } from "@shared/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { createChatCompletion } from "./openaiService";
import {
  AgentError,
  daysSince,
  daysUntil,
  formatDue,
  getAccessibleSpace,
  list,
  loadSpaceTasks,
  loadUserNames,
  runAgentPrompt,
  text,
  type AgentUser,
  type TaskRow,
} from "./aiAgentService";

/* ─────────────────────────────── Insight cards ─────────────────────────────── */

const INSIGHTS_SYSTEM = `
You are Clics AI, the insights engine inside clicsHQ, a project management platform.
You analyze one project space using ONLY the JSON data provided: tasks, statuses, priorities, due dates, assignees, recent updates and workload.
Rules:
- Be specific: reference real task titles and people from the data
- Never invent tasks, people, dates or numbers
- Keep it concise and manager-friendly, in plain business English
- If the data is too thin for a confident insight, say so in one short sentence
- Inside "text", start list items with "- " on their own line
- Return only valid JSON
`.trim();

const SECTIONS_FORMAT = `{
"sections": [
{
"heading": "string (empty if not needed)",
"text": "string"
}
]
}`;

export const INSIGHT_CARDS = [
  {
    key: "executive_summary",
    title: "AI Executive Summary",
    task:
      'Write an executive summary of this space. First section, heading "Executive summary": overall health (on track, at risk or delayed, and why), progress (completed vs open work) and what leadership must know, in 2-4 sentences. Second section, heading "Key Efforts & Initiatives": the main efforts underway, grouping related tasks into 3-5 themes as "- " lines.',
  },
  {
    key: "tasks_at_risk",
    title: "Tasks at risk",
    task:
      "Identify the tasks most at risk of slipping: overdue, due soon but not started, high priority with no recent update, or unassigned. List up to 6, most severe first, as \"- Task title — reason\" lines. Use one section with an empty heading.",
  },
  {
    key: "key_decisions",
    title: "Key decisions this week",
    task:
      "Summarize the key decisions and changes reflected in the last 7 days: tasks completed, new priorities, status moves, re-prioritised or re-scheduled work visible in the data. Phrase them as decisions or outcomes. If little changed this week, say so. Use one section with an empty heading.",
  },
  {
    key: "next_actions",
    title: "Suggested next actions",
    task:
      "Recommend the 3-6 most valuable next actions for the team this week as \"- \" lines. Make them concrete, name who should act when it is clear from the data, and prioritise unblocking overdue and at-risk work. Use one section with an empty heading.",
  },
  {
    key: "bottlenecks",
    title: "Predictive bottlenecks",
    task:
      "Predict the bottlenecks most likely in the next 1-3 weeks: overloaded people, clusters of deadlines, work piling up in one status (for example Review), unassigned or stale tasks. For each, give the likely impact and an early mitigation. Use one section with an empty heading.",
  },
  {
    key: "resources",
    title: "Resources Allocation",
    task:
      "Assess how work is distributed across people: who looks overloaded or under-utilised (open, overdue and due-soon counts), how much work is unassigned, and concrete reallocation suggestions. Suggest only; never claim changes were made. Use one section with an empty heading.",
  },
] as const;

export type InsightCardKey = (typeof INSIGHT_CARDS)[number]["key"];
type InsightContent = { sections: { heading: string; text: string }[] };

const findCard = (key: string) => INSIGHT_CARDS.find((c) => c.key === key);

/* ─────────────────────────────── Space snapshot ─────────────────────────────── */

const notNegative = (n: number | null) => (n === null ? null : Math.max(0, n));

// Compact JSON view of the space used as LLM context (bounded for token use).
async function buildSpaceSnapshot(space: Space, rows: TaskRow[]) {
  const names = await loadUserNames(rows.flatMap((r) => r.task.assigneeIds ?? []));
  const open = rows.filter((r) => r.kind !== "done");
  const overdue = open.filter((r) => (daysUntil(r.task.dueDate) ?? 1) < 0);
  const dueSoon = open.filter((r) => {
    const d = daysUntil(r.task.dueDate);
    return d !== null && d >= 0 && d <= 7;
  });
  const recent = rows
    .filter((r) => (daysSince(r.task.updatedAt) ?? 99) <= 7)
    .sort((a, b) => new Date(b.task.updatedAt ?? 0).getTime() - new Date(a.task.updatedAt ?? 0).getTime());

  const workload = new Map<string, { open: number; overdue: number; dueSoon: number }>();
  for (const r of open) {
    for (const id of r.task.assigneeIds ?? []) {
      const w = workload.get(id) ?? { open: 0, overdue: 0, dueSoon: 0 };
      w.open++;
      if (overdue.includes(r)) w.overdue++;
      if (dueSoon.includes(r)) w.dueSoon++;
      workload.set(id, w);
    }
  }

  const task = (r: TaskRow) => ({
    title: r.task.name,
    status: r.statusName,
    priority: r.task.priority ?? "none",
    due: r.task.dueDate ? formatDue(r.task.dueDate) : null,
    assignees: (r.task.assigneeIds ?? []).map((id) => names.get(id)).filter(Boolean),
    last_updated_days_ago: notNegative(daysSince(r.task.updatedAt)),
  });

  return {
    space: space.name,
    today: new Date().toDateString(),
    totals: {
      tasks: rows.length,
      completed: rows.filter((r) => r.kind === "done").length,
      in_progress: rows.filter((r) => r.kind === "in_progress").length,
      not_started: rows.filter((r) => r.kind === "todo").length,
      overdue: overdue.length,
      due_next_7_days: dueSoon.length,
      open_unassigned: open.filter((r) => !(r.task.assigneeIds ?? []).length).length,
    },
    workload: [...workload].map(([id, w]) => ({
      name: names.get(id),
      open_tasks: w.open,
      overdue: w.overdue,
      due_next_7_days: w.dueSoon,
    })),
    overdue_tasks: overdue.slice(0, 15).map(task),
    due_next_7_days: dueSoon.slice(0, 15).map(task),
    updated_last_7_days: recent.slice(0, 20).map(task),
    open_tasks: open.slice(0, 40).map(task),
  };
}

/* ─────────────────────────────── Generation ─────────────────────────────── */

async function generateCard(
  card: (typeof INSIGHT_CARDS)[number],
  snapshot: unknown,
  customPrompt: string | null,
): Promise<InsightContent> {
  const userPrompt =
    `Space data (JSON):\n${JSON.stringify(snapshot)}\n` +
    (customPrompt ? `\nAdditional instruction from the user: ${customPrompt}\n` : "") +
    `\nReturn JSON in this exact format:\n${SECTIONS_FORMAT}`;
  const raw = await runAgentPrompt(`${INSIGHTS_SYSTEM}\n\nYour task: ${card.task}`, userPrompt, 900);
  const sections = list(raw.sections)
    .map((s) => ({ heading: text(s?.heading, 80), text: text(s?.text, 2500) }))
    .filter((s) => s.text)
    .slice(0, 4);
  return sections.length
    ? { sections }
    : { sections: [{ heading: "", text: "There isn't enough data in this space yet for this insight." }] };
}

const EMPTY_SPACE: InsightContent = {
  sections: [{ heading: "", text: "Add tasks to this space to get AI insights on its progress and workload." }],
};

async function saveCard(spaceId: string, cardKey: string, values: { content?: InsightContent; customPrompt?: string | null }) {
  const now = new Date();
  await db
    .insert(spaceAiInsights)
    .values({
      spaceId,
      cardKey,
      content: values.content ?? null,
      customPrompt: values.customPrompt ?? null,
      generatedAt: values.content ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [spaceAiInsights.spaceId, spaceAiInsights.cardKey],
      set: {
        ...(values.content ? { content: values.content, generatedAt: now } : {}),
        ...(values.customPrompt !== undefined ? { customPrompt: values.customPrompt } : {}),
        updatedAt: now,
      },
    });
}

export type InsightCardView = {
  key: string;
  title: string;
  sections: InsightContent["sections"];
  generatedAt: string | null;
  customPrompt: string | null;
  feedback: "up" | "down" | null;
  error?: string;
};

/**
 * All six cards for a space. Cards that were never generated are generated now
 * (in parallel); the rest come from the cache.
 */
export async function getSpaceInsights(user: AgentUser, spaceId: string): Promise<InsightCardView[]> {
  const space = await getAccessibleSpace(user, spaceId);
  const [stored, feedback] = await Promise.all([
    db.select().from(spaceAiInsights).where(eq(spaceAiInsights.spaceId, space.id)),
    db
      .select()
      .from(aiInsightFeedback)
      .where(and(eq(aiInsightFeedback.spaceId, space.id), eq(aiInsightFeedback.userId, user.id))),
  ]);
  const byKey = new Map(stored.map((s) => [s.cardKey, s]));
  const missing = INSIGHT_CARDS.filter((c) => !byKey.get(c.key)?.content);

  const generated = new Map<string, InsightContent>();
  const errors = new Map<string, string>();
  if (missing.length) {
    const rows = await loadSpaceTasks(space.id);
    if (!rows.length) {
      // Nothing to analyse yet — show a hint without caching it.
      for (const c of missing) generated.set(c.key, EMPTY_SPACE);
    } else {
      const snapshot = await buildSpaceSnapshot(space, rows);
      const results = await Promise.allSettled(
        missing.map((c) => generateCard(c, snapshot, byKey.get(c.key)?.customPrompt ?? null)),
      );
      await Promise.all(
        results.map(async (r, i) => {
          const card = missing[i];
          if (r.status === "fulfilled") {
            generated.set(card.key, r.value);
            await saveCard(space.id, card.key, { content: r.value });
          } else {
            errors.set(card.key, r.reason instanceof Error ? r.reason.message : "Could not generate this insight");
          }
        }),
      );
    }
  }

  return INSIGHT_CARDS.map((card) => {
    const row = byKey.get(card.key);
    const content = generated.get(card.key) ?? (row?.content as InsightContent | null) ?? null;
    return {
      key: card.key,
      title: card.title,
      sections: content?.sections ?? [],
      generatedAt: row?.generatedAt ? new Date(row.generatedAt).toISOString() : generated.has(card.key) ? new Date().toISOString() : null,
      customPrompt: row?.customPrompt ?? null,
      feedback: (feedback.find((f) => f.cardKey === card.key)?.value as "up" | "down" | undefined) ?? null,
      ...(errors.has(card.key) ? { error: errors.get(card.key) } : {}),
    };
  });
}

/** Regenerate one card from the latest space data (keeps its custom prompt). */
export async function regenerateInsight(user: AgentUser, spaceId: string, cardKey: string) {
  const card = findCard(cardKey);
  if (!card) throw new AgentError(404, "Unknown insight");
  const space = await getAccessibleSpace(user, spaceId);
  const rows = await loadSpaceTasks(space.id);
  if (!rows.length) return { sections: EMPTY_SPACE.sections, generatedAt: null };

  const [row] = await db
    .select()
    .from(spaceAiInsights)
    .where(and(eq(spaceAiInsights.spaceId, space.id), eq(spaceAiInsights.cardKey, cardKey)));
  const content = await generateCard(card, await buildSpaceSnapshot(space, rows), row?.customPrompt ?? null);
  await saveCard(space.id, cardKey, { content });
  return { sections: content.sections, generatedAt: new Date().toISOString() };
}

/** Save (or clear) a card's custom prompt, then regenerate it with that prompt. */
export async function setInsightPrompt(user: AgentUser, spaceId: string, cardKey: string, prompt: unknown) {
  if (!findCard(cardKey)) throw new AgentError(404, "Unknown insight");
  const space = await getAccessibleSpace(user, spaceId);
  const customPrompt = text(prompt, 1000) || null;
  await saveCard(space.id, cardKey, { customPrompt });
  const result = await regenerateInsight(user, spaceId, cardKey);
  return { ...result, customPrompt };
}

/** Record (or clear) the user's thumbs up/down on a card. */
export async function setInsightFeedback(user: AgentUser, spaceId: string, cardKey: string, value: unknown) {
  if (!findCard(cardKey)) throw new AgentError(404, "Unknown insight");
  const space = await getAccessibleSpace(user, spaceId);
  const where = and(
    eq(aiInsightFeedback.spaceId, space.id),
    eq(aiInsightFeedback.cardKey, cardKey),
    eq(aiInsightFeedback.userId, user.id),
  );
  if (value !== "up" && value !== "down") {
    await db.delete(aiInsightFeedback).where(where);
    return { feedback: null };
  }
  await db
    .insert(aiInsightFeedback)
    .values({ spaceId: space.id, cardKey, userId: user.id, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [aiInsightFeedback.spaceId, aiInsightFeedback.cardKey, aiInsightFeedback.userId],
      set: { value, updatedAt: new Date() },
    });
  return { feedback: value };
}

/* ─────────────────────────────── Space chat ─────────────────────────────── */

const SPACE_CHAT_SYSTEM = `
You are Clics AI, an assistant inside clicsHQ answering questions about one project space.
Rules:
- Use only the space data provided below; if the answer is not in the data, say so briefly
- Be concise: 1-5 sentences, or a short list with "- " lines when listing items
- Reference real task titles and people; never invent data
- Do not wrap the answer in code fences or start with "Sure" or "Here is"
- Match the user's language
`.trim();

export async function listSpaceConversations(user: AgentUser, spaceId: string) {
  const space = await getAccessibleSpace(user, spaceId);
  return db
    .select({ id: aiConversations.id, title: aiConversations.title, updatedAt: aiConversations.updatedAt })
    .from(aiConversations)
    .where(and(eq(aiConversations.userId, user.id), eq(aiConversations.spaceId, space.id)))
    .orderBy(desc(aiConversations.updatedAt))
    .limit(30);
}

/** Reply to a chat message about the space; starts a new conversation when none is given. */
export async function spaceChatReply(user: AgentUser, spaceId: string, conversationId: unknown, message: unknown) {
  const content = text(message, 4000);
  if (!content) throw new AgentError(400, "Message is empty");
  const space = await getAccessibleSpace(user, spaceId);

  let conversation;
  if (typeof conversationId === "string" && conversationId) {
    [conversation] = await db
      .select()
      .from(aiConversations)
      .where(
        and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, user.id), eq(aiConversations.spaceId, space.id)),
      );
    if (!conversation) throw new AgentError(404, "Conversation not found");
  } else {
    [conversation] = await db
      .insert(aiConversations)
      .values({ userId: user.id, spaceId: space.id, title: content.slice(0, 60) })
      .returning();
  }

  const history = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversation.id))
    .orderBy(asc(aiMessages.createdAt));

  const rows = await loadSpaceTasks(space.id);
  const snapshot = await buildSpaceSnapshot(space, rows);
  const reply = await createChatCompletion({
    temperature: 0.3,
    maxTokens: 800,
    messages: [
      { role: "system", content: `${SPACE_CHAT_SYSTEM}\n\nSpace data (JSON):\n${JSON.stringify(snapshot)}` },
      ...history.slice(-10).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content },
    ],
  });
  if (!reply) throw new AgentError(502, "Empty response from AI");

  // Separate inserts so the two turns get distinct timestamps (history is ordered by createdAt).
  await db.insert(aiMessages).values({ conversationId: conversation.id, role: "user", content });
  await db.insert(aiMessages).values({ conversationId: conversation.id, role: "assistant", content: reply });
  await db
    .update(aiConversations)
    .set({ updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(aiConversations.id, conversation.id));

  return { conversationId: conversation.id, reply };
}

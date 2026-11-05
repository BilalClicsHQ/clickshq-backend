/**
 * AI Agents (MVP) — the 8 agents from the "clicsHQ – AI Agents" spec.
 *
 * Manual agents work in two steps, so the user can review before anything changes:
 *   preview(input)  → calls the LLM and returns its structured JSON (no changes made)
 *   apply(payload)  → performs the confirmed actions (create space / tasks / subtasks)
 * Status Reporter, Workload Analyzer and Executive Brief are view/export only.
 * The Follow-up Agent is the only automatic one: it runs daily from a cron job.
 *
 * In this app a "project" is a Space; tasks live inside a space.
 */
import { db } from "../db";
import { storage } from "../storage";
import { notifications, spaces, type Space, type Task } from "@shared/schema";
import { and, eq, gte } from "drizzle-orm";
import { createChatCompletion, type OpenAIMessage } from "./openaiService";
import { notify } from "./notificationService";
import { evaluateWorkflows } from "./workflowEngine";

export type AgentUser = { id: string; companyId?: string | null };

export class AgentError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/* ─────────────────────────────── Prompts (from the spec) ─────────────────────────────── */

const GENERAL_RULES = `
General rules:
- Use low creativity
- Prefer structured JSON output
- Do not allow long conversational replies
- If information is missing, make a reasonable assumption
- Never return markdown
- Never wrap JSON in code fences
`.trim();

const FALLBACK_RULES = `
If the input is incomplete:
- make reasonable assumptions
- do not ask follow-up questions
- return the best possible structured output
If no meaningful output can be generated:
- return empty arrays where applicable
- do not return explanatory paragraphs
`.trim();

const PROJECT_PLANNER_SYSTEM = `
You are the Project Planner agent inside clicsHQ, a project management platform.
Your job is to convert a user's goal into a practical project plan that a team can execute.
Rules:
- Create a clear project name
- Create between 8 and 15 tasks
- Tasks must be practical, ordered logically, and written in simple business English
- Each task must include a short description
- Include suggested priority for each task: Low, Medium, or High
- Include a suggested due offset in days from project start
- Do not create vague tasks like "Do the work" or "Complete project"
- If the goal is broad, break it into realistic phases
- Assume a small to mid-sized team unless user specifies otherwise
- Return only valid JSON
`.trim();

const PROJECT_PLANNER_USER = `
Create a project plan based on the following input.
Goal: {{goal}}
Deadline: {{deadline}}
Team Size: {{team_size}}
Additional Context: {{context}}
Return JSON in this exact format:
{
"project_name": "string",
"project_summary": "string",
"tasks": [
{
"title": "string",
"description": "string",
"priority": "High|Medium|Low",
"due_in_days": 0
}
]
}
`.trim();

const TASK_CREATOR_SYSTEM = `
You are the Task Creator agent inside clicsHQ.
Your job is to convert unstructured text such as notes, chat messages, or email content into clear and actionable tasks.
Rules:
- Extract only actionable work
- Ignore greetings, filler text, or irrelevant context
- Create one or more tasks depending on the input
- Each task must have a clear title and short description
- Assign a priority: Low, Medium, or High
- If the input does not contain a task, return an empty tasks array
- Keep titles short and specific
- Return only valid JSON
`.trim();

const TASK_CREATOR_USER = `
Convert the following text into actionable tasks.
Input Text: {{input_text}}
Return JSON in this exact format:
{
"tasks": [
{
"title": "string",
"description": "string",
"priority": "High|Medium|Low"
}
]
}
`.trim();

const SUBTASK_GENERATOR_SYSTEM = `
You are the Subtask Generator agent inside clicsHQ.
Your job is to break a task into smaller, practical subtasks that are easy to assign and track.
Rules:
- Generate between 3 and 8 subtasks
- Subtasks must be concrete and sequential where possible
- Avoid repeating the parent task wording
- Subtasks must be specific enough for a team member to act on
- Return only valid JSON
`.trim();

const SUBTASK_GENERATOR_USER = `
Break the following task into subtasks.
Task Title: {{task_title}}
Task Description: {{task_description}}
Return JSON in this exact format:
{
"subtasks": [
{
"title": "string"
}
]
}
`.trim();

const MEETING_SUMMARIZER_SYSTEM = `
You are the Meeting Summarizer agent inside clicsHQ.
Your job is to convert meeting notes or transcripts into a concise summary and a list of action items.
Rules:
- Write a short summary in plain business English
- Extract only actionable items
- If an owner is clearly mentioned, include the owner name
- If no owner is mentioned, set owner to null
- Each action item must have a clear title and short description
- Do not invent decisions that are not supported by the input
- Return only valid JSON
`.trim();

const MEETING_SUMMARIZER_USER = `
Summarize the following meeting notes and extract action items.
Meeting Notes:
{{meeting_notes}}
Return JSON in this exact format:
{
"summary": "string",
"action_items": [
{
"title": "string",
"description": "string",
"owner": "string or null",
"priority": "High|Medium|Low"
}
]
}
`.trim();

const STATUS_REPORTER_SYSTEM = `
You are the Status Reporter agent inside clicsHQ.
Your job is to generate a concise project status update using project data.
Rules:
- Summarize progress clearly for managers
- Mention completed work, work in progress, and risks or blockers
- If blocker information is not explicit, infer likely blockers carefully and label them as potential blockers
- Keep the tone professional and concise
- Return only valid JSON
`.trim();

const STATUS_REPORTER_USER = `
Generate a project status report using the following project data.
Project Name: {{project_name}}
Completed Tasks: {{completed_tasks}}
In Progress Tasks: {{in_progress_tasks}}
Overdue Tasks: {{overdue_tasks}}
Recent Activity: {{recent_activity}}
Return JSON in this exact format:
{
"overall_status": "On Track|At Risk|Delayed",
"summary": "string",
"completed_highlights": [
"string"
],
"in_progress": [
"string"
],
"blockers": [
"string"
],
"next_steps": [
"string"
]
}
`.trim();

const FOLLOW_UP_SYSTEM = `
You are the Follow-up Agent inside clicsHQ.
Your job is to create short, polite reminder messages for tasks that are inactive, near deadline, or overdue.
Rules:
- Be concise, professional, and polite
- Do not sound robotic
- Do not be aggressive or blaming
- Mention the task name
- Mention why the reminder is being sent
- Encourage the assignee to update progress
- Return only valid JSON
`.trim();

const FOLLOW_UP_USER = `
Write a follow-up message for this task.
Task Title: {{task_title}}
Assignee Name: {{assignee_name}}
Task Status: {{task_status}}
Days Since Last Update: {{days_since_last_update}}
Due Date: {{due_date}}
Reason: {{reason}}
Return JSON in this exact format:
{
"message": "string"
}
`.trim();

const WORKLOAD_ANALYZER_SYSTEM = `
You are the Workload Analyzer agent inside clicsHQ.
Your job is to identify users who appear overloaded based on task count, deadlines, and work distribution.
Rules:
- Review workload fairly across users
- Flag users who appear overloaded
- Provide short reasons
- Suggest possible reassignment opportunities, but do not recommend automatic changes
- Unassigned open tasks are a work distribution problem: if any exist, say how many in the summary and suggest an owner for the most important ones
- Only say the workload looks balanced when every open task has an owner and no one is overloaded
- Return only valid JSON
`.trim();

const WORKLOAD_ANALYZER_USER = `
Analyze the following workload data and identify overloaded users.
Team Workload Data:
{{workload_data}}
Return JSON in this exact format:
{
"summary": "string",
"overloaded_users": [
{
"name": "string",
"reason": "string"
}
],
"reassignment_suggestions": [
{
"task_title": "string",
"suggested_new_owner": "string",
"reason": "string"
}
]
}
`.trim();

const EXECUTIVE_BRIEF_SYSTEM = `
You are the Executive Brief agent inside clicsHQ.
Your job is to generate a high-level summary for leadership across one or more projects.
Rules:
- Focus on key updates, major risks, delays, and highlights
- Keep language concise and executive-friendly
- Avoid task-by-task detail unless it is important
- Surface what leadership would care about most
- Return only valid JSON
`.trim();

const EXECUTIVE_BRIEF_USER = `
Generate an executive brief using the following workspace or project data.
Reporting Period: {{reporting_period}}
Projects Data: {{projects_data}}
Return JSON in this exact format:
{
"summary": "string",
"key_updates": [
"string"
],
"risks": [
"string"
],
"delays": [
"string"
],
"highlights": [
"string"
]
}
`.trim();

/* ─────────────────────────────── LLM helpers ─────────────────────────────── */

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");

function parseJson(raw: string): any | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(cleaned);
    return value && typeof value === "object" ? value : null;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

// System prompt + populated user prompt → parsed JSON. Retries once on invalid JSON (per spec).
export async function runAgentPrompt(systemPrompt: string, userPrompt: string, maxTokens = 1500): Promise<any> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: `${systemPrompt}\n\n${GENERAL_RULES}\n\n${FALLBACK_RULES}` },
    { role: "user", content: userPrompt },
  ];
  const first = await createChatCompletion({ messages, temperature: 0.3, maxTokens, json: true });
  const parsed = parseJson(first);
  if (parsed) return parsed;

  const retry = await createChatCompletion({
    messages: [
      ...messages,
      { role: "assistant", content: first },
      { role: "user", content: "Return valid JSON only. Do not include any extra text." },
    ],
    temperature: 0.2,
    maxTokens,
    json: true,
  });
  const reparsed = parseJson(retry);
  if (reparsed) return reparsed;
  throw new AgentError(502, "The AI returned an invalid response. Please try again.");
}

/* ─────────────────────────────── Output normalizers ─────────────────────────────── */

type Priority = "High" | "Medium" | "Low";
const APP_PRIORITY: Record<Priority, "high" | "normal" | "low"> = { High: "high", Medium: "normal", Low: "low" };

export const text = (value: unknown, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : "");
export const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
export const strings = (value: unknown, max = 20) =>
  list(value).map((item) => text(item, 600)).filter(Boolean).slice(0, max);

function priority(value: unknown): Priority {
  const p = text(value).toLowerCase();
  if (p.startsWith("h") || p === "urgent") return "High";
  if (p.startsWith("l")) return "Low";
  return "Medium";
}

const normalizeTasks = (value: unknown, max: number) =>
  list(value)
    .map((t) => ({ title: text(t?.title, 200), description: text(t?.description, 2000), priority: priority(t?.priority) }))
    .filter((t) => t.title)
    .slice(0, max);

/* ─────────────────────────────── Data helpers ─────────────────────────────── */

const MAX_SPACES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

// Same defaults as the "Create Space" modal.
const DEFAULT_STATUSES = [
  { name: "To Do", colorCode: "#9CA3AF", order: 0 },
  { name: "In Progress", colorCode: "#60A5FA", order: 1 },
  { name: "Review", colorCode: "#FBBF24", order: 2 },
  { name: "Completed", colorCode: "#4ADE80", order: 3 },
];

type StatusKind = "done" | "in_progress" | "todo";

function statusKind(name = ""): StatusKind {
  if (/complete|done|closed|finish|resolved/i.test(name)) return "done";
  if (/progress|review|doing|testing|qa|active/i.test(name)) return "in_progress";
  return "todo";
}

function startOfDay(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Days from today until the date (negative = in the past); null when there's no valid date.
export function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return Math.round((startOfDay(date) - startOfDay(new Date())) / DAY_MS);
}

export function daysSince(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return Math.floor((Date.now() - date.getTime()) / DAY_MS);
}

// Due date `days` from today as yyyy-MM-dd — the format the task detail page stores and reads.
function dueDateInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const formatDue = (value: string | null | undefined) => (value ? new Date(value).toDateString() : "No due date");

export async function getAccessibleSpace(user: AgentUser, spaceId: unknown): Promise<Space> {
  if (typeof spaceId !== "string" || !spaceId) throw new AgentError(400, "Please choose a space.");
  const space = await storage.getSpace(spaceId);
  if (!space) throw new AgentError(404, "Space not found");
  if (space.companyId && space.companyId !== user.companyId) {
    throw new AgentError(403, "Access denied: this space belongs to another company");
  }
  return space;
}

async function getUserSpaces(user: AgentUser): Promise<Space[]> {
  const list = await storage.getSpacesForUser(user.id, user.companyId ?? null);
  return list.slice(0, MAX_SPACES);
}

export type TaskRow = { task: Task; statusName: string; kind: StatusKind };

export async function loadSpaceTasks(spaceId: string): Promise<TaskRow[]> {
  const [statuses, tasks] = await Promise.all([storage.getSpaceStatuses(spaceId), storage.getAllTasks(spaceId)]);
  const statusById = new Map(statuses.map((s) => [s.id, s.name]));
  return tasks.map((task) => {
    const statusName = statusById.get(task.statusId) ?? "Unknown";
    return { task, statusName, kind: statusKind(statusName) };
  });
}

async function firstStatusId(spaceId: string): Promise<string> {
  const statuses = await storage.getSpaceStatuses(spaceId);
  const first = [...statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  if (!first) throw new AgentError(400, "This space has no statuses to put tasks in.");
  return first.id;
}

export async function loadUserNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const users = await Promise.all(unique.map((id) => storage.getUser(id)));
  return new Map(unique.map((id, i) => [id, users[i]?.displayName || users[i]?.email || "Unknown user"]));
}

type NewTask = { title: string; description: string; priority: Priority; dueDate?: string | null; assigneeIds?: string[] };

// Creates tasks in the space's first status, like the "Create task" form does.
async function createTasks(user: AgentUser, spaceId: string, items: NewTask[]): Promise<Task[]> {
  const statusId = await firstStatusId(spaceId);
  const created: Task[] = [];
  for (const item of items) {
    const task = await storage.createTask({
      spaceId,
      name: item.title,
      description: item.description || "",
      statusId,
      priority: APP_PRIORITY[item.priority],
      ownerId: user.id,
      assigneeIds: item.assigneeIds ?? [],
      dueDate: item.dueDate ?? null,
      labels: [],
      estimatedHours: null,
      actualHours: null,
      attachments: [],
    });
    created.push(task);
    evaluateWorkflows("task.created", { task, userId: user.id, spaceId }).catch((err) =>
      console.error("[AI Agents] task.created workflow hook error:", err),
    );
  }
  return created;
}

const formatTaskList = (rows: TaskRow[], max = 25) =>
  rows.length
    ? rows
        .slice(0, max)
        .map((r) => `- ${r.task.name} (status: ${r.statusName}, due: ${formatDue(r.task.dueDate)})`)
        .join("\n")
    : "None";

/* ─────────────────────────────── 1) Project Planner ─────────────────────────────── */

async function previewProjectPlanner(_user: AgentUser, input: any) {
  const goal = text(input.goal, 2000);
  if (!goal) throw new AgentError(400, "Please describe the project goal.");
  const raw = await runAgentPrompt(
    PROJECT_PLANNER_SYSTEM,
    fill(PROJECT_PLANNER_USER, {
      goal,
      deadline: text(input.deadline, 100) || "Not specified",
      team_size: text(input.teamSize, 50) || "Not specified",
      context: text(input.context, 4000) || "None",
    }),
    3000,
  );
  return {
    project_name: text(raw.project_name, 120) || goal.slice(0, 80),
    project_summary: text(raw.project_summary, 1000),
    tasks: list(raw.tasks)
      .map((t) => ({
        title: text(t?.title, 200),
        description: text(t?.description, 2000),
        priority: priority(t?.priority),
        due_in_days: Math.max(0, Math.round(Number(t?.due_in_days) || 0)),
      }))
      .filter((t) => t.title)
      .slice(0, 15),
  };
}

async function applyProjectPlanner(user: AgentUser, payload: any) {
  const name = text(payload.project_name, 120);
  if (!name) throw new AgentError(400, "Project name is required.");
  const tasks = list(payload.tasks)
    .map((t) => ({
      title: text(t?.title, 200),
      description: text(t?.description, 2000),
      priority: priority(t?.priority),
      dueDate: dueDateInDays(Math.max(0, Math.round(Number(t?.due_in_days) || 0))),
    }))
    .filter((t) => t.title)
    .slice(0, 15);

  const space = await storage.createSpace({
    name,
    iconUrl: name[0].toUpperCase(),
    description: text(payload.project_summary, 1000) || null,
    defaultPermission: "full_access",
    privacy: "private",
    memberIds: [],
    teamIds: [],
    ownerId: user.id,
    companyId: user.companyId || null,
    statuses: DEFAULT_STATUSES,
  });
  const created = await createTasks(user, space.id, tasks);
  return { spaceId: space.id, spaceName: space.name, tasksCreated: created.length };
}

/* ─────────────────────────────── 2) Task Creator ─────────────────────────────── */

async function previewTaskCreator(_user: AgentUser, input: any) {
  const inputText = text(input.text, 12000);
  if (!inputText) throw new AgentError(400, "Please paste the notes or message to turn into tasks.");
  const raw = await runAgentPrompt(TASK_CREATOR_SYSTEM, fill(TASK_CREATOR_USER, { input_text: inputText }), 2000);
  return { tasks: normalizeTasks(raw.tasks, 20) };
}

async function applyTaskCreator(user: AgentUser, payload: any) {
  const space = await getAccessibleSpace(user, payload.spaceId);
  const tasks = normalizeTasks(payload.tasks, 20);
  if (!tasks.length) throw new AgentError(400, "Select at least one task to create.");
  const created = await createTasks(user, space.id, tasks);
  return { spaceId: space.id, spaceName: space.name, tasksCreated: created.length };
}

/* ─────────────────────────────── 3) Subtask Generator ─────────────────────────────── */

async function getAccessibleTask(user: AgentUser, taskId: unknown): Promise<Task> {
  if (typeof taskId !== "string" || !taskId) throw new AgentError(400, "Please choose a task.");
  const task = await storage.getTask(taskId);
  if (!task) throw new AgentError(404, "Task not found");
  await getAccessibleSpace(user, task.spaceId);
  return task;
}

async function previewSubtaskGenerator(user: AgentUser, input: any) {
  const task = await getAccessibleTask(user, input.taskId);
  const raw = await runAgentPrompt(
    SUBTASK_GENERATOR_SYSTEM,
    fill(SUBTASK_GENERATOR_USER, {
      task_title: task.name,
      task_description: text(task.description, 4000) || "No description",
    }),
    1000,
  );
  return {
    taskId: task.id,
    taskName: task.name,
    subtasks: list(raw.subtasks)
      .map((s) => ({ title: text(s?.title, 200) }))
      .filter((s) => s.title)
      .slice(0, 8),
  };
}

async function applySubtaskGenerator(user: AgentUser, payload: any) {
  const task = await getAccessibleTask(user, payload.taskId);
  const subtasks = list(payload.subtasks)
    .map((s) => text(s?.title, 200))
    .filter(Boolean)
    .slice(0, 8);
  if (!subtasks.length) throw new AgentError(400, "Select at least one subtask to add.");
  for (const [order, name] of subtasks.entries()) {
    await storage.createTaskSubtask({
      taskId: task.id,
      name,
      priority: null,
      assigneeId: null,
      dueDate: null,
      completed: false,
      order,
      createdBy: user.id,
    });
  }
  return { taskId: task.id, spaceId: task.spaceId, taskName: task.name, subtasksCreated: subtasks.length };
}

/* ─────────────────────────────── 4) Meeting Summarizer ─────────────────────────────── */

async function previewMeetingSummarizer(_user: AgentUser, input: any) {
  const notes = text(input.notes, 12000);
  if (!notes) throw new AgentError(400, "Please paste the meeting notes or transcript.");
  const raw = await runAgentPrompt(MEETING_SUMMARIZER_SYSTEM, fill(MEETING_SUMMARIZER_USER, { meeting_notes: notes }), 2000);
  return {
    summary: text(raw.summary, 2000),
    action_items: list(raw.action_items)
      .map((a) => ({
        title: text(a?.title, 200),
        description: text(a?.description, 2000),
        owner: text(a?.owner, 100) || null,
        priority: priority(a?.priority),
      }))
      .filter((a) => a.title)
      .slice(0, 20),
  };
}

async function applyMeetingSummarizer(user: AgentUser, payload: any) {
  const space = await getAccessibleSpace(user, payload.spaceId);
  const items = list(payload.action_items)
    .map((a) => ({
      title: text(a?.title, 200),
      description: text(a?.description, 2000),
      owner: text(a?.owner, 100),
      priority: priority(a?.priority),
    }))
    .filter((a) => a.title)
    .slice(0, 20);
  if (!items.length) throw new AgentError(400, "Select at least one action item to create.");

  // Match a mentioned owner to a space member by full name or first name.
  const memberIds = [space.ownerId, ...(space.memberIds ?? [])];
  const names = await loadUserNames(memberIds);
  const findMember = (owner: string) => {
    const wanted = owner.toLowerCase();
    for (const [id, name] of names) {
      const full = name.toLowerCase();
      if (full === wanted || full.split(" ")[0] === wanted.split(" ")[0]) return id;
    }
    return null;
  };

  const created = await createTasks(
    user,
    space.id,
    items.map((a) => {
      const assigneeId = a.owner ? findMember(a.owner) : null;
      const description =
        a.owner && !assigneeId ? `${a.description}\n\nSuggested owner: ${a.owner}`.trim() : a.description;
      return { title: a.title, description, priority: a.priority, assigneeIds: assigneeId ? [assigneeId] : [] };
    }),
  );
  return { spaceId: space.id, spaceName: space.name, tasksCreated: created.length };
}

/* ─────────────────────────────── 5) Status Reporter ─────────────────────────────── */

async function previewStatusReporter(user: AgentUser, input: any) {
  const space = await getAccessibleSpace(user, input.spaceId);
  const rows = await loadSpaceTasks(space.id);
  const overdue = rows.filter((r) => r.kind !== "done" && (daysUntil(r.task.dueDate) ?? 0) < 0);
  const recent = rows
    .filter((r) => (daysSince(r.task.updatedAt) ?? 99) <= 7)
    .sort((a, b) => new Date(b.task.updatedAt ?? 0).getTime() - new Date(a.task.updatedAt ?? 0).getTime());

  const raw = await runAgentPrompt(
    STATUS_REPORTER_SYSTEM,
    fill(STATUS_REPORTER_USER, {
      project_name: space.name,
      completed_tasks: formatTaskList(rows.filter((r) => r.kind === "done")),
      in_progress_tasks: formatTaskList(rows.filter((r) => r.kind === "in_progress")),
      overdue_tasks: formatTaskList(overdue),
      recent_activity: recent.length
        ? recent.slice(0, 15).map((r) => `- "${r.task.name}" updated, now ${r.statusName}`).join("\n")
        : "No activity in the last 7 days",
    }),
    1500,
  );
  const status = text(raw.overall_status);
  return {
    spaceId: space.id,
    projectName: space.name,
    overall_status: ["On Track", "At Risk", "Delayed"].includes(status) ? status : "At Risk",
    summary: text(raw.summary, 2000),
    completed_highlights: strings(raw.completed_highlights),
    in_progress: strings(raw.in_progress),
    blockers: strings(raw.blockers),
    next_steps: strings(raw.next_steps),
  };
}

/* ─────────────────────────────── 6) Follow-up Agent (automatic) ─────────────────────────────── */

const FOLLOW_UP_INACTIVE_DAYS = 3;
const FOLLOW_UP_NEAR_DEADLINE_DAYS = 1;
const FOLLOW_UP_MAX_PER_RUN = 50;

export type FollowUpResult = {
  taskId: string;
  taskName: string;
  spaceName: string;
  reason: string;
  message: string;
  notified: number;
};

// Tasks already reminded in the last 20h — keeps it to one reminder per task per day.
async function recentlyRemindedTaskIds(): Promise<Set<string>> {
  const since = new Date(Date.now() - 20 * 60 * 60 * 1000);
  const rows = await db
    .select({ metadata: notifications.metadata })
    .from(notifications)
    .where(and(eq(notifications.type, "follow_up"), gte(notifications.createdAt, since)));
  return new Set(rows.map((r) => (r.metadata as any)?.taskId).filter(Boolean));
}

function followUpReason(task: Task): string | null {
  const due = daysUntil(task.dueDate);
  if (due !== null && due < 0) return `Overdue by ${-due} day${due === -1 ? "" : "s"}`;
  if (due !== null && due <= FOLLOW_UP_NEAR_DEADLINE_DAYS) return due === 0 ? "Due today" : "Due tomorrow";
  const idle = daysSince(task.updatedAt);
  if (idle !== null && idle >= FOLLOW_UP_INACTIVE_DAYS) return `No activity for ${idle} days`;
  return null;
}

/**
 * Finds open tasks that are overdue, due within a day, or inactive for 3+ days,
 * writes a polite reminder with the LLM and notifies the assignees (or the owner).
 * With a user it covers that user's spaces (manual run); without one, all spaces (cron).
 */
export async function runFollowUpAgent(scope: { user?: AgentUser } = {}): Promise<FollowUpResult[]> {
  const spaceList = scope.user ? await getUserSpaces(scope.user) : await db.select().from(spaces);
  const reminded = await recentlyRemindedTaskIds();

  const candidates: { space: Space; row: TaskRow; reason: string }[] = [];
  for (const space of spaceList) {
    if (candidates.length >= FOLLOW_UP_MAX_PER_RUN) break;
    for (const row of await loadSpaceTasks(space.id)) {
      if (row.kind === "done" || reminded.has(row.task.id)) continue;
      const reason = followUpReason(row.task);
      if (reason) candidates.push({ space, row, reason });
      if (candidates.length >= FOLLOW_UP_MAX_PER_RUN) break;
    }
  }

  const names = await loadUserNames(candidates.flatMap((c) => [...(c.row.task.assigneeIds ?? []), c.row.task.ownerId]));
  const results: FollowUpResult[] = [];
  for (const { space, row, reason } of candidates) {
    const { task } = row;
    const recipients = task.assigneeIds?.length ? task.assigneeIds : [task.ownerId];
    try {
      const raw = await runAgentPrompt(
        FOLLOW_UP_SYSTEM,
        fill(FOLLOW_UP_USER, {
          task_title: task.name,
          assignee_name: recipients.map((id) => names.get(id)).filter(Boolean).join(", ") || "Team member",
          task_status: row.statusName,
          days_since_last_update: String(daysSince(task.updatedAt) ?? "Unknown"),
          due_date: formatDue(task.dueDate),
          reason,
        }),
        300,
      );
      const message = text(raw.message, 600);
      if (!message) continue;
      for (const userId of recipients) {
        await notify({
          userId,
          type: "follow_up",
          title: `Follow-up: ${task.name}`,
          message,
          link: `/spaces/${space.id}/tasks/${task.id}`,
          metadata: { taskId: task.id, spaceId: space.id, reason, agent: "follow-up-agent" },
        });
      }
      results.push({ taskId: task.id, taskName: task.name, spaceName: space.name, reason, message, notified: recipients.length });
    } catch (err) {
      console.error(`[Follow-up Agent] task ${task.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return results;
}

/* ─────────────────────────────── 7) Workload Analyzer ─────────────────────────────── */

async function previewWorkloadAnalyzer(user: AgentUser, input: any) {
  const spaceList = input.spaceId ? [await getAccessibleSpace(user, input.spaceId)] : await getUserSpaces(user);

  const perUser = new Map<string, { open: number; overdue: number; dueNext7Days: number; tasks: string[] }>();
  const unassigned: string[] = [];
  let unassignedCount = 0;
  for (const space of spaceList) {
    for (const { task, statusName, kind } of await loadSpaceTasks(space.id)) {
      if (kind === "done") continue;
      const due = daysUntil(task.dueDate);
      const assigneeIds = task.assigneeIds ?? [];
      if (assigneeIds.length === 0) {
        unassignedCount++;
        if (unassigned.length < 15) {
          unassigned.push(`${task.name} (${space.name}, ${statusName}, due: ${formatDue(task.dueDate)})`);
        }
        continue;
      }
      for (const id of assigneeIds) {
        const entry = perUser.get(id) ?? { open: 0, overdue: 0, dueNext7Days: 0, tasks: [] };
        entry.open++;
        if (due !== null && due < 0) entry.overdue++;
        else if (due !== null && due <= 7) entry.dueNext7Days++;
        if (entry.tasks.length < 10) {
          entry.tasks.push(`${task.name} (${space.name}, ${statusName}, due: ${formatDue(task.dueDate)})`);
        }
        perUser.set(id, entry);
      }
    }
  }

  if (perUser.size === 0 && unassignedCount === 0) {
    return {
      summary: "There are no open tasks right now, so there is no workload to analyze.",
      overloaded_users: [],
      reassignment_suggestions: [],
    };
  }

  const names = await loadUserNames([...perUser.keys()]);
  const workloadData = {
    team: [...perUser].map(([id, w]) => ({
      name: names.get(id),
      open_tasks: w.open,
      overdue_tasks: w.overdue,
      due_in_next_7_days: w.dueNext7Days,
      tasks: w.tasks,
    })),
    unassigned_tasks: { count: unassignedCount, examples: unassigned },
  };
  const raw = await runAgentPrompt(
    WORKLOAD_ANALYZER_SYSTEM,
    fill(WORKLOAD_ANALYZER_USER, { workload_data: JSON.stringify(workloadData, null, 2) }),
    1500,
  );
  return {
    summary: text(raw.summary, 2000),
    overloaded_users: list(raw.overloaded_users)
      .map((u) => ({ name: text(u?.name, 100), reason: text(u?.reason, 500) }))
      .filter((u) => u.name),
    reassignment_suggestions: list(raw.reassignment_suggestions)
      .map((s) => ({
        task_title: text(s?.task_title, 200),
        suggested_new_owner: text(s?.suggested_new_owner, 100),
        reason: text(s?.reason, 500),
      }))
      .filter((s) => s.task_title),
  };
}

/* ─────────────────────────────── 8) Executive Brief ─────────────────────────────── */

async function previewExecutiveBrief(user: AgentUser, input: any) {
  const periodDays = [7, 14, 30].includes(Number(input.periodDays)) ? Number(input.periodDays) : 7;
  const spaceList = await getUserSpaces(user);
  if (!spaceList.length) throw new AgentError(400, "You don't have any spaces yet to report on.");

  const projectsData = [];
  for (const space of spaceList) {
    const rows = await loadSpaceTasks(space.id);
    const names = (filtered: TaskRow[]) => filtered.slice(0, 5).map((r) => r.task.name);
    projectsData.push({
      project: space.name,
      total_tasks: rows.length,
      completed: rows.filter((r) => r.kind === "done").length,
      in_progress: rows.filter((r) => r.kind === "in_progress").length,
      not_started: rows.filter((r) => r.kind === "todo").length,
      overdue_tasks: names(rows.filter((r) => r.kind !== "done" && (daysUntil(r.task.dueDate) ?? 0) < 0)),
      completed_in_period: names(rows.filter((r) => r.kind === "done" && (daysSince(r.task.updatedAt) ?? 999) <= periodDays)),
      due_in_next_7_days: names(
        rows.filter((r) => {
          const due = daysUntil(r.task.dueDate);
          return r.kind !== "done" && due !== null && due >= 0 && due <= 7;
        }),
      ),
    });
  }

  const reportingPeriod = `Last ${periodDays} days`;
  const raw = await runAgentPrompt(
    EXECUTIVE_BRIEF_SYSTEM,
    fill(EXECUTIVE_BRIEF_USER, { reporting_period: reportingPeriod, projects_data: JSON.stringify(projectsData, null, 2) }),
    1500,
  );
  return {
    reportingPeriod,
    projectsCount: spaceList.length,
    summary: text(raw.summary, 2000),
    key_updates: strings(raw.key_updates),
    risks: strings(raw.risks),
    delays: strings(raw.delays),
    highlights: strings(raw.highlights),
  };
}

/* ─────────────────────────────── Dispatch ─────────────────────────────── */

type Handler = (user: AgentUser, input: any) => Promise<unknown>;

const PREVIEW: Record<string, Handler> = {
  "project-planner": previewProjectPlanner,
  "task-creator": previewTaskCreator,
  "subtask-generator": previewSubtaskGenerator,
  "meeting-summarizer": previewMeetingSummarizer,
  "status-reporter": previewStatusReporter,
  "workload-analyzer": previewWorkloadAnalyzer,
  "executive-brief": previewExecutiveBrief,
};

// Only agents that change data have an apply step; the rest are view/export only.
const APPLY: Record<string, Handler> = {
  "project-planner": applyProjectPlanner,
  "task-creator": applyTaskCreator,
  "subtask-generator": applySubtaskGenerator,
  "meeting-summarizer": applyMeetingSummarizer,
};

export async function previewAgent(agentId: string, user: AgentUser, input: unknown) {
  const handler = PREVIEW[agentId];
  if (!handler) throw new AgentError(404, `Unknown agent: ${agentId}`);
  return handler(user, input && typeof input === "object" ? input : {});
}

export async function applyAgent(agentId: string, user: AgentUser, payload: unknown) {
  const handler = APPLY[agentId];
  if (!handler) throw new AgentError(400, `${agentId} has no actions to apply`);
  return handler(user, payload && typeof payload === "object" ? payload : {});
}

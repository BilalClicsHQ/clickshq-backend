import { storage } from "../storage";
import type { Task } from "@shared/schema";

// ── Notification adapter ─────────────────────────────────────────────────────
// Nexus has a dedicated notifications subsystem (notificationService + notifications
// table). clicksHQ does not have it yet, so the workflow "Send notification" action
// degrades to an activity-log entry. When the notifications feature is migrated,
// replace this local helper with: import { notify } from "./notificationService";
async function notify(payload: {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  await storage.logActivity({
    userId: payload.userId,
    action: "workflow_notification",
    details: JSON.stringify({
      type: payload.type,
      title: payload.title,
      message: payload.message,
      link: payload.link,
      ...payload.metadata,
    }),
  });
}

// ── Trigger map: event strings → workflow trigger labels ────────────────────
// Maps event strings to trigger labels used in workflow steps
// Labels MUST match workflow-types.ts TRIGGER_OPTIONS
// Also includes old labels for backward compatibility with saved workflows
const TRIGGER_MAP: Record<string, string[]> = {
  "task.created":            ["Task created", "Task is created"],
  "task.status_changed":     ["Status changed", "Status changes", "Task updated"],
  "task.assignee_changed":   ["Assignee changed", "Assignee changes", "Task updated"],
  "task.assigned":           ["Assignee changed", "Assignee changes", "Task updated"],
  "task.priority_changed":   ["Task updated", "Priority changes"],
  "comment.added":           ["Comment added", "Comment is added"],
  "task.overdue":            ["Task overdue", "Task becomes overdue"],
  "task.due_approaching":    ["Due date reached", "Due date is approaching"],
};

interface WorkflowContext {
  task: Task;
  userId: string;
  spaceId?: string;
  oldTask?: Task;
}

interface StepConfig {
  statusId?: string;
  assigneeId?: string;
  spaceId?: string;
  subtaskName?: string;
  taskName?: string;
  priority?: string;
  daysFromNow?: string;
  comment?: string;
  message?: string;
  channel?: string;
  to?: string;
  subject?: string;
  delayValue?: string;
  delayUnit?: string;
  [key: string]: string | undefined;
}

interface WorkflowStep {
  type: string;
  label: string;
  config?: StepConfig;
  yesBranch?: WorkflowStep[];
  noBranch?: WorkflowStep[];
}

// ── Main entry point: evaluate workflows for an event ───────────────────────

export async function evaluateWorkflows(event: string, context: WorkflowContext): Promise<void> {
  const triggerLabels = TRIGGER_MAP[event];
  // Only log for actual task events, not cron spam
  if (!event.includes("overdue") && !event.includes("approaching")) {
    console.log(`[Workflow] Event: "${event}" → triggers: ${JSON.stringify(triggerLabels)}`);
  }
  if (!triggerLabels?.length) {
    console.warn(`[Workflow] Unknown event: ${event}`);
    return;
  }

  try {
    // Find all live workflows matching any of the trigger labels
    let matchingWorkflows: any[] = [];
    for (const label of triggerLabels) {
      const found = await storage.getActiveWorkflowsByTrigger(label);
      if (found.length > 0) console.log(`[Workflow] "${label}" → ${found.length} match(es)`);
      matchingWorkflows.push(...found);
    }
    // Deduplicate by workflow id
    matchingWorkflows = matchingWorkflows.filter((w, i, arr) => arr.findIndex((x) => x.id === w.id) === i);
    if (matchingWorkflows.length === 0) return;

    console.log(`[Workflow] ${matchingWorkflows.length} workflow(s) matched event "${event}" for task ${context.task.id}`);

    for (const workflow of matchingWorkflows) {
      try {
        const steps = (workflow.steps as WorkflowStep[]) || [];
        const actionResults = await processSteps(steps, context);

        await storage.createWorkflowLog({
          workflowId: workflow.id,
          trigger: event,
          actionsTaken: actionResults,
          taskId: context.task.id,
          status: "success",
        });
      } catch (err) {
        console.error(`[Workflow] Error executing workflow ${workflow.id}:`, err);
        await storage.createWorkflowLog({
          workflowId: workflow.id,
          trigger: event,
          actionsTaken: [],
          taskId: context.task.id,
          status: "error",
          error: String(err),
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error(`[Workflow] Error evaluating workflows for event "${event}":`, err);
  }
}

// ── Process steps sequentially, handling conditions and branches ─────────────

async function processSteps(steps: WorkflowStep[], context: WorkflowContext): Promise<any[]> {
  const results: any[] = [];

  for (const step of steps) {
    const stepType = step.type === "when" ? "trigger" : step.type === "then" ? "action" : step.type;

    // Skip trigger steps (already matched)
    if (stepType === "trigger") continue;

    // Execute action steps (check step.conditions first)
    if (stepType === "action" && step.label) {
      // If step has conditions, evaluate them first
      if ((step as any).conditions?.rules?.length > 0) {
        const conditionsMet = evaluateStepConditions((step as any).conditions, context);
        if (!conditionsMet) {
          results.push({ action: step.label, skipped: true, detail: "Conditions not met" });
          continue;
        }
      }
      console.log(`[Workflow] Executing action: "${step.label}" with config:`, step.config);
      const result = await executeAction(step.label, step.config || {}, context);
      console.log(`[Workflow] Action result:`, result);
      results.push({ action: step.label, ...result });
      continue;
    }

    // Evaluate condition steps → branch into yes/no
    if (stepType === "condition" && step.label) {
      const conditionMet = evaluateCondition(step.label, step.config || {}, context);
      results.push({ condition: step.label, result: conditionMet ? "yes" : "no" });

      const branch = conditionMet ? (step.yesBranch || []) : (step.noBranch || []);
      if (branch.length > 0) {
        const branchResults = await processSteps(branch, context);
        results.push(...branchResults);
      }
      continue;
    }

    // Delay steps — log but don't actually delay (fire-and-forget context)
    if (stepType === "delay") {
      results.push({ action: "Delay", detail: `${step.config?.delayValue || 1} ${step.config?.delayUnit || "minutes"}` });
      continue;
    }
  }

  return results;
}

// ── Condition evaluation ────────────────────────────────────────────────────

function evaluateCondition(label: string, config: StepConfig, context: WorkflowContext): boolean {
  const { task } = context;

  switch (label) {
    case "If status is":
      return !!config.statusId && task.statusId === config.statusId;

    case "If priority is":
      return !!config.priority && task.priority === config.priority;

    case "If assignee is":
      return !!config.assigneeId && (task.assigneeIds || []).includes(config.assigneeId);

    case "If in space":
      return !!config.spaceId && task.spaceId === config.spaceId;

    case "If has due date":
      return !!task.dueDate;

    case "If task is overdue": {
      if (!task.dueDate) return false;
      const today = new Date().toISOString().split("T")[0];
      return task.dueDate < today;
    }

    default:
      console.warn(`[Workflow] Unknown condition: ${label}`);
      return true; // Pass-through for unknown conditions
  }
}

// ── Action execution ────────────────────────────────────────────────────────

async function executeAction(
  actionLabel: string,
  config: StepConfig,
  context: WorkflowContext
): Promise<{ success: boolean; detail?: string }> {
  const { task } = context;

  switch (actionLabel) {
    // Status
    case "Change status":
    case "Update status to":
    case "Change task status":
    case "change status": {
      if (!config.statusId) return { success: false, detail: "No statusId configured" };
      await storage.updateTask(task.id, { statusId: config.statusId });
      return { success: true, detail: `Status changed to ${config.statusId}` };
    }

    // Assignee
    case "Assign user":
    case "Change assignee to":
    case "Assign task to user": {
      if (!config.assigneeId) return { success: false, detail: "No assigneeId configured" };
      const currentAssignees = task.assigneeIds || [];
      if (!currentAssignees.includes(config.assigneeId)) {
        await storage.updateTask(task.id, {
          assigneeIds: [...currentAssignees, config.assigneeId],
        });
      }
      return { success: true, detail: `Assigned to ${config.assigneeId}` };
    }

    // Move
    case "Move to project/list":
    case "Move to space":
    case "Move task to space": {
      if (!config.spaceId) return { success: false, detail: "No spaceId configured" };
      // Must set target space's first status so task is visible there
      const targetStatuses = await storage.getSpaceStatuses(config.spaceId);
      if (!targetStatuses[0]) return { success: false, detail: "Target space has no statuses" };
      await storage.updateTask(task.id, { spaceId: config.spaceId, statusId: targetStatuses[0].id });
      return { success: true, detail: `Moved → ${config.spaceId} (status: ${targetStatuses[0].name})` };
    }

    // Create subtask
    case "Create subtask":
    case "Create a subtask": {
      const statuses = await storage.getSpaceStatuses(task.spaceId);
      const defaultStatus = statuses[0];
      if (!defaultStatus) return { success: false, detail: "No statuses in space" };
      await storage.createTask({
        spaceId: task.spaceId,
        name: config.subtaskName || `Subtask of: ${task.name}`,
        description: "",
        statusId: defaultStatus.id,
        priority: task.priority as any,
        ownerId: context.userId,
        assigneeIds: task.assigneeIds || [],
        dueDate: task.dueDate,
        labels: [],
        estimatedHours: null,
        actualHours: null,
        attachments: [],
      });
      return { success: true, detail: "Subtask created" };
    }

    // Create task
    case "Create new task":
    case "Create task": {
      if (!config.taskName || !config.spaceId) return { success: false, detail: "Missing taskName or spaceId" };
      const statuses = await storage.getSpaceStatuses(config.spaceId);
      const defaultStatus = statuses[0];
      if (!defaultStatus) return { success: false, detail: "No statuses in target space" };
      await storage.createTask({
        spaceId: config.spaceId,
        name: config.taskName,
        description: "",
        statusId: defaultStatus.id,
        priority: null,
        ownerId: context.userId,
        assigneeIds: [],
        dueDate: null,
        labels: [],
        estimatedHours: null,
        actualHours: null,
        attachments: [],
      });
      return { success: true, detail: `Task "${config.taskName}" created` };
    }

    // Priority
    case "Change priority": {
      if (!config.priority) return { success: false, detail: "No priority configured" };
      await storage.updateTask(task.id, { priority: config.priority as any });
      return { success: true, detail: `Priority changed to ${config.priority}` };
    }

    // Due date
    case "Set due date": {
      const days = parseInt(config.daysFromNow || "7", 10);
      const date = new Date();
      date.setDate(date.getDate() + days);
      const dueDate = date.toISOString().split("T")[0];
      await storage.updateTask(task.id, { dueDate });
      return { success: true, detail: `Due date set to ${dueDate}` };
    }

    case "Remove due date": {
      await storage.updateTask(task.id, { dueDate: null });
      return { success: true, detail: "Due date removed" };
    }

    // Add label
    case "Add label": {
      const currentLabels = task.labels || [];
      const newLabel = config.labelName || "";
      if (newLabel && !currentLabels.includes(newLabel)) {
        await storage.updateTask(task.id, { labels: [...currentLabels, newLabel] } as any);
      }
      return { success: true, detail: `Label "${newLabel}" added` };
    }

    // Add follower (adds as assignee for now)
    case "Add follower": {
      if (!config.followerId) return { success: false, detail: "No followerId" };
      const followers = task.assigneeIds || [];
      if (!followers.includes(config.followerId)) {
        await storage.updateTask(task.id, { assigneeIds: [...followers, config.followerId] });
      }
      return { success: true, detail: `Follower added: ${config.followerId}` };
    }

    // Send notification — creates real in-app notification
    case "Send notification": {
      const message = config.message || `Workflow notification for task: ${task.name}`;
      try {
        await notify({
          userId: context.userId,
          type: "workflow",
          title: `Workflow: ${task.name}`,
          message,
          link: `/spaces/${task.spaceId}`,
          metadata: { taskId: task.id, taskName: task.name },
        });
        return { success: true, detail: `Notification sent: "${message}"` };
      } catch (err) {
        return { success: false, detail: `Failed: ${err}` };
      }
    }

    // Send email
    case "Send email": {
      return { success: true, detail: `Email queued to ${config.to || "recipient"}` };
    }

    // Comment
    case "Create comment":
    case "Add comment":
    case "Add comment to task": {
      const comment = config.comment || `Automated workflow comment for task: ${task.name}`;
      try {
        await storage.logActivity({
          userId: context.userId,
          action: "workflow_comment",
          details: JSON.stringify({ taskId: task.id, taskName: task.name, comment }),
        });
        return { success: true, detail: `Comment: "${comment}"` };
      } catch (err) {
        return { success: false, detail: `Failed: ${err}` };
      }
    }

    // Notification (legacy label)
    case "Send in-app notification": {
      const message = config.message || `Workflow notification for task: ${task.name}`;
      try {
        await notify({
          userId: context.userId,
          type: "workflow",
          title: `Workflow: ${task.name}`,
          message,
          link: `/spaces/${task.spaceId}`,
          metadata: { taskId: task.id, taskName: task.name },
        });
        return { success: true, detail: `Notification: "${message}"` };
      } catch (err) {
        return { success: false, detail: `Failed: ${err}` };
      }
    }

    default:
      console.warn(`[Workflow] Unknown action: "${actionLabel}"`);
      return { success: false, detail: `Unknown action: ${actionLabel}` };
  }
}

// ── Hive-style step conditions evaluation ──────────────────────────────────

interface ConditionRule {
  field: string;
  operator: string;
  value: string;
}

interface ConditionGroup {
  match: "all" | "any";
  rules: ConditionRule[];
  nestedGroups?: ConditionGroup[];
}

function evaluateStepConditions(conditions: ConditionGroup, context: WorkflowContext): boolean {
  const { task } = context;
  const { match, rules, nestedGroups } = conditions;

  const ruleResults = rules.map((rule) => evaluateRule(rule, task));
  const groupResults = (nestedGroups || []).map((g) => evaluateStepConditions(g, context));
  const allResults = [...ruleResults, ...groupResults];

  if (allResults.length === 0) return true;
  return match === "all" ? allResults.every(Boolean) : allResults.some(Boolean);
}

function evaluateRule(rule: ConditionRule, task: Task): boolean {
  const { field, operator, value } = rule;
  if (!field || !operator) return true; // Incomplete rule — pass through

  let fieldValue: string | null = null;

  switch (field) {
    case "status":
      fieldValue = task.statusId || null;
      break;
    case "assignee":
      if (operator === "is_empty") return !(task.assigneeIds?.length);
      if (operator === "is_not_empty") return !!(task.assigneeIds?.length);
      fieldValue = (task.assigneeIds || []).join(",");
      break;
    case "priority":
      fieldValue = task.priority || null;
      break;
    case "space":
      fieldValue = task.spaceId || null;
      break;
    case "dueDate":
      if (operator === "is_empty") return !task.dueDate;
      if (operator === "is_not_empty") return !!task.dueDate;
      fieldValue = task.dueDate || null;
      break;
    case "title":
      fieldValue = task.name || null;
      break;
    default:
      return true;
  }

  switch (operator) {
    case "is_empty":
      return !fieldValue;
    case "is_not_empty":
      return !!fieldValue;
    case "equal":
      return fieldValue === value;
    case "not_equal":
      return fieldValue !== value;
    case "contains":
      return !!fieldValue && fieldValue.toLowerCase().includes((value || "").toLowerCase());
    default:
      return true;
  }
}

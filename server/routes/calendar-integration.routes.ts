/**
 * Calendar Integration routes — Google Calendar focused (Outlook reuses same table).
 *
 * Mounted at /api/integrations/calendar.
 *
 *   GET    /tasks/:taskId/events                – List linked events
 *   POST   /tasks/:taskId/sync-due-date         – Create/update event for task's due date
 *   DELETE /tasks/:taskId/sync-due-date         – Remove the due-date event
 *   POST   /tasks/:taskId/schedule-meeting      – Schedule a meeting (optionally with Meet)
 *   DELETE /tasks/:taskId/events/:eventId       – Remove any linked event
 *   GET    /unified                             – Calendar view combining meetings + task due dates
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { getValidToken } from "../services/tokenService";
import {
  createEvent,
  updateEvent,
  deleteEvent,
  listEvents,
} from "../services/calendarService";

const router = Router();

async function userCalToken(userId: string) {
  try {
    return await getValidToken(userId, "google_calendar");
  } catch {
    return null;
  }
}

// ── List events linked to a task ────────────────────────────────────────────
router.get(
  "/tasks/:taskId/events",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const events = await storage.getTaskCalendarEvents(req.params.taskId);
      return res.json({ success: true, data: events });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Sync task due date → Google Calendar event ──────────────────────────────
router.post(
  "/tasks/:taskId/sync-due-date",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;

      const task = await storage.getTask(taskId);
      if (!task) {
        return res
          .status(404)
          .json({ success: false, error: { code: "TASK_NOT_FOUND" } });
      }
      if (!task.dueDate) {
        return res
          .status(400)
          .json({ success: false, error: { code: "NO_DUE_DATE" } });
      }

      const token = await userCalToken(user.id);
      if (!token) {
        return res
          .status(403)
          .json({ success: false, error: { code: "NOT_CONNECTED", message: "Connect Google Calendar first" } });
      }

      // dueDate is YYYY-MM-DD → all-day event (timezone agnostic)
      const dueDate = task.dueDate;
      const isoStart = `${dueDate}T00:00:00`;
      const isoEnd = `${dueDate}T23:59:00`;
      const userTz = req.body?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

      const summary = `Due: ${task.name}`;
      const description = `Task from clicsHQ\n\nTASK-${task.shortId ?? task.id}\n\n${(task.description ?? "").replace(/<[^>]+>/g, "")}`;

      // Check if we already created an event for this task
      const existing = await storage.findTaskCalendarEventByType(taskId, "due_date_sync");

      let event;
      if (existing) {
        // Update existing event
        event = await updateEvent(
          token.accessToken,
          existing.externalEventId,
          {
            summary,
            description,
            startDateTime: isoStart,
            endDateTime: isoEnd,
            isAllDay: true,
            timeZone: userTz,
          },
          existing.calendarId,
          token.refreshToken,
        );
        await storage.updateTaskCalendarEvent(existing.id, {
          summary,
          startsAt: new Date(isoStart),
          endsAt: new Date(isoEnd),
          isAllDay: true,
        });
      } else {
        event = await createEvent(
          token.accessToken,
          {
            summary,
            description,
            startDateTime: isoStart,
            endDateTime: isoEnd,
            isAllDay: true,
            timeZone: userTz,
          },
          "primary",
          token.refreshToken,
        );
        await storage.createTaskCalendarEvent({
          taskId,
          provider: "google_calendar",
          externalEventId: event.id,
          calendarId: "primary",
          summary,
          startsAt: new Date(isoStart),
          endsAt: new Date(isoEnd),
          isAllDay: true,
          type: "due_date_sync",
          eventUrl: event.htmlLink,
          createdBy: user.id,
        });
        await storage.createTaskActivity({
          taskId,
          type: "google_calendar_due_date_synced",
          actorUserId: user.id,
          payload: { eventId: event.id, eventUrl: event.htmlLink },
        }).catch(() => undefined);
      }

      return res.json({ success: true, data: { event } });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Remove due-date sync ────────────────────────────────────────────────────
router.delete(
  "/tasks/:taskId/sync-due-date",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const existing = await storage.findTaskCalendarEventByType(taskId, "due_date_sync");
      if (!existing) return res.json({ success: true });

      const token = await userCalToken(user.id);
      if (token) {
        await deleteEvent(token.accessToken, existing.externalEventId, existing.calendarId, token.refreshToken).catch(
          () => undefined,
        );
      }
      await storage.deleteTaskCalendarEvent(existing.id);
      return res.json({ success: true });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Schedule a meeting from task (optionally with Google Meet) ──────────────
router.post(
  "/tasks/:taskId/schedule-meeting",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const { startDateTime, endDateTime, summary, description, attendees, timeZone, createMeetLink } = req.body;

      if (!startDateTime || !endDateTime) {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_TIMES" } });
      }

      const token = await userCalToken(user.id);
      if (!token) {
        return res
          .status(403)
          .json({ success: false, error: { code: "NOT_CONNECTED" } });
      }

      const task = await storage.getTask(taskId);
      const finalSummary = summary || `Meeting: ${task?.name ?? "Task"}`;

      const event = await createEvent(
        token.accessToken,
        {
          summary: finalSummary,
          description: description || (task ? `Linked to TASK-${task.shortId ?? task.id}` : ""),
          startDateTime,
          endDateTime,
          timeZone,
          attendees: (attendees ?? []).map((email: string) => ({ email })),
          createMeetLink: !!createMeetLink,
        },
        "primary",
        token.refreshToken,
      );

      const meetLink =
        event.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === "video")?.uri ?? null;

      const linked = await storage.createTaskCalendarEvent({
        taskId,
        provider: "google_calendar",
        externalEventId: event.id,
        calendarId: "primary",
        summary: finalSummary,
        startsAt: new Date(startDateTime),
        endsAt: new Date(endDateTime),
        isAllDay: false,
        type: "meeting",
        meetLink,
        eventUrl: event.htmlLink,
        createdBy: user.id,
        metadata: { attendees: attendees ?? [] },
      });

      await storage.createTaskActivity({
        taskId,
        type: "google_calendar_meeting_scheduled",
        actorUserId: user.id,
        payload: {
          eventId: event.id,
          eventUrl: event.htmlLink,
          meetLink,
          summary: finalSummary,
          startsAt: startDateTime,
        },
      }).catch(() => undefined);

      return res.json({ success: true, data: { event, linked } });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Delete a linked event ───────────────────────────────────────────────────
router.delete(
  "/tasks/:taskId/events/:eventId",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { eventId } = req.params;
      // eventId here is the local link row id
      const events = await storage.getTaskCalendarEvents(req.params.taskId);
      const target = events.find((e) => e.id === eventId);
      if (!target) return res.json({ success: true });

      const token = await userCalToken(user.id);
      if (token) {
        await deleteEvent(token.accessToken, target.externalEventId, target.calendarId, token.refreshToken).catch(
          () => undefined,
        );
      }
      await storage.deleteTaskCalendarEvent(target.id);
      return res.json({ success: true });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Unified Calendar View — meetings + task due dates ──────────────────────
router.get(
  "/unified",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { from, to, spaceId } = req.query;
      if (!from || !to) {
        return res.status(400).json({ success: false, error: { code: "MISSING_RANGE" } });
      }

      // 1. Google Calendar events (live from Google)
      let calendarEvents: any[] = [];
      const token = await userCalToken(user.id);
      if (token) {
        try {
          const result = await listEvents(token.accessToken, {
            refreshToken: token.refreshToken,
            calendarId: "primary",
            timeMin: String(from),
            timeMax: String(to),
          });
          calendarEvents = (result.events ?? []).map((e: any) => ({
            kind: "calendar_event",
            id: e.id,
            title: e.summary,
            start: e.start,
            end: e.end,
            isAllDay: e.isAllDay,
            url: e.htmlLink,
            location: e.location,
            attendees: e.attendees,
          }));
        } catch {
          // Continue without calendar events if API fails
        }
      }

      // 2. Tasks with due dates in this space
      const tasks = spaceId
        ? await storage.getAllTasks(String(spaceId))
        : [];
      const fromDate = new Date(String(from));
      const toDate = new Date(String(to));
      const tasksInRange = tasks
        .filter((t) => t.dueDate)
        .filter((t) => {
          const d = new Date(t.dueDate as string);
          return d >= fromDate && d <= toDate;
        })
        .map((t) => ({
          kind: "task_due",
          id: t.id,
          title: t.name,
          start: t.dueDate,
          end: t.dueDate,
          isAllDay: true,
          taskId: t.id,
          shortId: t.shortId,
          spaceId: t.spaceId,
          priority: t.priority,
          url: `/spaces/${t.spaceId}/tasks/${t.id}`,
        }));

      return res.json({
        success: true,
        data: {
          calendarEvents,
          taskDueDates: tasksInRange,
        },
      });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

export default router;

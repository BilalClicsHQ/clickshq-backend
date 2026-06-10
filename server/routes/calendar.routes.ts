import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { requireIntegration } from '../middleware/requireIntegration';
import {
  listCalendars,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  quickAddEvent,
} from '../services/calendarService';

const router = Router();

// All routes require auth + valid Google Calendar token
const calendarGuard = [requireAuth, requireIntegration('google_calendar')];

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/calendar/calendars
// Lists all calendars the user has access to.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/calendars', ...calendarGuard, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const calendars = await listCalendars(token.accessToken, token.refreshToken);
    return res.json({ success: true, data: { calendars } });
  } catch (err: any) {
    console.error('Calendar list error:', err.message);
    return res.status(mapCalendarError(err)).json({
      success: false,
      error: {
        code: 'CALENDAR_API_ERROR',
        message: `Failed to list calendars: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/calendar/events
// Lists events from a calendar.
// Query: ?calendarId=xxx&timeMin=ISO&timeMax=ISO&pageSize=50&pageToken=xxx&q=search&syncToken=xxx
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/events', ...calendarGuard, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { calendarId, timeMin, timeMax, pageSize, pageToken, q, syncToken } = req.query;

    const result = await listEvents(token.accessToken, {
      refreshToken: token.refreshToken,
      calendarId: calendarId as string | undefined,
      timeMin: timeMin as string | undefined,
      timeMax: timeMax as string | undefined,
      pageSize: pageSize ? parseInt(pageSize as string, 10) : 50,
      pageToken: pageToken as string | undefined,
      query: q as string | undefined,
      syncToken: syncToken as string | undefined,
    });

    return res.json({ success: true, data: result });
  } catch (err: any) {
    console.error('Calendar events error:', err.message);
    return res.status(mapCalendarError(err)).json({
      success: false,
      error: {
        code: 'CALENDAR_API_ERROR',
        message: `Failed to list events: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/calendar/events/:eventId
// Gets a single event by ID.
// Query: ?calendarId=xxx
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/events/:eventId', ...calendarGuard, async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const calendarId = req.query.calendarId as string | undefined;
    const token = req.integrationToken!;

    const event = await getEvent(token.accessToken, eventId, calendarId || 'primary', token.refreshToken);
    return res.json({ success: true, data: { event } });
  } catch (err: any) {
    console.error('Calendar get event error:', err.message);
    return res.status(mapCalendarError(err)).json({
      success: false,
      error: {
        code: 'CALENDAR_API_ERROR',
        message: `Failed to get event: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/calendar/events
// Creates a new calendar event.
// Body: { summary, description?, location?, startDateTime, endDateTime, timeZone?,
//         attendees?, isAllDay?, recurrence?, calendarId? }
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/events', ...calendarGuard, async (req: Request, res: Response) => {
  try {
    const { summary, description, location, startDateTime, endDateTime, timeZone, attendees, isAllDay, recurrence, calendarId } = req.body;

    if (!summary || !startDateTime || !endDateTime) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'summary, startDateTime, and endDateTime are required', retryable: false },
      });
    }

    const token = req.integrationToken!;
    const event = await createEvent(
      token.accessToken,
      { summary, description, location, startDateTime, endDateTime, timeZone, attendees, isAllDay, recurrence },
      calendarId || 'primary',
      token.refreshToken
    );

    return res.json({ success: true, data: { event } });
  } catch (err: any) {
    console.error('Calendar create event error:', err.message);
    return res.status(mapCalendarError(err)).json({
      success: false,
      error: {
        code: 'CALENDAR_API_ERROR',
        message: `Failed to create event: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/calendar/events/:eventId
// Updates an existing calendar event.
// Body: { summary?, description?, location?, startDateTime?, endDateTime?, timeZone?,
//         attendees?, status?, calendarId? }
// ═══════════════════════════════════════════════════════════════════════════════
router.patch('/events/:eventId', ...calendarGuard, async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const { summary, description, location, startDateTime, endDateTime, timeZone, attendees, status, calendarId } = req.body;

    const token = req.integrationToken!;
    const event = await updateEvent(
      token.accessToken,
      eventId,
      { summary, description, location, startDateTime, endDateTime, timeZone, attendees, status },
      calendarId || 'primary',
      token.refreshToken
    );

    return res.json({ success: true, data: { event } });
  } catch (err: any) {
    console.error('Calendar update event error:', err.message);
    return res.status(mapCalendarError(err)).json({
      success: false,
      error: {
        code: 'CALENDAR_API_ERROR',
        message: `Failed to update event: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/calendar/events/:eventId
// Deletes a calendar event.
// Query: ?calendarId=xxx
// ═══════════════════════════════════════════════════════════════════════════════
router.delete('/events/:eventId', ...calendarGuard, async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const calendarId = req.query.calendarId as string | undefined;
    const token = req.integrationToken!;

    await deleteEvent(token.accessToken, eventId, calendarId || 'primary', token.refreshToken);
    return res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    console.error('Calendar delete event error:', err.message);
    return res.status(mapCalendarError(err)).json({
      success: false,
      error: {
        code: 'CALENDAR_API_ERROR',
        message: `Failed to delete event: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/calendar/quick-add
// Creates an event using natural language.
// Body: { text, calendarId? }
// Example: { text: "Meeting with Ali tomorrow at 3pm" }
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/quick-add', ...calendarGuard, async (req: Request, res: Response) => {
  try {
    const { text, calendarId } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'text is required', retryable: false },
      });
    }

    const token = req.integrationToken!;
    const event = await quickAddEvent(token.accessToken, text, calendarId || 'primary', token.refreshToken);

    return res.json({ success: true, data: { event } });
  } catch (err: any) {
    console.error('Calendar quick-add error:', err.message);
    return res.status(mapCalendarError(err)).json({
      success: false,
      error: {
        code: 'CALENDAR_API_ERROR',
        message: `Failed to quick-add event: ${err.message}`,
        retryable: isRetryable(err),
      },
    });
  }
});

// ─── Error Helpers ───────────────────────────────────────────────────────────
function mapCalendarError(err: any): number {
  const code = err.code || err.status || err.response?.status;
  if (code === 401) return 401;
  if (code === 403) return 403;
  if (code === 404) return 404;
  if (code === 409) return 409;
  if (code === 429) return 429;
  return 500;
}

function isRetryable(err: any): boolean {
  const code = err.code || err.status || err.response?.status;
  return code === 429 || code === 503 || code === 504;
}

export default router;

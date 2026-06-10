import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { requireIntegration } from '../middleware/requireIntegration';

const router = Router();
const outlookCalAuth = [requireAuth, requireIntegration('outlook_calendar')];

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ─── GET /calendars — List user's calendars ─────────────────────────────────
router.get('/calendars', ...outlookCalAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const graphRes = await fetch(`${GRAPH_BASE}/me/calendars`, {
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch calendars' } });
    }
    const data = await graphRes.json() as any;
    return res.json({ success: true, data: data.value || [] });
  } catch (err: any) {
    console.error('[Outlook Calendar] Error fetching calendars:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

// ─── GET /events — List events (with optional time range) ───────────────────
router.get('/events', ...outlookCalAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { startDateTime, endDateTime, top } = req.query;

    let url = `${GRAPH_BASE}/me/calendarview`;
    if (startDateTime && endDateTime) {
      url += `?startDateTime=${encodeURIComponent(String(startDateTime))}&endDateTime=${encodeURIComponent(String(endDateTime))}&$top=${top || 50}&$orderby=start/dateTime`;
    } else {
      // Default: next 30 days
      const now = new Date();
      const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      url += `?startDateTime=${now.toISOString()}&endDateTime=${thirtyDays.toISOString()}&$top=${top || 50}&$orderby=start/dateTime`;
    }

    const graphRes = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token.accessToken}`, 'Prefer': 'outlook.timezone="UTC"' },
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to fetch events' } });
    }
    const data = await graphRes.json() as any;
    return res.json({ success: true, data: data.value || [] });
  } catch (err: any) {
    console.error('[Outlook Calendar] Error fetching events:', err.message);
    return res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
});

// ─── POST /events — Create an event ─────────────────────────────────────────
router.post('/events', ...outlookCalAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { subject, body, start, end, attendees, location, isOnlineMeeting } = req.body;

    if (!subject || !start || !end) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'subject, start, and end are required' } });
    }

    const event: any = {
      subject,
      start: { dateTime: start, timeZone: 'UTC' },
      end: { dateTime: end, timeZone: 'UTC' },
    };
    if (body) event.body = { contentType: 'HTML', content: body };
    if (location) event.location = { displayName: location };
    if (isOnlineMeeting) event.isOnlineMeeting = true;
    if (attendees?.length) {
      event.attendees = attendees.map((email: string) => ({
        emailAddress: { address: email },
        type: 'required',
      }));
    }

    const graphRes = await fetch(`${GRAPH_BASE}/me/events`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!graphRes.ok) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to create event' } });
    }
    const data = await graphRes.json();
    return res.status(201).json({ success: true, data });
  } catch (err: any) {
    console.error('[Outlook Calendar] Error creating event:', err.message);
    return res.status(500).json({ success: false, error: { code: 'CREATE_FAILED', message: err.message } });
  }
});

// ─── DELETE /events/:eventId — Delete an event ──────────────────────────────
router.delete('/events/:eventId', ...outlookCalAuth, async (req: Request, res: Response) => {
  try {
    const token = req.integrationToken!;
    const { eventId } = req.params;

    const graphRes = await fetch(`${GRAPH_BASE}/me/events/${eventId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token.accessToken}` },
    });
    if (!graphRes.ok && graphRes.status !== 204) {
      const err = await graphRes.json().catch(() => ({}));
      return res.status(graphRes.status).json({ success: false, error: { code: 'GRAPH_ERROR', message: (err as any).error?.message || 'Failed to delete event' } });
    }
    return res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    console.error('[Outlook Calendar] Error deleting event:', err.message);
    return res.status(500).json({ success: false, error: { code: 'DELETE_FAILED', message: err.message } });
  }
});

export default router;

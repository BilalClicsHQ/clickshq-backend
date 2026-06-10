import { google, calendar_v3 } from 'googleapis';

// ─── Types ───────────────────────────────────────────────────────────────────
export interface CalendarEvent {
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: string | null;       // ISO datetime or date
  end: string | null;         // ISO datetime or date
  startTimeZone: string | null;
  endTimeZone: string | null;
  isAllDay: boolean;
  status: string | null;
  htmlLink: string | null;
  creator: { email: string | null; displayName: string | null } | null;
  organizer: { email: string | null; displayName: string | null } | null;
  attendees: Array<{
    email: string;
    displayName: string | null;
    responseStatus: string | null;
    self: boolean;
  }>;
  recurrence: string[] | null;
  conferenceData: {
    entryPoints: Array<{ entryPointType: string; uri: string }>;
  } | null;
}

export interface CalendarEventList {
  events: CalendarEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export interface CalendarInfo {
  id: string;
  summary: string;
  description: string | null;
  timeZone: string | null;
  primary: boolean;
  backgroundColor: string | null;
  foregroundColor: string | null;
}

export interface CreateEventInput {
  summary: string;
  description?: string;
  location?: string;
  startDateTime: string;     // ISO datetime
  endDateTime: string;       // ISO datetime
  timeZone?: string;
  attendees?: Array<{ email: string }>;
  isAllDay?: boolean;
  recurrence?: string[];     // RRULE strings e.g. ['RRULE:FREQ=WEEKLY;COUNT=5']
  createMeetLink?: boolean;  // When true, generate a Google Meet link via conferenceData
}

export interface UpdateEventInput {
  summary?: string;
  description?: string;
  location?: string;
  startDateTime?: string;
  endDateTime?: string;
  timeZone?: string;
  attendees?: Array<{ email: string }>;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  isAllDay?: boolean;
}

// ─── Calendar Client Factory ────────────────────────────────────────────────
function createCalendarClient(accessToken: string, refreshToken?: string | null): calendar_v3.Calendar {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALENDAR_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken ?? undefined,
  });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// ─── Map Google Event → CalendarEvent ────────────────────────────────────────
function mapEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  const isAllDay = !!(e.start?.date && !e.start?.dateTime);
  return {
    id: e.id!,
    summary: e.summary ?? null,
    description: e.description ?? null,
    location: e.location ?? null,
    start: isAllDay ? e.start?.date ?? null : e.start?.dateTime ?? null,
    end: isAllDay ? e.end?.date ?? null : e.end?.dateTime ?? null,
    startTimeZone: e.start?.timeZone ?? null,
    endTimeZone: e.end?.timeZone ?? null,
    isAllDay,
    status: e.status ?? null,
    htmlLink: e.htmlLink ?? null,
    creator: e.creator ? { email: e.creator.email ?? null, displayName: e.creator.displayName ?? null } : null,
    organizer: e.organizer ? { email: e.organizer.email ?? null, displayName: e.organizer.displayName ?? null } : null,
    attendees: (e.attendees || []).map(a => ({
      email: a.email!,
      displayName: a.displayName ?? null,
      responseStatus: a.responseStatus ?? null,
      self: a.self ?? false,
    })),
    recurrence: (e.recurrence as string[]) ?? null,
    conferenceData: e.conferenceData?.entryPoints
      ? {
          entryPoints: e.conferenceData.entryPoints.map(ep => ({
            entryPointType: ep.entryPointType!,
            uri: ep.uri!,
          })),
        }
      : null,
  };
}

// ─── List Calendars ──────────────────────────────────────────────────────────
// Returns all calendars the user has access to.
export async function listCalendars(
  accessToken: string,
  refreshToken?: string | null
): Promise<CalendarInfo[]> {
  const calendar = createCalendarClient(accessToken, refreshToken);

  const response = await calendar.calendarList.list({
    minAccessRole: 'reader',
  });

  return (response.data.items || []).map(c => ({
    id: c.id!,
    summary: c.summary!,
    description: c.description ?? null,
    timeZone: c.timeZone ?? null,
    primary: c.primary ?? false,
    backgroundColor: c.backgroundColor ?? null,
    foregroundColor: c.foregroundColor ?? null,
  }));
}

// ─── List Events ─────────────────────────────────────────────────────────────
// Lists events from a specific calendar (defaults to 'primary').
export async function listEvents(
  accessToken: string,
  options?: {
    refreshToken?: string | null;
    calendarId?: string;
    timeMin?: string;        // ISO datetime — fetch events from this time
    timeMax?: string;        // ISO datetime — fetch events until this time
    pageSize?: number;
    pageToken?: string;
    query?: string;          // Free-text search
    singleEvents?: boolean;  // Expand recurring events into instances
    orderBy?: 'startTime' | 'updated';
    syncToken?: string;      // Incremental sync token
  }
): Promise<CalendarEventList> {
  const calendar = createCalendarClient(accessToken, options?.refreshToken);

  const calendarId = options?.calendarId || 'primary';
  const singleEvents = options?.singleEvents ?? true;

  const params: calendar_v3.Params$Resource$Events$List = {
    calendarId,
    maxResults: options?.pageSize || 50,
    pageToken: options?.pageToken || undefined,
    singleEvents,
    orderBy: singleEvents ? (options?.orderBy || 'startTime') : undefined,
    q: options?.query || undefined,
  };

  // syncToken and timeMin/timeMax are mutually exclusive
  if (options?.syncToken) {
    params.syncToken = options.syncToken;
  } else {
    params.timeMin = options?.timeMin || new Date().toISOString();
    if (options?.timeMax) {
      params.timeMax = options.timeMax;
    }
  }

  const response = await calendar.events.list(params);

  return {
    events: (response.data.items || []).map(mapEvent),
    nextPageToken: response.data.nextPageToken ?? null,
    nextSyncToken: response.data.nextSyncToken ?? null,
  };
}

// ─── Get Event ───────────────────────────────────────────────────────────────
export async function getEvent(
  accessToken: string,
  eventId: string,
  calendarId: string = 'primary',
  refreshToken?: string | null
): Promise<CalendarEvent> {
  const calendar = createCalendarClient(accessToken, refreshToken);

  const response = await calendar.events.get({
    calendarId,
    eventId,
  });

  return mapEvent(response.data);
}

// ─── Create Event ────────────────────────────────────────────────────────────
export async function createEvent(
  accessToken: string,
  input: CreateEventInput,
  calendarId: string = 'primary',
  refreshToken?: string | null
): Promise<CalendarEvent> {
  const calendar = createCalendarClient(accessToken, refreshToken);

  const requestBody: calendar_v3.Schema$Event = {
    summary: input.summary,
    description: input.description,
    location: input.location,
    attendees: input.attendees?.map(a => ({ email: a.email })),
    recurrence: input.recurrence,
  };

  if (input.isAllDay) {
    requestBody.start = { date: input.startDateTime.split('T')[0] };
    requestBody.end = { date: input.endDateTime.split('T')[0] };
  } else {
    requestBody.start = {
      dateTime: input.startDateTime,
      timeZone: input.timeZone,
    };
    requestBody.end = {
      dateTime: input.endDateTime,
      timeZone: input.timeZone,
    };
  }

  // Attach Google Meet conference if requested
  if (input.createMeetLink) {
    requestBody.conferenceData = {
      createRequest: {
        requestId: `clicshq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const response = await calendar.events.insert({
    calendarId,
    requestBody,
    sendUpdates: 'all',  // Notify attendees
    conferenceDataVersion: input.createMeetLink ? 1 : 0,
  });

  return mapEvent(response.data);
}

// ─── Update Event ────────────────────────────────────────────────────────────
export async function updateEvent(
  accessToken: string,
  eventId: string,
  input: UpdateEventInput,
  calendarId: string = 'primary',
  refreshToken?: string | null
): Promise<CalendarEvent> {
  const calendar = createCalendarClient(accessToken, refreshToken);

  const requestBody: calendar_v3.Schema$Event = {};

  if (input.summary !== undefined) requestBody.summary = input.summary;
  if (input.description !== undefined) requestBody.description = input.description;
  if (input.location !== undefined) requestBody.location = input.location;
  if (input.status !== undefined) requestBody.status = input.status;
  if (input.attendees !== undefined) requestBody.attendees = input.attendees.map(a => ({ email: a.email }));

  if (input.startDateTime) {
    if (input.isAllDay) {
      requestBody.start = { date: input.startDateTime.split('T')[0] };
    } else {
      requestBody.start = {
        dateTime: input.startDateTime,
        timeZone: input.timeZone,
      };
    }
  }
  if (input.endDateTime) {
    if (input.isAllDay) {
      requestBody.end = { date: input.endDateTime.split('T')[0] };
    } else {
      requestBody.end = {
        dateTime: input.endDateTime,
        timeZone: input.timeZone,
      };
    }
  }

  const response = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody,
    sendUpdates: 'all',
  });

  return mapEvent(response.data);
}

// ─── Delete Event ────────────────────────────────────────────────────────────
export async function deleteEvent(
  accessToken: string,
  eventId: string,
  calendarId: string = 'primary',
  refreshToken?: string | null
): Promise<void> {
  const calendar = createCalendarClient(accessToken, refreshToken);

  await calendar.events.delete({
    calendarId,
    eventId,
    sendUpdates: 'all',
  });
}

// ─── Quick Add Event ─────────────────────────────────────────────────────────
// Creates an event using natural language (e.g., "Dinner with John tomorrow at 7pm").
export async function quickAddEvent(
  accessToken: string,
  text: string,
  calendarId: string = 'primary',
  refreshToken?: string | null
): Promise<CalendarEvent> {
  const calendar = createCalendarClient(accessToken, refreshToken);

  const response = await calendar.events.quickAdd({
    calendarId,
    text,
  });

  return mapEvent(response.data);
}

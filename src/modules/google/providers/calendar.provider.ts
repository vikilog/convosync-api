import { google } from 'googleapis';
import { BaseGoogleProvider, type GoogleProviderContext } from './base.provider.js';

export class GoogleCalendarProvider extends BaseGoogleProvider {
  readonly product = 'calendar' as const;

  async connect(ctx: GoogleProviderContext): Promise<Record<string, unknown>> {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    const list = await calendar.calendarList.list({ maxResults: 50 });
    const calendars = (list.data.items ?? []).map((c) => ({
      id: c.id,
      summary: c.summary,
      primary: c.primary ?? false,
      timeZone: c.timeZone,
    }));
    const primary = calendars.find((c) => c.primary) ?? calendars[0];
    return {
      defaultCalendarId: primary?.id ?? null,
      calendars,
    };
  }

  async setDefaultCalendar(ctx: GoogleProviderContext, calendarId: string) {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    const meta = await calendar.calendars.get({ calendarId });
    return { defaultCalendarId: calendarId, summary: meta.data.summary };
  }

  async createEvent(
    ctx: GoogleProviderContext,
    input: {
      calendarId?: string;
      summary: string;
      description?: string;
      start: string;
      end: string;
      timeZone?: string;
    }
  ) {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    const calendarId = input.calendarId || 'primary';
    const res = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.start, timeZone: input.timeZone },
        end: { dateTime: input.end, timeZone: input.timeZone },
      },
    });
    return res.data;
  }

  async updateEvent(
    ctx: GoogleProviderContext,
    input: {
      calendarId?: string;
      eventId: string;
      summary?: string;
      description?: string;
      start?: string;
      end?: string;
      timeZone?: string;
    }
  ) {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    const res = await calendar.events.patch({
      calendarId: input.calendarId || 'primary',
      eventId: input.eventId,
      requestBody: {
        summary: input.summary,
        description: input.description,
        ...(input.start ? { start: { dateTime: input.start, timeZone: input.timeZone } } : {}),
        ...(input.end ? { end: { dateTime: input.end, timeZone: input.timeZone } } : {}),
      },
    });
    return res.data;
  }

  async deleteEvent(ctx: GoogleProviderContext, calendarId: string | undefined, eventId: string) {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    await calendar.events.delete({ calendarId: calendarId || 'primary', eventId });
    return { deleted: true, eventId };
  }

  async checkAvailability(
    ctx: GoogleProviderContext,
    input: { calendarId?: string; timeMin: string; timeMax: string }
  ) {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        items: [{ id: input.calendarId || 'primary' }],
      },
    });
    return res.data;
  }

  async listCalendars(ctx: GoogleProviderContext) {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    const list = await calendar.calendarList.list({ maxResults: 50 });
    return (list.data.items ?? []).map((c) => ({
      id: c.id,
      summary: c.summary,
      primary: c.primary ?? false,
      timeZone: c.timeZone,
      backgroundColor: c.backgroundColor,
    }));
  }

  async listEvents(
    ctx: GoogleProviderContext,
    input: {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
    }
  ) {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    const res = await calendar.events.list({
      calendarId: input.calendarId || 'primary',
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      maxResults: input.maxResults ?? 30,
      singleEvents: true,
      orderBy: 'startTime',
    });
    return (res.data.items ?? []).map((e) => ({
      id: e.id,
      summary: e.summary,
      description: e.description,
      htmlLink: e.htmlLink,
      status: e.status,
      start: e.start?.dateTime ?? e.start?.date ?? null,
      end: e.end?.dateTime ?? e.end?.date ?? null,
      location: e.location,
    }));
  }
}

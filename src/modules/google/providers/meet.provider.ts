import { google } from 'googleapis';
import { BaseGoogleProvider, type GoogleProviderContext } from './base.provider.js';

export class GoogleMeetProvider extends BaseGoogleProvider {
  readonly product = 'meet' as const;

  async connect(ctx: GoogleProviderContext): Promise<Record<string, unknown>> {
    return { meetReady: true, usesCalendarConference: true };
  }

  async createMeeting(
    ctx: GoogleProviderContext,
    input: {
      calendarId?: string;
      summary: string;
      start: string;
      end: string;
      timeZone?: string;
      attendees?: string[];
    }
  ) {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    const res = await calendar.events.insert({
      calendarId: input.calendarId || 'primary',
      conferenceDataVersion: 1,
      requestBody: {
        summary: input.summary,
        start: { dateTime: input.start, timeZone: input.timeZone },
        end: { dateTime: input.end, timeZone: input.timeZone },
        attendees: input.attendees?.map((email) => ({ email })),
        conferenceData: {
          createRequest: {
            requestId: `meet-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    });
    const meetLink =
      res.data.hangoutLink ||
      res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
    return { event: res.data, meetLink };
  }

  async generateMeetLink(
    ctx: GoogleProviderContext,
    input: { calendarId?: string; summary: string; start: string; end: string; timeZone?: string }
  ) {
    const created = await this.createMeeting(ctx, input);
    return { meetLink: created.meetLink, eventId: created.event.id };
  }

  async cancelMeeting(ctx: GoogleProviderContext, calendarId: string | undefined, eventId: string) {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    await calendar.events.delete({ calendarId: calendarId || 'primary', eventId });
    return { cancelled: true, eventId };
  }

  async listMeetings(
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
      maxResults: input.maxResults ?? 50,
      singleEvents: true,
      orderBy: 'startTime',
    });

    return (res.data.items ?? [])
      .map((e) => {
        const meetLink =
          e.hangoutLink ||
          e.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video')?.uri ||
          null;
        if (!meetLink) return null;

        const start = e.start?.dateTime ?? e.start?.date ?? null;
        const end = e.end?.dateTime ?? e.end?.date ?? null;
        let durationMinutes: number | null = null;
        if (start && end) {
          const ms = new Date(end).getTime() - new Date(start).getTime();
          if (!Number.isNaN(ms) && ms > 0) durationMinutes = Math.round(ms / 60_000);
        }

        const now = Date.now();
        const startMs = start ? new Date(start).getTime() : 0;
        const endMs = end ? new Date(end).getTime() : 0;
        let status: 'upcoming' | 'live' | 'past' | 'cancelled' = 'upcoming';
        if (e.status === 'cancelled') status = 'cancelled';
        else if (endMs && endMs < now) status = 'past';
        else if (startMs <= now && endMs >= now) status = 'live';

        return {
          id: e.id,
          summary: e.summary,
          description: e.description,
          htmlLink: e.htmlLink,
          start,
          end,
          durationMinutes,
          meetLink,
          status,
          attendees: (e.attendees ?? []).map((a) => ({
            email: a.email,
            displayName: a.displayName,
            responseStatus: a.responseStatus,
            organizer: a.organizer ?? false,
          })),
          organizer: e.organizer?.email ?? null,
          location: e.location ?? null,
        };
      })
      .filter(Boolean);
  }

  async attachToCalendarEvent(
    ctx: GoogleProviderContext,
    input: { calendarId?: string; eventId: string }
  ) {
    const calendar = google.calendar({ version: 'v3', auth: ctx.auth });
    const res = await calendar.events.patch({
      calendarId: input.calendarId || 'primary',
      eventId: input.eventId,
      conferenceDataVersion: 1,
      requestBody: {
        conferenceData: {
          createRequest: {
            requestId: `meet-attach-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    });
    return res.data;
  }
}

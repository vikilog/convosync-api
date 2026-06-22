import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GoogleProductKey } from '@prisma/client';
import { getJwtUser } from '../../../middleware/auth.js';
import { googleConnectService } from '../services/google-connect.service.js';
import { googleService } from '../services/google.service.js';
import { scopesForAllProducts } from '../constants/scopes.js';
import { GoogleCalendarProvider } from '../providers/calendar.provider.js';
import { GoogleSheetsProvider } from '../providers/sheets.provider.js';
import { GoogleDriveProvider } from '../providers/drive.provider.js';
import { GoogleGmailProvider } from '../providers/gmail.provider.js';
import { GoogleMeetProvider } from '../providers/meet.provider.js';

const PRODUCT_KEYS: GoogleProductKey[] = [
  'calendar',
  'business_profile',
  'sheets',
  'drive',
  'gmail',
  'meet',
];

function parseProduct(raw: string): GoogleProductKey | null {
  return PRODUCT_KEYS.includes(raw as GoogleProductKey) ? (raw as GoogleProductKey) : null;
}

function workspaceId(request: FastifyRequest): string {
  return getJwtUser(request).workspaceId;
}

export class GoogleController {
  oauthState = async (request: FastifyRequest) => {
    const user = getJwtUser(request);
    const state = request.server.jwt.sign(
      {
        userId: user.userId,
        workspaceId: user.workspaceId,
        role: user.role,
        purpose: 'google_oauth',
      },
      { expiresIn: '15m' }
    );

    const query = request.query as { redirectUri?: string };
    const redirectUri = googleConnectService.resolveRedirectUri(query.redirectUri);
    const oauthUrl = googleConnectService.buildOAuthStateUrl(state, redirectUri);

    return {
      state,
      redirectUri,
      oauthUrl,
      scopes: scopesForAllProducts(),
    };
  };

  connectAccount = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { code?: string; redirectUri?: string };
    if (!body.code) {
      return reply.code(400).send({ error: 'Missing Google authorization code' });
    }

    try {
      const account = await googleConnectService.connectAccount({
        workspaceId: workspaceId(request),
        code: body.code,
        redirectUri: body.redirectUri,
      });
      return reply.send({ success: true, account });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Google connection failed';
      return reply.code(400).send({ error: 'Google connection failed', details: message });
    }
  };

  listConnections = async (request: FastifyRequest) => {
    const connections = await googleService.listConnections(workspaceId(request));
    return { connections };
  };

  disconnectConnection = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    try {
      await googleService.disconnectAccount(id, workspaceId(request));
      return reply.send({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Disconnect failed';
      return reply.code(400).send({ error: message });
    }
  };

  refreshConnection = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    try {
      await googleService.refreshTokens(id, workspaceId(request));
      const account = await googleService.getAccountDetails(id, workspaceId(request));
      return reply.send({ success: true, account });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token refresh failed';
      return reply.code(400).send({ error: message });
    }
  };

  listProducts = async (request: FastifyRequest) => {
    const products = await googleService.listProductSummaries(workspaceId(request));
    return { products };
  };

  connectProduct = async (request: FastifyRequest, reply: FastifyReply) => {
    const product = parseProduct((request.params as { product: string }).product);
    if (!product) return reply.code(404).send({ error: 'Unknown Google product' });

    const body = request.body as { connectionId?: string };
    if (!body.connectionId) {
      return reply.code(400).send({ error: 'connectionId is required' });
    }

    try {
      const summary = await googleService.connectProduct(
        workspaceId(request),
        body.connectionId,
        product
      );
      return reply.send({ success: true, product: summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Product connect failed';
      return reply.code(400).send({ error: message });
    }
  };

  disconnectProduct = async (request: FastifyRequest, reply: FastifyReply) => {
    const product = parseProduct((request.params as { product: string }).product);
    if (!product) return reply.code(404).send({ error: 'Unknown Google product' });

    const body = request.body as { connectionId?: string };
    if (!body.connectionId) {
      return reply.code(400).send({ error: 'connectionId is required' });
    }

    try {
      await googleService.disconnectProduct(workspaceId(request), body.connectionId, product);
      return reply.send({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Product disconnect failed';
      return reply.code(400).send({ error: message });
    }
  };

  syncProduct = async (request: FastifyRequest, reply: FastifyReply) => {
    const product = parseProduct((request.params as { product: string }).product);
    if (!product) return reply.code(404).send({ error: 'Unknown Google product' });

    const body = request.body as { connectionId?: string };
    if (!body.connectionId) {
      return reply.code(400).send({ error: 'connectionId is required' });
    }

    try {
      const summary = await googleService.syncProduct(
        workspaceId(request),
        body.connectionId,
        product
      );
      return reply.send({ success: true, product: summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      return reply.code(400).send({ error: message });
    }
  };

  validatePermissions = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { product: string; connectionId: string };
    const product = parseProduct(params.product);
    if (!product) return reply.code(404).send({ error: 'Unknown Google product' });

    const result = await googleService.validatePermissions(
      params.connectionId,
      workspaceId(request),
      product
    );
    return reply.send(result);
  };

  // --- Product actions (thin delegates; all auth via GoogleService) ---

  calendarCreateEvent = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      calendarId?: string;
      summary: string;
      description?: string;
      start: string;
      end: string;
      timeZone?: string;
    };
    if (!body.connectionId || !body.summary || !body.start || !body.end) {
      return reply.code(400).send({ error: 'connectionId, summary, start, end required' });
    }
    const provider = googleService.getProvider('calendar') as GoogleCalendarProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const event = await provider.createEvent(ctx, body);
    return reply.send({ event });
  };

  calendarUpdateEvent = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      eventId: string;
      calendarId?: string;
      summary?: string;
      description?: string;
      start?: string;
      end?: string;
      timeZone?: string;
    };
    if (!body.connectionId || !body.eventId) {
      return reply.code(400).send({ error: 'connectionId and eventId required' });
    }
    const provider = googleService.getProvider('calendar') as GoogleCalendarProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const event = await provider.updateEvent(ctx, body);
    return reply.send({ event });
  };

  calendarDeleteEvent = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { connectionId: string; eventId: string; calendarId?: string };
    if (!body.connectionId || !body.eventId) {
      return reply.code(400).send({ error: 'connectionId and eventId required' });
    }
    const provider = googleService.getProvider('calendar') as GoogleCalendarProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const result = await provider.deleteEvent(ctx, body.calendarId, body.eventId);
    return reply.send(result);
  };

  calendarAvailability = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      calendarId?: string;
      timeMin: string;
      timeMax: string;
    };
    if (!body.connectionId || !body.timeMin || !body.timeMax) {
      return reply.code(400).send({ error: 'connectionId, timeMin, timeMax required' });
    }
    const provider = googleService.getProvider('calendar') as GoogleCalendarProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const availability = await provider.checkAvailability(ctx, body);
    return reply.send({ availability });
  };

  calendarListCalendars = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { connectionId?: string };
    if (!body.connectionId) {
      return reply.code(400).send({ error: 'connectionId required' });
    }
    const provider = googleService.getProvider('calendar') as GoogleCalendarProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const calendars = await provider.listCalendars(ctx);
    return reply.send({ calendars });
  };

  calendarListEvents = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId?: string;
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
    };
    if (!body.connectionId) {
      return reply.code(400).send({ error: 'connectionId required' });
    }
    const provider = googleService.getProvider('calendar') as GoogleCalendarProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const events = await provider.listEvents(ctx, body);
    return reply.send({ events });
  };

  sheetsList = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      pageToken?: string;
      pageSize?: number;
      starred?: boolean;
    };
    if (!body.connectionId) return reply.code(400).send({ error: 'connectionId required' });
    const provider = googleService.getProvider('sheets') as GoogleSheetsProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const listing = await provider.listSpreadsheets(ctx, body);
    return reply.send(listing);
  };

  sheetsGet = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      spreadsheetId: string;
      sheetTitle?: string;
      previewRows?: number;
    };
    if (!body.connectionId || !body.spreadsheetId) {
      return reply.code(400).send({ error: 'connectionId and spreadsheetId required' });
    }
    const provider = googleService.getProvider('sheets') as GoogleSheetsProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const detail = await provider.getSpreadsheet(ctx, body.spreadsheetId, body);
    return reply.send(detail);
  };

  sheetsRead = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { connectionId: string; spreadsheetId: string; range: string };
    if (!body.connectionId || !body.spreadsheetId || !body.range) {
      return reply.code(400).send({ error: 'connectionId, spreadsheetId, range required' });
    }
    const provider = googleService.getProvider('sheets') as GoogleSheetsProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const data = await provider.readRows(ctx, body);
    return reply.send(data);
  };

  sheetsWrite = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      spreadsheetId: string;
      range: string;
      values: unknown[][];
    };
    if (!body.connectionId || !body.spreadsheetId || !body.range || !body.values) {
      return reply.code(400).send({ error: 'connectionId, spreadsheetId, range, values required' });
    }
    const provider = googleService.getProvider('sheets') as GoogleSheetsProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const result = await provider.writeRows(ctx, body);
    return reply.send({ result });
  };

  sheetsAppend = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      spreadsheetId: string;
      range: string;
      values: unknown[][];
    };
    if (!body.connectionId || !body.spreadsheetId || !body.range || !body.values) {
      return reply.code(400).send({ error: 'connectionId, spreadsheetId, range, values required' });
    }
    const provider = googleService.getProvider('sheets') as GoogleSheetsProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const result = await provider.appendRows(ctx, body);
    return reply.send({ result });
  };

  driveBrowse = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      folderId?: string;
      pageToken?: string;
      view?: 'my' | 'shared' | 'recent' | 'starred' | 'folders';
      query?: string;
      pageSize?: number;
    };
    if (!body.connectionId) return reply.code(400).send({ error: 'connectionId required' });
    const provider = googleService.getProvider('drive') as GoogleDriveProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const listing = await provider.browseFiles(ctx, body);
    return reply.send(listing);
  };

  driveGetFile = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { connectionId: string; fileId: string };
    if (!body.connectionId || !body.fileId) {
      return reply.code(400).send({ error: 'connectionId and fileId required' });
    }
    const provider = googleService.getProvider('drive') as GoogleDriveProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const file = await provider.getFile(ctx, body.fileId);
    return reply.send({ file });
  };

  drivePreviewFile = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { connectionId: string; fileId: string };
    if (!body.connectionId || !body.fileId) {
      return reply.code(400).send({ error: 'connectionId and fileId required' });
    }
    const provider = googleService.getProvider('drive') as GoogleDriveProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const preview = await provider.getFilePreview(ctx, body.fileId);
    return reply.send({ preview });
  };

  gmailSend = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      to: string;
      subject: string;
      body: string;
      html?: boolean;
    };
    if (!body.connectionId || !body.to || !body.subject || !body.body) {
      return reply.code(400).send({ error: 'connectionId, to, subject, body required' });
    }
    const provider = googleService.getProvider('gmail') as GoogleGmailProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const message = await provider.sendEmail(ctx, body);
    return reply.send({ message });
  };

  gmailRead = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      maxResults?: number;
      query?: string;
      pageToken?: string;
    };
    if (!body.connectionId) return reply.code(400).send({ error: 'connectionId required' });
    const provider = googleService.getProvider('gmail') as GoogleGmailProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const messages = await provider.readMessages(ctx, body);
    return reply.send(messages);
  };

  gmailGetMessage = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { connectionId: string; messageId: string };
    if (!body.connectionId || !body.messageId) {
      return reply.code(400).send({ error: 'connectionId and messageId required' });
    }
    const provider = googleService.getProvider('gmail') as GoogleGmailProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const message = await provider.getMessage(ctx, body.messageId);
    return reply.send({ message });
  };

  meetList = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
    };
    if (!body.connectionId) return reply.code(400).send({ error: 'connectionId required' });
    const provider = googleService.getProvider('meet') as GoogleMeetProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const meetings = await provider.listMeetings(ctx, body);
    return reply.send({ meetings });
  };

  meetCancel = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { connectionId: string; eventId: string; calendarId?: string };
    if (!body.connectionId || !body.eventId) {
      return reply.code(400).send({ error: 'connectionId and eventId required' });
    }
    const provider = googleService.getProvider('meet') as GoogleMeetProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const result = await provider.cancelMeeting(ctx, body.calendarId, body.eventId);
    return reply.send(result);
  };

  meetCreate = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      calendarId?: string;
      summary: string;
      start: string;
      end: string;
      timeZone?: string;
      attendees?: string[];
    };
    if (!body.connectionId || !body.summary || !body.start || !body.end) {
      return reply.code(400).send({ error: 'connectionId, summary, start, end required' });
    }
    const provider = googleService.getProvider('meet') as GoogleMeetProvider;
    const ctx = await provider.context(body.connectionId, workspaceId(request));
    const meeting = await provider.createMeeting(ctx, body);
    return reply.send(meeting);
  };

}

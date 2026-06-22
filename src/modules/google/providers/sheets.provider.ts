import { google } from 'googleapis';
import { BaseGoogleProvider, type GoogleProviderContext } from './base.provider.js';

export class GoogleSheetsProvider extends BaseGoogleProvider {
  readonly product = 'sheets' as const;

  async connect(ctx: GoogleProviderContext): Promise<Record<string, unknown>> {
    const listing = await this.listSpreadsheets(ctx, { pageSize: 25 });
    return { spreadsheets: listing.spreadsheets };
  }

  async listSpreadsheets(
    ctx: GoogleProviderContext,
    input?: { pageToken?: string; pageSize?: number; starred?: boolean }
  ) {
    const drive = google.drive({ version: 'v3', auth: ctx.auth });
    const parts = ["mimeType='application/vnd.google-apps.spreadsheet'", 'trashed=false'];
    if (input?.starred) parts.push('starred=true');
    const res = await drive.files.list({
      q: parts.join(' and '),
      pageSize: input?.pageSize ?? 50,
      pageToken: input?.pageToken,
      orderBy: 'modifiedTime desc',
      fields:
        'nextPageToken, files(id,name,modifiedTime,owners,starred,shared,webViewLink,createdTime)',
    });
    const files = res.data.files ?? [];
    const sheets = google.sheets({ version: 'v4', auth: ctx.auth });

    const spreadsheets = await Promise.all(
      files.map(async (file) => {
        const owner = file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? null;
        let worksheetCount = 0;
        let rowCount = 0;
        let columnCount = 0;
        try {
          const meta = await sheets.spreadsheets.get({
            spreadsheetId: file.id!,
            fields: 'properties.title,sheets.properties',
          });
          const worksheets = meta.data.sheets ?? [];
          worksheetCount = worksheets.length;
          for (const ws of worksheets) {
            rowCount += ws.properties?.gridProperties?.rowCount ?? 0;
            columnCount = Math.max(
              columnCount,
              ws.properties?.gridProperties?.columnCount ?? 0
            );
          }
        } catch {
          /* metadata optional */
        }
        return {
          id: file.id,
          name: file.name,
          owner,
          modifiedTime: file.modifiedTime ?? null,
          createdTime: file.createdTime ?? null,
          starred: file.starred ?? false,
          shared: file.shared ?? false,
          webViewLink: file.webViewLink ?? null,
          worksheetCount,
          rowCount,
          columnCount,
          status: 'available',
        };
      })
    );

    return {
      spreadsheets,
      nextPageToken: res.data.nextPageToken ?? null,
    };
  }

  async getSpreadsheet(
    ctx: GoogleProviderContext,
    spreadsheetId: string,
    input?: { sheetTitle?: string; previewRows?: number }
  ) {
    const sheets = google.sheets({ version: 'v4', auth: ctx.auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const worksheets = (meta.data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId,
      title: s.properties?.title,
      index: s.properties?.index,
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      columnCount: s.properties?.gridProperties?.columnCount ?? 0,
    }));

    const activeTitle = input?.sheetTitle ?? worksheets[0]?.title;
    let preview: { range: string; values: unknown[][] } | null = null;
    if (activeTitle) {
      const maxRows = Math.min(input?.previewRows ?? 20, 50);
      const range = `${activeTitle}!A1:Z${maxRows}`;
      const values = await this.readRows(ctx, { spreadsheetId, range });
      preview = { range, values: values.values };
    }

    return {
      spreadsheetId,
      title: meta.data.properties?.title,
      worksheets,
      preview,
    };
  }

  async selectWorksheet(ctx: GoogleProviderContext, spreadsheetId: string) {
    const sheets = google.sheets({ version: 'v4', auth: ctx.auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const worksheets = (meta.data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId,
      title: s.properties?.title,
    }));
    return { spreadsheetId, worksheets, title: meta.data.properties?.title };
  }

  async readRows(
    ctx: GoogleProviderContext,
    input: { spreadsheetId: string; range: string }
  ) {
    const sheets = google.sheets({ version: 'v4', auth: ctx.auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: input.spreadsheetId,
      range: input.range,
    });
    return { range: input.range, values: res.data.values ?? [] };
  }

  async writeRows(
    ctx: GoogleProviderContext,
    input: { spreadsheetId: string; range: string; values: unknown[][] }
  ) {
    const sheets = google.sheets({ version: 'v4', auth: ctx.auth });
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId: input.spreadsheetId,
      range: input.range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: input.values },
    });
    return res.data;
  }

  async appendRows(
    ctx: GoogleProviderContext,
    input: { spreadsheetId: string; range: string; values: unknown[][] }
  ) {
    const sheets = google.sheets({ version: 'v4', auth: ctx.auth });
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: input.spreadsheetId,
      range: input.range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: input.values },
    });
    return res.data;
  }
}

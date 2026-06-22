import { google } from 'googleapis';
import { BaseGoogleProvider, type GoogleProviderContext } from './base.provider.js';

const GOOGLE_EXPORT_MIME: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'image/png',
};

const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

export class GoogleDriveProvider extends BaseGoogleProvider {
  readonly product = 'drive' as const;

  async connect(ctx: GoogleProviderContext): Promise<Record<string, unknown>> {
    const drive = google.drive({ version: 'v3', auth: ctx.auth });
    const about = await drive.about.get({ fields: 'user,storageQuota' });
    return {
      user: about.data.user,
      storageQuota: about.data.storageQuota,
    };
  }

  async browseFiles(
    ctx: GoogleProviderContext,
    input?: {
      folderId?: string;
      pageToken?: string;
      view?: 'my' | 'shared' | 'recent' | 'starred' | 'folders';
      query?: string;
      pageSize?: number;
    }
  ) {
    const drive = google.drive({ version: 'v3', auth: ctx.auth });
    const parts = ['trashed=false'];

    if (input?.folderId) {
      parts.push(`'${input.folderId}' in parents`);
    } else if (input?.view === 'shared') {
      parts.push('sharedWithMe=true');
    } else if (input?.view === 'starred') {
      parts.push('starred=true');
    } else if (input?.view === 'folders') {
      parts.push("mimeType='application/vnd.google-apps.folder'");
    }

    if (input?.query?.trim()) {
      const q = input.query.trim().replace(/'/g, "\\'");
      parts.push(`name contains '${q}'`);
    }

    const res = await drive.files.list({
      q: parts.join(' and '),
      pageSize: input?.pageSize ?? 50,
      pageToken: input?.pageToken,
      fields:
        'nextPageToken, files(id,name,mimeType,modifiedTime,parents,owners,size,starred,shared,webViewLink,webContentLink,iconLink,thumbnailLink,createdTime)',
      orderBy: 'modifiedTime desc',
      includeItemsFromAllDrives: input?.view === 'shared',
      supportsAllDrives: true,
    });

    const files = (res.data.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime ?? null,
      createdTime: f.createdTime ?? null,
      parents: f.parents ?? [],
      owner: f.owners?.[0]?.displayName ?? f.owners?.[0]?.emailAddress ?? null,
      size: f.size ? Number(f.size) : null,
      starred: f.starred ?? false,
      shared: f.shared ?? false,
      webViewLink: f.webViewLink ?? null,
      webContentLink: f.webContentLink ?? null,
      iconLink: f.iconLink ?? null,
      thumbnailLink: f.thumbnailLink ?? null,
      isFolder: f.mimeType === 'application/vnd.google-apps.folder',
    }));

    return { files, nextPageToken: res.data.nextPageToken ?? null };
  }

  async getFile(ctx: GoogleProviderContext, fileId: string) {
    const drive = google.drive({ version: 'v3', auth: ctx.auth });
    const res = await drive.files.get({
      fileId,
      fields:
        'id,name,mimeType,modifiedTime,createdTime,owners,size,starred,shared,webViewLink,webContentLink,iconLink,thumbnailLink,parents,description',
      supportsAllDrives: true,
    });
    const f = res.data;
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime ?? null,
      createdTime: f.createdTime ?? null,
      parents: f.parents ?? [],
      owner: f.owners?.[0]?.displayName ?? f.owners?.[0]?.emailAddress ?? null,
      size: f.size ? Number(f.size) : null,
      starred: f.starred ?? false,
      shared: f.shared ?? false,
      webViewLink: f.webViewLink ?? null,
      webContentLink: f.webContentLink ?? null,
      iconLink: f.iconLink ?? null,
      thumbnailLink: f.thumbnailLink ?? null,
      description: f.description ?? null,
      isFolder: f.mimeType === 'application/vnd.google-apps.folder',
    };
  }

  async selectFolder(ctx: GoogleProviderContext, folderId: string) {
    const drive = google.drive({ version: 'v3', auth: ctx.auth });
    const res = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,mimeType,parents',
    });
    return res.data;
  }

  async syncFiles(ctx: GoogleProviderContext, input?: { folderId?: string }) {
    const listing = await this.browseFiles(ctx, { folderId: input?.folderId });
    return {
      folderId: input?.folderId ?? 'root',
      fileCount: listing.files.length,
      files: listing.files,
      syncedAt: new Date().toISOString(),
    };
  }

  /** Fetch file bytes via connected OAuth — for in-app preview (no Google iframe sign-in). */
  async getFilePreview(ctx: GoogleProviderContext, fileId: string) {
    const meta = await this.getFile(ctx, fileId);
    if (meta.isFolder) {
      return { previewable: false as const, reason: 'folder', mimeType: meta.mimeType };
    }

    const drive = google.drive({ version: 'v3', auth: ctx.auth });
    const mime = meta.mimeType ?? 'application/octet-stream';

    if (mime.startsWith('application/vnd.google-apps.')) {
      const exportMime = GOOGLE_EXPORT_MIME[mime];
      if (!exportMime) {
        return { previewable: false as const, reason: 'unsupported_type', mimeType: mime };
      }
      const res = await drive.files.export(
        { fileId, mimeType: exportMime },
        { responseType: 'arraybuffer' }
      );
      const buffer = Buffer.from(res.data as ArrayBuffer);
      if (buffer.length > MAX_PREVIEW_BYTES) {
        return { previewable: false as const, reason: 'too_large', mimeType: exportMime };
      }
      return {
        previewable: true as const,
        mimeType: exportMime,
        dataBase64: buffer.toString('base64'),
        fileName: meta.name,
        sourceMimeType: mime,
      };
    }

    if (meta.size && meta.size > MAX_PREVIEW_BYTES) {
      return { previewable: false as const, reason: 'too_large', mimeType: mime };
    }

    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const buffer = Buffer.from(res.data as ArrayBuffer);
    if (buffer.length > MAX_PREVIEW_BYTES) {
      return { previewable: false as const, reason: 'too_large', mimeType: mime };
    }

    return {
      previewable: true as const,
      mimeType: mime,
      dataBase64: buffer.toString('base64'),
      fileName: meta.name,
      sourceMimeType: mime,
    };
  }

  async trackChanges(ctx: GoogleProviderContext, pageToken?: string) {
    const drive = google.drive({ version: 'v3', auth: ctx.auth });
    const res = await drive.changes.list({
      pageToken: pageToken || undefined,
      pageSize: 100,
      fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime))',
    });
    return res.data;
  }
}

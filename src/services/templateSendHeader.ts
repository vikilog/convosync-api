import { readTemplateHeaderMedia } from './templateMedia.js';
import { uploadWhatsAppMedia } from './whatsappMedia.js';
import { isHeaderMediaStorageKeyOwnedByWorkspace } from './campaignHeaderMedia.js';

export type TemplateMediaHeaderFormat = 'IMAGE' | 'VIDEO' | 'DOCUMENT';

export function isTemplateMediaHeaderFormat(
  format: string | null | undefined
): format is TemplateMediaHeaderFormat {
  const normalized = (format || '').toUpperCase();
  return normalized === 'IMAGE' || normalized === 'VIDEO' || normalized === 'DOCUMENT';
}

type TemplateHeaderMediaRecord = {
  headerFormat: string | null;
  headerMediaStorageKey: string | null;
  headerMediaMimeType: string | null;
  headerMediaFileName: string | null;
};

type UploadedHeaderMedia = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
};

export async function resolveTemplateHeaderMediaBuffer(
  workspaceId: string,
  template: TemplateHeaderMediaRecord,
  uploaded?: UploadedHeaderMedia | null
): Promise<{
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  format: TemplateMediaHeaderFormat;
}> {
  const format = (template.headerFormat || '').toUpperCase() as TemplateMediaHeaderFormat;
  if (!isTemplateMediaHeaderFormat(format)) {
    throw new Error('Template does not have a media header');
  }

  if (uploaded?.buffer?.length) {
    return {
      buffer: uploaded.buffer,
      mimeType: uploaded.mimeType,
      fileName: uploaded.fileName,
      format,
    };
  }

  if (template.headerMediaStorageKey) {
    // headerMediaStorageKey is a free-form string field on the template row —
    // a write-time bug (or a row written before this check existed) could
    // have it pointing at another workspace's stored file. Verify ownership
    // here too, at the point this actually gets read and sent to Meta.
    if (!isHeaderMediaStorageKeyOwnedByWorkspace(template.headerMediaStorageKey, workspaceId)) {
      throw new Error('Template header media is invalid for this workspace');
    }
    const { buffer, mimeType } = await readTemplateHeaderMedia(template.headerMediaStorageKey);
    return {
      buffer,
      mimeType: template.headerMediaMimeType || mimeType,
      fileName: template.headerMediaFileName || undefined,
      format,
    };
  }

  throw new Error(
    'This template requires header media. Upload an image, video, or document before sending.'
  );
}

export async function uploadTemplateHeaderMediaForSend(
  accessToken: string,
  phoneNumberId: string,
  workspaceId: string,
  template: TemplateHeaderMediaRecord,
  uploaded?: UploadedHeaderMedia | null
): Promise<{
  format: TemplateMediaHeaderFormat;
  waMediaId: string;
  fileName?: string;
}> {
  const { buffer, mimeType, fileName, format } = await resolveTemplateHeaderMediaBuffer(
    workspaceId,
    template,
    uploaded
  );
  const waMediaId = await uploadWhatsAppMedia(
    accessToken,
    phoneNumberId,
    buffer,
    mimeType,
    fileName
  );
  return { format, waMediaId, fileName };
}

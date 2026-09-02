import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export type ExtractedDocument = { text: string; wordCount: number };

const TEXT_EXTENSIONS = new Set(['txt', 'md']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export class DocumentExtractError extends Error {
  constructor(
    message: string,
    public readonly code: 'UNSUPPORTED_FORMAT' | 'NO_TEXT' | 'PARSE_FAILED'
  ) {
    super(message);
    this.name = 'DocumentExtractError';
  }
}

function extOf(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match ? match[1].toLowerCase() : '';
}

export function isSupportedDocumentFile(filename: string, mimeType: string): boolean {
  const ext = extOf(filename);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (ext === 'pdf' || mimeType === 'application/pdf') return true;
  if (ext === 'docx' || mimeType === DOCX_MIME) return true;
  return false;
}

function wordCountOf(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
}

/** Parse an uploaded document into plain text for KB chunking/embedding. */
export async function extractTextFromDocument(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<ExtractedDocument> {
  const ext = extOf(filename);

  if (ext === 'doc') {
    throw new DocumentExtractError(
      'Legacy .doc files are not supported — save as .docx or PDF and re-upload.',
      'UNSUPPORTED_FORMAT'
    );
  }

  let text: string;
  try {
    if (ext === 'pdf' || mimeType === 'application/pdf') {
      const parser = new PDFParse({ data: buffer });
      try {
        text = (await parser.getText()).text;
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    } else if (ext === 'docx' || mimeType === DOCX_MIME) {
      text = (await mammoth.extractRawText({ buffer })).value;
    } else if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith('text/')) {
      text = buffer.toString('utf-8');
    } else {
      throw new DocumentExtractError(
        `Unsupported file type "${ext || mimeType}". Upload PDF, DOCX, TXT, or MD.`,
        'UNSUPPORTED_FORMAT'
      );
    }
  } catch (err) {
    if (err instanceof DocumentExtractError) throw err;
    throw new DocumentExtractError(
      `Could not read this file — it may be corrupted or password-protected.`,
      'PARSE_FAILED'
    );
  }

  const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const wordCount = wordCountOf(cleaned);

  if (wordCount === 0) {
    throw new DocumentExtractError(
      'No readable text found in this file — it may be a scanned/image-only document.',
      'NO_TEXT'
    );
  }

  return { text: cleaned, wordCount };
}

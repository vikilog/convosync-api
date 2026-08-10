/**
 * Build a Content-Disposition value safe for Node's setHeader.
 * ASCII `filename` fallback + RFC 5987 `filename*` for unicode names.
 */
export function contentDisposition(
  type: 'inline' | 'attachment',
  filename: string
): string {
  const name = filename.trim() || 'file';
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'file';
  // encodeURIComponent = UTF-8 percent-encoding (RFC 5987); escape extras RFC disallows in attr
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

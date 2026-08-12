// Allow dotted keys so {{contact.name}} is extracted / replaced (not left literal).
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function extractTemplateVariables(...parts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const match of part.matchAll(VARIABLE_PATTERN)) {
      const key = match[1];
      if (key) found.add(key);
    }
  }
  return [...found].sort();
}

export function applyTemplateVariables(
  template: string,
  variables: Record<string, string> = {}
): string {
  return template.replace(VARIABLE_PATTERN, (_, key: string) => variables[key] ?? '');
}

/** Decode common entities; loop catches double-encoding (&amp;nbsp; → &nbsp; → space). */
function decodeHtmlEntities(value: string): string {
  let s = value;
  for (let i = 0; i < 2; i += 1) {
    s = s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#160;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
  }
  return s;
}

/**
 * HTML → plain text for multipart text/plain + Inbox previews.
 * Preserves paragraph breaks; must not leave literal &nbsp; or collapse into one line.
 */
export function stripHtmlToText(html: string): string {
  const withBreaks = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|blockquote|table|ul|ol|hr)>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(withBreaks)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function wrapEmailHtml(bodyHtml: string): string {
  const trimmed = bodyHtml.trim();
  if (/<html[\s>]/i.test(trimmed)) return trimmed;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;color:#1c1e21;">
${trimmed}
</body>
</html>`;
}

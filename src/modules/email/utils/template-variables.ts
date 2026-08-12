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

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
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

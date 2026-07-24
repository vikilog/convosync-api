import * as cheerio from 'cheerio';

const MAX_CONTENT_CHARS = 8_000;

function metaContent($: cheerio.CheerioAPI, ...selectors: string[]): string {
  for (const sel of selectors) {
    const v = $(sel).attr('content')?.trim();
    if (v) return v;
  }
  return '';
}

function collectJsonLdText($: cheerio.CheerioAPI): string {
  const parts: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()?.trim();
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as unknown;
      const walk = (node: unknown): void => {
        if (node == null) return;
        if (typeof node === 'string') {
          const t = node.trim();
          if (t.length > 20) parts.push(t);
          return;
        }
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (typeof node === 'object') {
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            if (['name', 'headline', 'description', 'text', 'articleBody', 'about'].includes(k)) {
              walk(v);
            } else if (k === '@graph') {
              walk(v);
            }
          }
        }
      };
      walk(data);
    } catch {
      /* ignore bad JSON-LD */
    }
  });
  return parts.join('\n\n');
}

/** Extract readable text from HTML. Handles SPA shells via meta/OG/JSON-LD fallback. */
export function extractTextFromHtml(html: string): {
  title: string;
  metaDesc: string;
  bodyText: string;
  source: 'body' | 'meta_fallback';
} {
  const $ = cheerio.load(html);

  const title =
    $('title').first().text().trim() ||
    metaContent($, 'meta[property="og:title"]', 'meta[name="twitter:title"]');

  const metaDesc = metaContent(
    $,
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]'
  );

  const jsonLd = collectJsonLdText($);
  const noscriptText = $('noscript')
    .map((_, el) => $(el).text())
    .get()
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  $('script, style, svg, nav, footer, header, .cookie-banner, #cookie-notice').remove();

  const mainText = ($('main').text() || $('article').text() || $('[role="main"]').text() || $('body').text())
    .replace(/\s+/g, ' ')
    .trim();

  let bodyText = mainText;
  let source: 'body' | 'meta_fallback' = 'body';

  // SPA / empty body: use meta + OG + JSON-LD + noscript (common for Vite/React shells)
  if (bodyText.length < 80) {
    const fallback = [metaDesc, jsonLd, noscriptText].filter(Boolean).join('\n\n').trim();
    if (fallback.length > bodyText.length) {
      bodyText = fallback;
      source = 'meta_fallback';
    }
  }

  bodyText = bodyText.substring(0, MAX_CONTENT_CHARS);

  return { title, metaDesc, bodyText, source };
}

export function wordCountOf(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

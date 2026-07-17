type FaqPair = { question: string; answer: string };

function tryParsePairs(text: string): FaqPair[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const raw = JSON.parse(jsonMatch[0]) as unknown;
      if (Array.isArray(raw)) {
        return raw
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map((o) => ({
            question: String(o.question ?? o.q ?? '').trim(),
            answer: String(o.answer ?? o.a ?? '').trim(),
          }))
          .filter((p) => p.question && p.answer);
      }
    } catch {
      /* not JSON */
    }
  }

  const pairs: FaqPair[] = [];
  const qRe = /(?:^|\n)\s*(?:Q(?:uestion)?)\s*[:.\-)]\s*(.+?)(?=\n\s*(?:A(?:nswer)?)\s*[:.\-)]|$)/gis;
  const aRe = /(?:^|\n)\s*(?:A(?:nswer)?)\s*[:.\-)]\s*(.+?)(?=\n\s*(?:Q(?:uestion)?)\s*[:.\-)]|$)/gis;
  const questions = [...text.matchAll(qRe)].map((m) => m[1]?.trim() ?? '');
  const answers = [...text.matchAll(aRe)].map((m) => m[1]?.trim() ?? '');
  for (let i = 0; i < Math.min(questions.length, answers.length); i++) {
    if (questions[i] && answers[i]) pairs.push({ question: questions[i], answer: answers[i] });
  }
  return pairs;
}

function overlapScore(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

/** Prefer a concrete FAQ answer; otherwise return cleaned chunk text. */
export function extractDirectAnswer(chunkText: string, userQuery: string): string {
  const pairs = tryParsePairs(chunkText);
  if (pairs.length === 1) return pairs[0].answer;
  if (pairs.length > 1) {
    let best = pairs[0];
    let bestScore = -1;
    for (const p of pairs) {
      const s = overlapScore(userQuery, p.question);
      if (s > bestScore) {
        bestScore = s;
        best = p;
      }
    }
    return best.answer;
  }

  return chunkText
    .replace(/^Title:\s*.+$/im, '')
    .replace(/^Type:\s*.+$/im, '')
    .replace(/^URL:\s*.+$/im, '')
    .trim();
}

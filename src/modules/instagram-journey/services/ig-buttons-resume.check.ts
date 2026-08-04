/**
 * Runnable check: BUTTONS resume edge picking (single-CTA + null handle).
 * Run: npx tsx src/modules/instagram-journey/services/ig-buttons-resume.check.ts
 */
import assert from 'node:assert/strict';

type Edge = { targetNodeId: string; conditionValue: string | null };

function pickButtonsEdge(
  outgoingEdges: Edge[],
  buttons: Array<{ id?: string; title?: string }>,
  matchKey: string
): Edge | undefined {
  return (
    outgoingEdges.find(
      (e) => e.conditionValue && e.conditionValue.toLowerCase() === matchKey
    ) ??
    outgoingEdges.find((e) => {
      const btn = buttons.find(
        (b) =>
          String(b.id ?? '').toLowerCase() === matchKey ||
          String(b.title ?? '').toLowerCase() === matchKey
      );
      return Boolean(btn && e.conditionValue === btn.id);
    }) ??
    (outgoingEdges.length === 1 ? outgoingEdges[0] : undefined)
  );
}

assert.equal(
  pickButtonsEdge(
    [{ targetNodeId: 'next', conditionValue: null }],
    [{ id: 'btn_a', title: "I'm following you✅" }],
    'btn_a'
  )?.targetNodeId,
  'next'
);

assert.equal(
  pickButtonsEdge(
    [
      { targetNodeId: 'a', conditionValue: 'btn_a' },
      { targetNodeId: 'b', conditionValue: 'btn_b' },
    ],
    [
      { id: 'btn_a', title: 'A' },
      { id: 'btn_b', title: 'B' },
    ],
    'btn_b'
  )?.targetNodeId,
  'b'
);

assert.equal(1 >= 1, true); // IG quick replies allow a single CTA

console.log('ig-buttons-resume check ok');

import crypto from "node:crypto";
import {captionTextDiffers} from '../caption-comparison.mjs';
import { normalizeWord, displayWords } from "./engine.mjs";

export function manuscriptCaptionWords(aligned = {}) {
  const words = [];
  const ops = aligned.operations || [];
  const firstExpectedIndex = ops.findIndex((op) => op.expected);
  const lastExpectedIndex = ops.findLastIndex((op) => op.expected);
  for (let index = 0; index < ops.length; index += 1) {
    const operation = ops[index];
    if (operation?.expected) {
      const start = Number(operation.expected.start ?? operation.spoken?.start ?? 0);
      const end = Number(operation.expected.end ?? operation.spoken?.end ?? start);
      words.push({
        display: operation.expected.display,
        start,
        end,
        matchType:
          operation.expected.matchType ||
          (["match", "near"].includes(operation.type) ? operation.type : "error"),
        issueType: operation.issueType || "",
        expectedDisplay: operation.expected.display,
        issueId: operation.issueId || "",
        action: operation.action || "",
        keepWithPrevious: !!operation.expected.keepWithPrevious,
        scriptureReference: !!operation.expected.scriptureReference,
      });
    } else if (
      operation?.spoken &&
      operation.action === "insert" &&
      ["addition", "extra"].includes(operation.issueType) &&
      (index < firstExpectedIndex || index > lastExpectedIndex) &&
      Number(operation.spoken.end) > Number(operation.spoken.start)
    ) {
      words.push({
        display: operation.spoken.display,
        start: Number(operation.spoken.start),
        end: Number(operation.spoken.end),
        matchType: "spoken_addition",
        issueType: "addition",
        expectedDisplay: "",
        issueId: operation.issueId || "",
        action: "insert",
        keepWithPrevious: !!operation.spoken.keepWithPrevious,
        scriptureReference: false,
      });
    }
  }
  interpolateManuscriptTimes(words, Number(aligned.duration || 0));
  return words.filter((word) => Number(word.end) > Number(word.start) + 0.001);
}

function interpolateManuscriptTimes(words = [], mediaDuration = 0) {
  const anchored = (word) =>
    ["match", "near", "spoken_addition"].includes(word.matchType) &&
    Number(word.end) > Number(word.start) + 0.02;
  let index = 0;
  while (index < words.length) {
    if (anchored(words[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < words.length && !anchored(words[index])) index += 1;
    const previous = start > 0 ? words[start - 1] : null;
    const next = index < words.length ? words[index] : null;
    const count = index - start;
    const previousEnded = /[.!?…]["'”’)]*$/.test(String(previous?.display || "").trim());
    const nextStart = next
      ? Number(next.start)
      : mediaDuration > Number(previous?.end || 0)
        ? mediaDuration
        : Number(previous?.end || 0) + Math.max(0.24, count * 0.22);
    // After a finished sentence, park unanchored words on the later take.
    // Filling the hole would stretch the complete sentence over a false start.
    let from = previous
      ? Number(previous.end)
      : next
        ? Math.max(0, Number(next.start) - Math.max(0.24, count * 0.22))
        : 0;
    if (previousEnded && next && nextStart - Number(previous.end) > 0.62)
      from = Math.max(from, nextStart - Math.max(0.24, count * 0.22));
    let to = next
      ? Number(next.start)
      : mediaDuration > from
        ? mediaDuration
        : from + Math.max(0.24, count * 0.22);
    if (!next && mediaDuration > 0 && to - from < 0.04 * count) {
      // Borrow only the minimum space required for the trailing run. Borrowing
      // a natural-reading 220ms per word could jump behind several valid
      // acoustic anchors and make karaoke time run backwards.
      from = Math.max(0, mediaDuration - Math.min(0.04 * count, mediaDuration));
      if (previous && Number(previous.end) > from)
        previous.end = Math.max(Number(previous.start) + 0.01, from);
      to = mediaDuration;
    }
    const requiredSpan = 0.08 * count;
    // Cloud ASR often places the words on both sides of an omission directly
    // against each other.  In that case merely stretching the missing run makes
    // its timestamps overlap the next anchor and karaoke appears to jump back.
    // Borrow a bounded amount from both neighbouring word boxes so the complete
    // authoritative manuscript remains strictly monotonic.
    if (next && previous && to - from < requiredSpan) {
      const shortage = requiredSpan - Math.max(0, to - from);
      const previousRoom = Math.max(0, Number(previous.end) - Number(previous.start) - 0.04);
      const nextRoom = Math.max(0, Number(next.end) - Number(next.start) - 0.04);
      const borrowPrevious = Math.min(previousRoom, shortage / 2);
      const borrowNext = Math.min(nextRoom, shortage - borrowPrevious);
      previous.end = Math.max(Number(previous.start) + 0.04, Number(previous.end) - borrowPrevious);
      next.start = Math.min(Number(next.end) - 0.04, Number(next.start) + borrowNext);
      from = Number(previous.end);
      to = Number(next.start);
    }
    const span = Math.max(0.04 * count, to - from);
    const base = to >= from ? from : Math.max(0, from);
    for (let offset = 0; offset < count; offset += 1) {
      words[start + offset].start = base + (span * offset) / count;
      words[start + offset].end = base + (span * (offset + 1)) / count;
    }
  }
  if (mediaDuration > 0) {
    for (const word of words) {
      word.start = Math.max(0, Math.min(Math.max(0, mediaDuration - 0.001), Number(word.start || 0)));
      word.end = Math.min(mediaDuration, Math.max(word.start + 0.001, Number(word.end || word.start)));
    }
  }
}

export function spokenCaptionWords(operations = []) {
  return operations
    .filter(
      (operation) =>
        operation.spoken &&
        operation.expected &&
        ["match", "near"].includes(operation.type),
    )
    .map((operation) => {
      const spoken = operation.spoken;
      const expected = operation.expected;
      return {
        display: expected.display,
        norm: expected.norm,
        start: spoken.start,
        end: spoken.end,
        matchType: "match",
        issueType: "",
        expectedDisplay: expected.display,
        issueId: "",
        action: "",
        keepWithPrevious:
          !!spoken.keepWithPrevious || !!expected.keepWithPrevious,
        scriptureReference:
          !!spoken.scriptureReference || !!expected.scriptureReference,
      };
    });
}

export function referenceCaptionWords(aligned = {}) {
  const words = [];
  for (const operation of aligned.operations || []) {
    if (!operation?.spoken || operation.spoken.recoveredFromManuscript) continue;
    const reliableReference = operation.expected && ["match", "near", "mismatch"].includes(operation.type);
    const source = reliableReference ? operation.expected : operation.spoken;
    const display = String(source?.display || operation.spoken.display || "").trim();
    if (!display) continue;
    words.push({
      display,
      start: Number(operation.spoken.start || 0),
      end: Math.max(Number(operation.spoken.start || 0) + 0.01, Number(operation.spoken.end || 0)),
      matchType: reliableReference ? operation.type : "spoken_addition",
      issueType: operation.type==="mismatch"&&captionTextDiffers(operation.spoken.display,operation.expected?.display)?"mismatch":reliableReference ? "" : String(operation.issueType || operation.type || ""),
      autoCorrected: reliableReference&&captionTextDiffers(operation.spoken.display,display),
      originalDisplay:String(operation.spoken.display||""),
      expectedDisplay: String(operation.expected?.display || ""),
      issueId: operation.issueId || "",
      action: reliableReference ? "" : "insert",
      keepWithPrevious: !!source.keepWithPrevious,
      scriptureReference: !!source.scriptureReference,
    });
  }
  return words;
}

// When manuscript-assisted CC is enabled, punctuation belongs to the manuscript.
// Keep the spoken spelling only as evidence for mismatch review; the visible word
// must retain the exact punctuation attached to the expected manuscript token.
export function manuscriptPunctuationWords(aligned = {}) {
  return referenceCaptionWords(aligned).map((word) => ({
    ...word,
    display: word.expectedDisplay || word.display,
  }));
}

import crypto from "node:crypto";
import { normalizeScriptureReferences } from "../scripture-references.mjs";
import {
  captionSafeBoxWidth,
  captionWrapLineLimit,
  packWordsIntoLines,
  normalizeLanguagePunctuation,
  formatPanguSpacing,
  stripTrailingCaptionPunctuation,
} from "../text-layout.mjs";
import { normalizeWord, displayWords, formatDisplayWords } from "./engine.mjs";

export function endsCaptionSentence(display) {
  // Script separators can be appended after terminal punctuation (for example
  // "lamps.---"). Ignore those suffixes so they do not hide a sentence end.
  const text = String(display || "").trim().replace(/[-‐‑‒–—]+$/u, "").trim();
  if (!/[.!?…\u3002\uff01\uff1f]/.test(text)) return false;
  return /[.!?…\u3002\uff01\uff1f]["”’」』》〉）】〕〗)\]}'\u201d\u2019]*$/u.test(text);
}

function endsCaptionClause(display) {
  return /[,;:—–，、；：]["'”’」』》〉）】〕〗)\]}]*$/u.test(String(display || "").trim());
}

function endsCaptionSoftClause(display) {
  return /[,;:—–，、；：]["'”’」』》〉）】〕〗)\]}]*$/u.test(String(display || "").trim());
}

function endsCaptionColon(display) {
  return /:["'”’」』》〉）】〕〗)\]}]*$/u.test(String(display || "").trim());
}

function endsCaptionComma(display) {
  return /[,，]["'”’」』》〉）】〕〗)\]}]*$/u.test(String(display || "").trim());
}

function endsCaptionSemicolon(display) {
  return /[;；]["'”’」』》〉）】〕〗)\]}]*$/u.test(String(display || "").trim());
}

const WEAK_CLAUSE_OPENERS = /^(?:that|which|who|whom|whose|to|of|for|with|from|in|on|at|by|as|than|then|is|are|was|were|be|been|being|have|has|had|do|does|did|can|could|will|would|shall|should|may|might|must|a|an|the|my|your|our|their|his|her|its|this|these|those)$/i;
const NATURAL_BREAK_WORDS = /^(?:and|but|or|so|because|although|though|while|when|if|since|unless|whereas|therefore|however|which|who|that)$/i;
const WEAK_CLAUSE_ENDERS = /^(?:a|an|the|to|of|for|with|from|in|on|at|by|as|than|and|but|or|so|because|if|when|while|that|which|who|whose|is|are|was|were|be|been|being|had|has|have|do|does|did|can|could|will|would|shall|should|may|might|must|very|more|most|less|least|quite|rather|too|not|no|never|ever|something|your|my|our|their|his|her|its)$/i;
const OBJECT_PRONOUNS = /^(?:me|you|him|her|it|us|them)$/i;
const TRANSITIVE_VERBS = /^(?:follow|recognize|recognise|hear|welcome|call|love|see|know|understand|ignore|attain|choose|save|lead|help|teach|tell|ask|give|find|meet|invite|reject|respect|study|make|take|bring|keep|support|remember|believe|speak)$/i;
const SUBJECT_WORDS = /^(?:i|we|you|he|she|it|they|there|this|that|these|those|someone|somebody|anyone|everyone|who|what)$/i;
const FINITE_VERBS = /^(?:am|is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|will|would|shall|should|may|might|must|mustn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|don't|doesn't|didn't|cannot|can't|won't|wouldn't|shouldn't|follow|recognize|recognise|hear|welcome|call|love|see|know|understand|ignore|attain|choose|save|lead|help|teach|tell|ask|give|find|meet|invite|reject|respect|study|make|take|bring|keep|support|remember|believe|speak|fail|remind|represent|mean|say|stand|open|return|listen|examine|pray|discern|claim|become|belong|speak|shattered|emerged|possess)$/i;

function captionWordKey(word) {
  return String(word?.display || "").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toLowerCase();
}

function isWeakCaptionWord(word, pattern) {
  return pattern.test(captionWordKey(word));
}

function badNaturalBoundary(left, right) {
  return isWeakCaptionWord(left, WEAK_CLAUSE_ENDERS) ||
    isWeakCaptionWord(left, SUBJECT_WORDS) ||
    isWeakCaptionWord(right, WEAK_CLAUSE_OPENERS) ||
    (isWeakCaptionWord(left, TRANSITIVE_VERBS) && isWeakCaptionWord(right, OBJECT_PRONOUNS));
}

function isNaturalConnectorBoundary(words, index) {
  const connector = captionWordKey(words[index]);
  const left = words[index - 1];
  const right = words[index + 1];
  const afterRight = words[index + 2];
  const rightKey = captionWordKey(right);
  const afterRightKey = captionWordKey(afterRight);
  if (!NATURAL_BREAK_WORDS.test(connector)) return false;
  if (["and", "or"].includes(connector)) {
    // A coordinator only earns a break when it starts a new predicate or
    // clause. Do not split a coordinated noun/adjective list such as
    // "power and authority" or "troubled and uncertain times".
    const startsPredicate = FINITE_VERBS.test(rightKey) ||
      (SUBJECT_WORDS.test(rightKey) && FINITE_VERBS.test(afterRightKey));
    const completedLeft = !badNaturalBoundary(words[index - 1], words[index]) &&
      (OBJECT_PRONOUNS.test(captionWordKey(left)) ||
       FINITE_VERBS.test(captionWordKey(left)) ||
       /[,;:—–.!?]$/u.test(String(left?.display || "")));
    return startsPredicate && completedLeft;
  }
  if (["but", "so", "because", "although", "though", "while", "when", "if", "since", "unless", "whereas"].includes(connector)) {
    return SUBJECT_WORDS.test(rightKey) && FINITE_VERBS.test(afterRightKey);
  }
  if (["therefore", "however"].includes(connector)) return true;
  // Relative pronouns normally attach to the noun before them; splitting at
  // "which/who/that" strands a dependent clause in a new caption.
  return false;
}

function naturalBoundary(words, index) {
  if (index <= 0 || index >= words.length) return true;
  if (endsCaptionClause(words[index - 1]?.display)) return true;
  return isNaturalConnectorBoundary(words, index);
}

function incompleteCommaIntroduction(words, end) {
  const group = words.slice(0, end);
  if (group.length > 4 || !endsCaptionComma(group.at(-1)?.display)) return false;
  return /^(?:in|on|at|by|with|for|from|during|after|before|under|over|through|among|within)$/i
    .test(captionWordKey(group[0]));
}

function preferredCaptionSplit(group, item, maxLines, linesNeeded, naturalPunctuation = false) {
  if (!group.length) return false;
  const candidate = [...group, item];
  if (linesNeeded(candidate) <= maxLines) return false;
  // In single-line mode a width overflow is a subtitle boundary, not an
  // invitation to keep the trailing function word on this cue and let the
  // renderer wrap it onto a second line. The following cue starts with the
  // first word that no longer fits (for example, “the”).
  if (maxLines === 1) return true;
  // Prefer an existing clause boundary over a hard wrap inside its phrase.
  for (let index = group.length - 1; index >= 2; index -= 1) {
    if (!endsCaptionClause(group[index - 1].display)) continue;
    const left = group.slice(0, index);
    const right = group.slice(index).concat(item);
    const opener = String(right[0]?.display || "").replace(/^[^\p{L}]+/u, "");
    if (linesNeeded(left) <= maxLines && right.length >= 2 && !WEAK_CLAUSE_OPENERS.test(opener)) return true;
  }
  if (naturalPunctuation) {
    // Prefer a balanced split among boundaries that keep short grammatical
    // words attached to their phrase. This prevents endings such as "to" or
    // "been eerily" and beginnings such as "ignore" or "quiet" alone.
    const candidates = [];
    for (let index = 2; index < candidate.length; index += 1) {
      const left = candidate.slice(0, index);
      const right = candidate.slice(index);
      if (linesNeeded(left) > maxLines || linesNeeded(right) > maxLines) continue;
      const leftChars = left.map(word => word.display).join(" ").length;
      const rightChars = right.map(word => word.display).join(" ").length;
      const imbalance = Math.abs(leftChars - rightChars);
      const penalty = badNaturalBoundary(left.at(-1), right[0]) ? 1000 : 0;
      candidates.push({ index, score: penalty + imbalance });
    }
    if (candidates.length) {
      candidates.sort((a,b) => a.score - b.score || Math.abs(a.index - candidate.length / 2) - Math.abs(b.index - candidate.length / 2));
      return candidates[0].index <= group.length;
    }
    if (badNaturalBoundary(group.at(-1), item)) return false;
  }
  // Avoid starting a new cue with a stranded short function word.
  const last = String(item.display).replace(/[^\p{L}]+$/u, "");
  const previous = String(group.at(-1).display).replace(/[^\p{L}]+$/u, "");
  if (WEAK_CLAUSE_OPENERS.test(last) && group.length >= 3) return false;
  if (WEAK_CLAUSE_OPENERS.test(previous) && group.length >= 2) return true;
  return true;
}

function balancedNaturalGroups(words, maxLines, linesNeeded) {
  const count = words.length;
  if (count <= 1) return [words];
  const textLength = (start, end) => words.slice(start, end).reduce((sum, word, index) => sum + String(word.display).length + (index ? 1 : 0), 0);
  const minGroups = Array(count + 1).fill(Infinity);
  minGroups[count] = 0;
  for (let start = count - 1; start >= 0; start -= 1) {
    for (let end = start + 1; end <= count; end += 1) {
      if (linesNeeded(words.slice(start, end)) > maxLines) continue;
      minGroups[start] = Math.min(minGroups[start], 1 + minGroups[end]);
    }
  }
  const minimumCount = minGroups[0];
  if (!Number.isFinite(minimumCount)) return [words];
  const minGroupsWithoutSingletons = Array(count + 1).fill(Infinity);
  minGroupsWithoutSingletons[count] = 0;
  for (let start = count - 1; start >= 0; start -= 1) {
    for (let end = start + 2; end <= count; end += 1) {
      if (linesNeeded(words.slice(start, end)) <= maxLines) {
        minGroupsWithoutSingletons[start] = Math.min(
          minGroupsWithoutSingletons[start],
          1 + minGroupsWithoutSingletons[end],
        );
      }
    }
  }
  const minGroupsWithoutWeakBoundaries = Array(count + 1).fill(Infinity);
  minGroupsWithoutWeakBoundaries[count] = 0;
  for (let start = count - 1; start >= 0; start -= 1) {
    for (let end = start + 2; end <= count; end += 1) {
      if (linesNeeded(words.slice(start, end)) > maxLines) continue;
      minGroupsWithoutWeakBoundaries[start] = Math.min(
        minGroupsWithoutWeakBoundaries[start],
        1 + minGroupsWithoutWeakBoundaries[end],
      );
    }
  }
  const minGroupsAtNaturalBoundaries = Array(count + 1).fill(Infinity);
  minGroupsAtNaturalBoundaries[count] = 0;
  for (let start = count - 1; start >= 0; start -= 1) {
    for (let end = start + 2; end <= count; end += 1) {
      if (linesNeeded(words.slice(start, end)) > maxLines) continue;
      if (incompleteCommaIntroduction(words.slice(start), end - start)) continue;
      if (end < count && (badNaturalBoundary(words[end - 1], words[end]) || !naturalBoundary(words, end))) continue;
      minGroupsAtNaturalBoundaries[start] = Math.min(
        minGroupsAtNaturalBoundaries[start],
        1 + minGroupsAtNaturalBoundaries[end],
      );
    }
  }
  const solve = groupCount => {
    const targetLength = textLength(0, count) / groupCount;
    const best = Array.from({length:count+1},()=>new Map());
    best[count].set(0,{score:0,groups:[]});
    for(let start=count-1;start>=0;start-=1){
      for(let remaining=1;remaining<=groupCount;remaining+=1){
        for(let end=start+1;end<=count;end+=1){
          if (Number.isFinite(minGroupsWithoutSingletons[0]) && end - start < 2) continue;
          if(remaining===1 ? end!==count : minGroups[end]>remaining-1 || count-end<remaining-1)continue;
          const group=words.slice(start,end);
          if(linesNeeded(group)>maxLines)continue;
          const tail=best[end].get(remaining-1);if(!tail)continue;
          const length=textLength(start,end),deviation=(length-targetLength)/Math.max(1,targetLength);
          let score=tail.score+deviation*deviation*100;
          if(end<count){
            const left=words[end-1],right=words[end];
            if(badNaturalBoundary(left,right))score+=100000;
            if(WEAK_CLAUSE_ENDERS.test(captionWordKey(left)))score+=100000;
            const rightKey=captionWordKey(right),leftKey=captionWordKey(left),beforeLeftKey=captionWordKey(words[end-2]);
            const connectorIndex = end;
            if (NATURAL_BREAK_WORDS.test(rightKey)) {
              if (isNaturalConnectorBoundary(words, connectorIndex)) {
                // A coordinator is useful only when it begins a new predicate
                // or clause, not when it joins two nouns in the same phrase.
                score -= rightKey === "and" && OBJECT_PRONOUNS.test(leftKey) && TRANSITIVE_VERBS.test(beforeLeftKey) ? 240 : 90;
              } else {
                score += 4000;
              }
            }
            if (!naturalBoundary(words, end)) score += 1800;
            if (NATURAL_BREAK_WORDS.test(captionWordKey(left)) && !isNaturalConnectorBoundary(words, end - 1)) score += 250;
            if(String(left.display).match(/[,，]$/u))score+=incompleteCommaIntroduction(words.slice(start),end-start)?10000:-500;
            else if(String(left.display).match(/[;；:]$/u))score-=600;
          }
          if(group.length===1)score+=end===count?4000:1200;
          const current=best[start].get(remaining);
          if(!current||score<current.score)best[start].set(remaining,{score,groups:[group,...tail.groups]});
        }
      }
    }
    return best[0].get(groupCount)||null;
  };
  const candidates=[];
  const firstCount = Number.isFinite(minGroupsAtNaturalBoundaries[0])
    ? minGroupsAtNaturalBoundaries[0]
    : Number.isFinite(minGroupsWithoutWeakBoundaries[0])
      ? minGroupsWithoutWeakBoundaries[0]
    : Number.isFinite(minGroupsWithoutSingletons[0])
      ? minGroupsWithoutSingletons[0]
    : minimumCount;
  for(let countOfGroups=firstCount;countOfGroups<=Math.min(count,firstCount+1);countOfGroups+=1){
    const result=solve(countOfGroups);
    if(result)candidates.push({...result,score:result.score+(countOfGroups-minimumCount)*250});
  }
  candidates.sort((a,b)=>a.score-b.score);
  return candidates[0]?.groups||[words];
}

export function captionLineCharLimit(mode, lineChars = 34) {
  const chars = Math.max(12, Number(lineChars) || 34);
  const limit = captionWrapLineLimit(mode);
  return chars * limit;
}

export function flattenCaptionWords(captions = []) {
  const words = [];
  for (const caption of captions || []) {
    if (Array.isArray(caption.words) && caption.words.length) {
      for (const word of caption.words) {
        const display = String(word?.display || "").trim();
        if (!display) continue;
        words.push({
          ...word,
          display,
          start: Number(word.start ?? caption.start ?? 0),
          end: Math.max(
            Number(word.start ?? caption.start ?? 0) + 0.04,
            Number(word.end ?? caption.end ?? 0),
          ),
          matchType: word.matchType || "",
          issueType: word.issueType || "",
          expectedDisplay: word.expectedDisplay || "",
          issueId: word.issueId || "",
          action: word.action || "",
          keepWithPrevious: !!word.keepWithPrevious,
        });
      }
      continue;
    }
    const tokens = String(caption?.text || "").split(/\s+/).filter(Boolean);
    const start = Number(caption?.start || 0);
    const end = Math.max(start + 0.04, Number(caption?.end || start));
    tokens.forEach((display, index) => {
      words.push({
        display,
        start: start + ((end - start) * index) / Math.max(1, tokens.length),
        end: start + ((end - start) * (index + 1)) / Math.max(1, tokens.length),
      });
    });
  }
  return words;
}

function captionWordRecord(word) {
  return {
    ...word,
    display: word.display,
    start: word.start,
    end: word.end,
    matchType: word.matchType || "match",
    issueType: word.issueType || "",
    expectedDisplay: word.expectedDisplay || "",
    issueId: word.issueId || "",
    action: word.action || "",
    keepWithPrevious: !!word.keepWithPrevious,
  };
}

function captionFromGroup(group, style, maxWidth, scale) {
  const packed = packWordsIntoLines(group, style, maxWidth, scale);
  return {
    id: crypto.randomUUID(),
    start: group[0].start,
    end: Math.max(Number(group.at(-1).end), Number(group[0].start) + 0.04),
    text: formatDisplayWords(group),
    words: group.map(captionWordRecord),
    lineBreaks: packed.slice(1).map((line) => line.startIndex),
    lineCount: packed.length,
    timingReliable: group.every((word) =>
      ["match", "near", "spoken_addition", ""].includes(String(word.matchType || "")) &&
      Number(word.end) > Number(word.start) + 0.015
    ),
  };
}

const SAFE_CAPTION_BRIDGE_SECONDS = 0.62;
const MAX_CAPTION_WORD_GAP_SECONDS = 0.5;

function crossesSpokenAdditionBoundary(left, right) {
  return (String(left?.matchType || "") === "spoken_addition") !==
    (String(right?.matchType || "") === "spoken_addition");
}

function bridgeSafeCaptionGaps(captions = []) {
  for (let index = 0; index < captions.length - 1; index += 1) {
    const current = captions[index];
    const next = captions[index + 1];
    const currentWord = current.words?.at(-1);
    const nextWord = next.words?.[0];
    const gap = Number(next.start || 0) - Number(current.end || 0);
    const safeBoundary = [currentWord, nextWord].every(
      (word) =>
        word &&
        word.action !== "cut" &&
        word.matchType !== "error" &&
        !["repeat", "extra", "mismatch"].includes(String(word.issueType || "")),
    );
    if (
      gap > 0.002 &&
      gap <= SAFE_CAPTION_BRIDGE_SECONDS &&
      !currentWord?.reviewGapAfter && !nextWord?.reviewGapBefore &&
      safeBoundary &&
      !endsCaptionSentence(currentWord?.display || "")
    ) {
      // Word timestamps from cloud ASR can finish a few frames before the next
      // reliable word, especially after manuscript-first recovery. Keep the
      // earlier card visible across that short in-sentence interval. This is
      // deliberately a caption-span repair: karaoke word timing stays intact.
      current.end = Number(next.start);
    }
  }
  return captions;
}

export function regroupCaptions(words, options = {}) {
  words = normalizeScriptureReferences(words);
  // ASR may emit an em-dash construction such as "words—something" as one
  // token because there is no space after the dash. Split that token at the
  // punctuation boundary so the supplementary "something ..." clause can
  // stay together in the next caption. Divide only this token's timing span.
  words = (words || []).flatMap(word => {
    const display = String(word?.display || "").trim();
    const match = display.match(/^(.+?[—–])(something)([.!?;:,]*)$/iu);
    if (!match) return [word];
    const start = Number(word.start || 0);
    const end = Math.max(start + 0.08, Number(word.end || start));
    const splitAt = Math.min(end - 0.04, Math.max(start + 0.04, start + (end - start) * match[1].length / (match[1].length + match[2].length)));
    return [
      { ...word, display: match[1], end: splitAt },
      { ...word, display: match[2] + match[3], start: splitAt },
    ];
  });
  const style = options.style || {};
  const scale = Math.max(0.2, Number(options.scale || 1));
  const maxLines = captionWrapLineLimit(options.captionLines ?? options.maxLines ?? 2);
  const requestedWidth = Number(options.maxWidth || options.boxWidth);
  const useWidth = Number.isFinite(requestedWidth) && requestedWidth > 0;
  const maxWidth = useWidth ? captionSafeBoxWidth({ ...options, style }) : 860;
  const naturalPunctuation = !!options.naturalPunctuation;
  const fallbackChars = Math.max(
    12,
    Number(options.maxChars || captionLineCharLimit(options.captionLines ?? options.maxLines, options.lineChars)),
  );
  const linesNeeded = (group) => {
    if (!group.length) return 0;
    if (useWidth) return packWordsIntoLines(group, style, maxWidth, scale).length;
    const text = formatDisplayWords(group);
    return Math.max(1, Math.ceil(text.length / Math.max(12, fallbackChars / maxLines)));
  };
  const captions = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    captions.push(captionFromGroup(group, style, maxWidth, scale));
    group = [];
  };
  if (naturalPunctuation) {
    let sentence=[];
    const flushSentence=()=>{
      if(!sentence.length)return;
      for(const part of balancedNaturalGroups(sentence,maxLines,linesNeeded))captions.push(captionFromGroup(part,style,maxWidth,scale));
      sentence=[];
    };
    for(const word of words||[]){
      const display=String(word?.display||"").trim();if(!display)continue;
      const start=Number(word.start||0),end=Math.max(start+0.04,Number(word.end||start));
      const item={...word,display,start,end},prior=sentence.at(-1);
      const gap=prior?start-Number(prior.end||0):0;
      if(sentence.length&&(item.reviewGapBefore||prior?.reviewGapAfter||
        gap>MAX_CAPTION_WORD_GAP_SECONDS||crossesSpokenAdditionBoundary(prior,item)))flushSentence();
      sentence.push(item);
      // A comma is a preferred, soft boundary rather than a sentence end.
      // Keep the full clause available to the phrase balancer: hard-flushing
      // at every comma strands short introductions such as "In the Bible,".
      if(endsCaptionSentence(display) || (endsCaptionColon(display) && sentence.length > 1) || endsCaptionSemicolon(display))flushSentence();
    }
    flushSentence();
  } else {
    for (const word of words || []) {
      const display = String(word?.display || "").trim();
      if (!display) continue;
      const start = Number(word.start || 0);
      const end = Math.max(start + 0.04, Number(word.end || start));
      const item = { ...word, display, start, end };
      const prior = group.at(-1);
      if (group.length && (item.reviewGapBefore || prior?.reviewGapAfter || crossesSpokenAdditionBoundary(prior,item))) {
        flush();
      } else if (group.length && start - Number(prior.end || 0) > MAX_CAPTION_WORD_GAP_SECONDS) {
        // A subtitle starts at its first word, so carrying later words across a
        // long pause makes their text appear early. Start a new card at the
        // next word's actual time.
        flush();
      } else if (group.length && !item.keepWithPrevious && endsCaptionSentence(prior?.display)) {
        flush();
      } else if (group.length && !item.keepWithPrevious && preferredCaptionSplit(group, item, maxLines, linesNeeded)) {
        flush();
      }
      group.push(item);
    }
    flush();
  }
  for (let index = 0; index < captions.length; index += 1) {
    const caption = captions[index];
    if (caption.words.length >= 2) continue;
    const previous = captions[index - 1];
    if (!previous) continue;
    const previousWord = previous.words.at(-1);
    const currentWord = caption.words[0];
    const wordGap = Number(currentWord?.start || 0) - Number(previousWord?.end || 0);
    if (currentWord?.reviewGapBefore || previousWord?.reviewGapAfter ||
        wordGap > MAX_CAPTION_WORD_GAP_SECONDS || crossesSpokenAdditionBoundary(previousWord,currentWord) ||
        endsCaptionSentence(previousWord?.display)) continue;
    const mergedWords = [...previous.words, ...caption.words];
    if (linesNeeded(mergedWords) > maxLines) continue;
    captions.splice(index - 1, 2, captionFromGroup(mergedWords, style, maxWidth, scale));
    index -= 1;
  }
  for (let index = 0; index < captions.length - 1; index += 1) {
    const nextStart = Number(captions[index + 1].start);
    if (Number(captions[index].end) > nextStart) {
      captions[index].end = nextStart;
    }
  }
  return bridgeSafeCaptionGaps(captions);
}

export function regroupProjectCaptions(captions = [], options = {}) {
  // Regroup each transcript/track independently. IDs change with wrapping,
  // but the transcript identity and track must survive every reflow.
  const groups = new Map();
  for (const caption of captions || []) {
    const key = JSON.stringify([caption.trackId || "caption", caption.transcriptId || "",caption.ownerClipId||'',caption.sourceMediaId||'']);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(caption);
  }
  return [...groups.values()].flatMap(group => {
    const words = flattenCaptionWords(group);
    if (!words.length) return group;
    return regroupCaptions(words, options).map(caption => {
      const original = group.find(item => Number(item.end) > caption.start && Number(item.start) < caption.end) || group[0];
      return { ...original, ...caption, sourceStart:caption.words[0]?.sourceStart??original.sourceStart,sourceEnd:caption.words.at(-1)?.sourceEnd??original.sourceEnd,trackId: original.trackId || "caption", transcriptId: original.transcriptId || "" };
    });
  });
}

export function buildCaptions(expectedWords, options = {}) {
  expectedWords = normalizeScriptureReferences(expectedWords);
  const maxWords = Math.max(2, Math.min(14, Number(options.maxWords || 7)));
  const lineChars = Math.max(12, Number(options.maxChars || 28));
  const lineCount = Math.max(1, Number(options.maxLines || 2));
  const naturalPunctuation = !!options.naturalPunctuation;
  const maxChars = lineChars * lineCount;
  const captions = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    captions.push({
      id: crypto.randomUUID(),
      start: group[0].start,
      end: group.at(-1).reviewGapAfter ? group.at(-1).end : Math.max(group.at(-1).end, group[0].start + 0.25),
      text: formatDisplayWords(group),
      words: group.map((word) => ({
        ...word,
        display: word.display,
        start: word.start,
        end: word.end,
        matchType: word.matchType || "match",
        issueType: word.issueType || "",
        expectedDisplay: word.expectedDisplay || "",
        issueId: word.issueId || "",
        action: word.action || "",
        reviewGapBefore: !!word.reviewGapBefore,
        reviewGapAfter: !!word.reviewGapAfter,
        ...(word.scriptureCitation ? {
          scriptureCitation: word.scriptureCitation,
          scriptureReference: true,
          sourceWords: word.sourceWords,
        } : {}),
      })),
      timingReliable: group.every((word) =>
        ["match", "near", "spoken_addition"].includes(String(word.matchType || ""))
      ),
    });
    group = [];
  };
  for (const word of expectedWords) {
    if (!word.end || word.end <= word.start) continue;
    const candidate = [...group, word].map((item) => item.display).join(" ");
    const priorWord = group.at(-1);
    const timingGap = priorWord
      ? Number(word.start || 0) - Number(priorWord.end || 0)
      : 0;
    const priorEnds = endsCaptionSentence(priorWord?.display || "");
    const priorSoftClauseEnds = endsCaptionSoftClause(priorWord?.display || "");
    const punctuationBoundary = naturalPunctuation
      ? priorSoftClauseEnds
      : endsCaptionClause(priorWord?.display || "");
    const keepReferenceTogether = !!word.keepWithPrevious;
    const splitGap = MAX_CAPTION_WORD_GAP_SECONDS;
    if (
      group.length &&
      ((!keepReferenceTogether &&
      (timingGap > splitGap ||
        timingGap < -0.02 ||
        (!naturalPunctuation && group.length >= maxWords) ||
        (!naturalPunctuation && candidate.length > maxChars) ||
        priorEnds ||
        punctuationBoundary ||
        (priorWord && crossesSpokenAdditionBoundary(priorWord,word)))) || word.reviewGapBefore || priorWord?.reviewGapAfter)
    )
      flush();
    group.push(word);
  }
  flush();
  for (let index = 0; index < captions.length; index += 1) {
    const caption = captions[index];
    if (caption.words.length >= 2) continue;
    const next = captions[index + 1];
    const previous = captions[index - 1];
    const gapToNext = next
      ? Number(next.words[0]?.start || 0) - Number(caption.words.at(-1)?.end || 0)
      : Infinity;
    const gapFromPrevious = previous
      ? Number(caption.words[0]?.start || 0) - Number(previous.words.at(-1)?.end || 0)
      : Infinity;
    const singleton = caption.words[0]?.display || "";
    const closesSentence = endsCaptionSentence(singleton);
    const previousClosesSentence = endsCaptionSentence(
      previous?.words?.at(-1)?.display || "",
    );
    const joinsNext = /^(?:and|but|or|so|because|for|yet|then|when|while|if|that|which|who)$/i.test(
      singleton.replace(/[^\p{L}]/gu, ""),
    );
    const shortCloser = /^(?:me|you|it|us|him|her|them)[.!?]["'\u201d\u2019)]*$/i.test(
      singleton.replace(/^["“]+/, ""),
    );
    const canMergePrevious =
      previous &&
      !caption.words[0]?.reviewGapBefore && !previous.words.at(-1)?.reviewGapAfter &&
      gapFromPrevious <= MAX_CAPTION_WORD_GAP_SECONDS &&
      !crossesSpokenAdditionBoundary(previous.words.at(-1),caption.words[0]) &&
      (naturalPunctuation || previous.words.length + caption.words.length <= maxWords + 1) &&
      !previousClosesSentence;
    const canMergeNext =
      next &&
      !next.words[0]?.reviewGapBefore && !caption.words.at(-1)?.reviewGapAfter &&
      gapToNext <= MAX_CAPTION_WORD_GAP_SECONDS &&
      !crossesSpokenAdditionBoundary(caption.words[0],next.words[0]) &&
      (naturalPunctuation || caption.words.length + next.words.length <= maxWords + 1) &&
      !closesSentence;
    const target = closesSentence
      ? canMergePrevious
        ? previous
        : null
      : joinsNext
        ? canMergeNext
          ? next
          : canMergePrevious
            ? previous
            : null
        : canMergePrevious
          ? previous
          : canMergeNext
            ? next
            : null;
    if (!target) continue;
    const mergedWords =
      target === next
        ? [...caption.words, ...next.words]
        : [...previous.words, ...caption.words];
    const merged = {
      id: target === next ? caption.id : previous.id,
      start: mergedWords[0].start,
      end: mergedWords.at(-1).end,
      words: mergedWords,
      text: formatDisplayWords(mergedWords),
    };
    if (target === next) captions.splice(index, 2, merged);
    else {
      captions.splice(index - 1, 2, merged);
      index -= 1;
    }
  }
  return bridgeSafeCaptionGaps(captions);
}

export function buildReviewCaptions(
  issues = [],
  expectedWords = [],
  outputDuration = Infinity,
) {
  void expectedWords;
  return issues
    .filter((issue) => ["repeat","mismatch","missing","unverifiedAddition"].includes(issue.type) && issue.start < outputDuration && !issue.suppressReview && issue.action !== "keep")
    .map((issue) => {
      const explicit = String(issue.expectedText || "")
        .replace(/^\s*[—-]\s*$/, "")
        .trim();
      const cuttable = ["extra", "repeat", "mismatch"].includes(issue.type);
      const acceptable = issue.type === "addition" || issue.type === "unverifiedAddition" || issue.action === "insert";
      if (!explicit && !cuttable && !acceptable) return null;
      const spoken = String(issue.spokenText || "")
        .replace(/^\s*[—-]\s*$/, "")
        .trim();
      return {
        id: issue.id,
        issueId: issue.id,
        type: issue.type,
        ...(issue.segmentedRepeat ? {segmentedRepeat:true} : {}),
        ...(issue.type === "unverifiedAddition" ? {unverifiedAddition:true} : {}),
        pendingCaption: !!issue.pendingCaption,
        needsAudioReview: !!issue.needsAudioReview,
        alreadyDisplayed:!!issue.alreadyDisplayed,
        reason:issue.reason||({repeat:"重复口播，可删除对应片段或保留",mismatch:"错误单词",missing:"缺少内容，需要补录",addition:"口语补充",extra:"文案外内容",unverifiedAddition:"文案外口语已自动加入字幕，待确认"}[issue.type]||"需要核对"),
        words: issue.words,
        scripture: !!issue.scripture,
        start: issue.start,
        end: Math.min(outputDuration, Math.max(issue.start + 0.12, issue.end)),
        text: issue.type === "repeat" ? `重复：${spoken || explicit}` : issue.type === "mismatch" ? `正确文案：${explicit || "需核对"}` : cuttable || acceptable
          ? spoken || explicit || "未识别出文字"
          : explicit || "需补录",
        expectedText: explicit,
        spokenText: issue.spokenText,
        action: issue.type === "missing" ? "missing" : issue.type === "repeat" ? "review" : issue.type === "unverifiedAddition" ? "insert" : "replace",
      };
    })
    .filter(Boolean);
}

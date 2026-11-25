// Keep every unresolved lexical difference visible on the review track,
// including older projects whose CC words did not have review clips.
function restoreUnverifiedAdditionReviews() {
  state.reviewCaptions ||= [];
  const existing = new Set(state.reviewCaptions.map(item => String(item.issueId || item.id || '')));
  const duration = Number(state.duration);
  const candidates = new Map();
  for (const issue of [...(state.issues || []), ...(state.matchIssues || [])]) {
    const type = String(issue?.type || issue?.issueType || '');
    if (!['unverifiedAddition', 'addition', 'extra'].includes(type) && issue?.unverifiedAddition !== true) continue;
    const id = String(issue.issueId || issue.id || '');
    if (!id || candidates.has(id)) continue;
    if (issue.suppressReview || issue.reviewDismissed || issue.action === 'keep') continue;
    if (issue.alreadyDisplayed && !issue.needsAudioReview && !issue.unverifiedAddition && type !== 'unverifiedAddition') continue;
    candidates.set(id, issue);
  }
  for (const [id, issue] of candidates) {
    if (existing.has(id)) continue;
    const sourceWords = Array.isArray(issue.words) ? issue.words : [];
    const startFromWords = sourceWords.reduce((min, word) => Math.min(min, Number(word?.start)), Infinity);
    const endFromWords = sourceWords.reduce((max, word) => Math.max(max, Number(word?.end)), -Infinity);
    const rawStart = Number.isFinite(Number(issue.start)) ? Number(issue.start) : startFromWords;
    const rawEnd = Number.isFinite(Number(issue.end)) ? Number(issue.end) : endFromWords;
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd <= rawStart ||
        (Number.isFinite(duration) && duration >= 0 && rawStart >= duration)) continue;
    const start = Math.max(0, rawStart);
    const end = Number.isFinite(duration) && duration >= 0 ? Math.min(rawEnd, duration) : rawEnd;
    if (end <= start) continue;
    const spokenText = String(issue.spokenText || issue.text || sourceWords.map(word => word?.display || word?.text || '').filter(Boolean).join(' ')).trim();
    let words = sourceWords.map(word => ({...word}));
    if (!words.length) {
      const operationWords = (state.alignmentOperations || [])
        .filter(operation => String(operation.issueId || operation.captionDecisionIssueId || '') === id)
        .flatMap(operation => Array.isArray(operation.spoken) ? operation.spoken : operation.spoken ? [operation.spoken] : [])
        .map(word => typeof word === 'string' ? {display: word} : {...word, display: word.display || word.text || ''})
        .filter(word => word.display);
      words = operationWords;
    }
    if (!words.length && spokenText) words = spokenText.split(/\s+/).filter(Boolean).map(display => ({display}));
    words = words.map((word, index) => {
      const wordStart = Number(word.start), wordEnd = Number(word.end);
      const inferredStart = start + (end - start) * index / Math.max(1, words.length);
      const inferredEnd = start + (end - start) * (index + 1) / Math.max(1, words.length);
      return {...word,
        display: String(word.display || word.text || ''),
        start: Math.max(start, Math.min(end, Number.isFinite(wordStart) ? wordStart : inferredStart)),
        end: Math.max(start, Math.min(end, Number.isFinite(wordEnd) ? wordEnd : inferredEnd)),
        matchType: 'spoken_addition', issueType: 'addition', issueId: id, action: 'insert'};
    }).filter(word => word.display && word.end > word.start);
    const text = spokenText || words.map(word => word.display).join(' ');
    if (!text) continue;
    state.reviewCaptions.push({
      ...issue, id: uid(), issueId: id, start, end, spokenText: text, text,
      expectedText: '', words, type: 'unverifiedAddition', unverifiedAddition: true,
      pendingCaption: false, alreadyDisplayed: false, needsAudioReview: true,
      action: 'insert', trackId: 'review',
      captionTrackId: issue.captionTrackId || state.autoTranscript?.trackId || 'caption',
      reason: issue.reason || '文案外口语已自动加入字幕；试听后可保留或剪除。',
    });
    existing.add(id);
  }
}

// Keep legacy missing-word issues from the script-comparison lane visible in
// the same review lane as newer transcript reviews.
function restoreMissingCaptionReviews() {
  state.reviewCaptions ||= [];
  const existing = new Set(state.reviewCaptions.map(item => String(item.issueId || item.id || "")));
  const duration = Number(state.duration);
  for (const issue of [...(state.issues || []), ...(state.matchIssues || [])]) {
    if (String(issue?.type || issue?.issueType || "") !== "missing") continue;
    const id = String(issue.issueId || issue.id || "");
    if (!id || existing.has(id) || issue.suppressReview || issue.reviewDismissed || issue.action === "keep") continue;
    if (issue.transcriptId && state.autoTranscript?.id && issue.transcriptId !== state.autoTranscript.id) continue;
    const rawStart = Number(issue.start), rawEnd = Number(issue.end);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd <= rawStart ||
        (Number.isFinite(duration) && duration >= 0 && rawStart >= duration)) continue;
    const start = Math.max(0, rawStart);
    const end = Number.isFinite(duration) && duration >= 0 ? Math.min(rawEnd, duration) : rawEnd;
    if (end <= start) continue;
    const expectedText = String(issue.expectedText || issue.text || "").trim();
    if (!expectedText) continue;
    const words = Array.isArray(issue.words) ? issue.words.map(word => ({...word})) : [];
    state.reviewCaptions.push({
      ...issue, id: uid(), issueId: id, start, end, expectedText,
      spokenText: String(issue.spokenText || "—"), text: expectedText, words,
      type: "missing", pendingCaption: false, alreadyDisplayed: false,
      needsAudioReview: true, action: "missing", trackId: "review",
      captionTrackId: issue.captionTrackId || state.autoTranscript?.trackId || "caption",
      reason: issue.reason || "识别结果没有找到对应口播；试听确认是否漏读。",
    });
    existing.add(id);
  }
}

// A script alignment can attach an expected word to the next recognized word,
// even though the same script token was already recognized and captioned.
// Clear that false "missing" marker only when every occurrence in the script
// has a one-to-one match in both the transcript and the caption track.
function resolveFullyCoveredMissingWordReviews(resolved) {
  const transcript = state.autoTranscript;
  const script = String($("scriptText")?.value || "");
  const segments = Array.isArray(transcript?.sourceSegments) ? transcript.sourceSegments : [];
  if (!transcript?.id || !script || !segments.length) return;

  const tokenKey = value => String(value || "").normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  const tokens = value => String(value || "").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
  const scriptCounts = new Map();
  for (const token of tokens(script)) {
    const key = tokenKey(token);
    if (key) scriptCounts.set(key, (scriptCounts.get(key) || 0) + 1);
  }

  const captions = (state.captions || []).filter(caption =>
    (!transcript.trackId || (caption.trackId || "caption") === transcript.trackId));
  const captionWords = captions.flatMap(caption => (caption.words || []).map(word => ({caption, word})));
  for (const review of state.reviewCaptions || []) {
    if (review.type !== "missing" || review.transcriptId !== transcript.id) continue;
    const expectedTokens = tokens(review.expectedText || review.text);
    if (expectedTokens.length !== 1) continue;
    const key = tokenKey(expectedTokens[0]);
    const expectedCount = scriptCounts.get(key) || 0;
    if (!key || !expectedCount) continue;

    const spoken = segments.filter(segment => tokenKey(segment.text || segment.display) === key);
    if (spoken.length !== expectedCount) continue;
    const captionsForToken = captionWords.filter(({caption, word}) =>
      tokenKey(word.display || word.text) === key &&
      (!review.sourceMediaId || !caption.sourceMediaId || caption.sourceMediaId === review.sourceMediaId));
    if (captionsForToken.length !== expectedCount) continue;

    const usedCaptions = new Set();
    const allCovered = spoken.every(segment => {
      const sourceStart = Number(segment.start), sourceEnd = Number(segment.end);
      if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart) return false;
      const match = captionsForToken.find(({caption, word}, index) => {
        if (usedCaptions.has(index) || (review.captionTrackId && (caption.trackId || "caption") !== review.captionTrackId)) return false;
        const start = Number.isFinite(Number(word.sourceStart)) ? Number(word.sourceStart) : Number(word.start);
        const end = Number.isFinite(Number(word.sourceEnd)) ? Number(word.sourceEnd) : Number(word.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
        const overlap = Math.min(sourceEnd, end) - Math.max(sourceStart, start);
        return overlap > 0 && overlap / Math.min(sourceEnd - sourceStart, end - start) >= 0.5;
      });
      if (!match) return false;
      usedCaptions.add(captionsForToken.indexOf(match));
      return true;
    });
    if (!allCovered || usedCaptions.size !== expectedCount) continue;
    if (review.issueId) resolved.add(review.issueId);
    if (review.id) resolved.add(review.id);
  }
}

// Numbered list labels such as "3." are manuscript structure, not spoken
// words. Ignore them only when the transcript has nearby speech on both sides
// and contains no spoken form of that number at the marker position.
function resolveUnspokenListNumberReviews(resolved) {
  const transcript = state.autoTranscript;
  const script = String($("scriptText")?.value || "");
  const segments = Array.isArray(transcript?.sourceSegments) ? transcript.sourceSegments : [];
  if (!transcript?.id || !script || !segments.length) return;
  const numberWords = ["zero","one","two","three","four","five","six","seven","eight","nine","ten",
    "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty"];
  const tokenKey = value => String(value || "").normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  for (const review of state.reviewCaptions || []) {
    if (review.type !== "missing" || review.transcriptId !== transcript.id) continue;
    const marker = String(review.expectedText || review.text || "").trim().match(/^(\d{1,2})\.$/);
    if (!marker) continue;
    const number = Number(marker[1]);
    const markerPattern = new RegExp(`(?:^|\\s)${marker[1]}\\.\\s`, "m");
    if (!markerPattern.test(script)) continue;
    const start = Number(review.start), end = Number(review.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const nearby = segments.filter(segment => Number(segment.start) < end + 0.35 && Number(segment.end) > start - 0.35);
    const spokenForms = new Set([String(number), numberWords[number] || ""]);
    if (nearby.some(segment => spokenForms.has(tokenKey(segment.text || segment.display)))) continue;
    const before = segments.some(segment => Number(segment.end) <= start + 0.025 && start - Number(segment.end) <= 0.35);
    const after = segments.some(segment => Number(segment.start) >= start - 0.025 && Number(segment.start) - start <= 0.35);
    if (!before || !after) continue;
    if (review.issueId) resolved.add(review.issueId);
    if (review.id) resolved.add(review.id);
  }
}

function syncCaptionCorrectionReviews() {
  state.reviewCaptions ||= [];
  state.issues ||= [];
  restoreUnverifiedAdditionReviews();
  restoreMissingCaptionReviews();
  if (typeof keepSpokenReviewInCaptions === 'function') {
    for (const review of state.reviewCaptions) {
      if (review.type !== 'unverifiedAddition' && !review.unverifiedAddition) continue;
      if (review.autoAddedToCaption) continue;
      review.autoAddedToCaption = true;
      review.reason = '已自动加入主字幕预览；试听后可确认保留，或删除对应音视频片段。';
      keepSpokenReviewInCaptions({...review, pendingCaption:true}, {pendingExtra:true});
    }
  }
  normalizeCaptionPhraseReviews();
  dedupeCaptionMismatchReviews();
  const resolved = new Set(correctExpandedCaptionWords(state.captions));
  resolveFullyCoveredMissingWordReviews(resolved);
  resolveUnspokenListNumberReviews(resolved);
  const cosmetic = new Set();
  const repeatKey=text=>String(text||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const mild=correctHarmlessCaptionWords((state.captions||[]).flatMap(c=>c.words||[]),state.reviewCaptions);
  let mildIndex=0;for(const c of state.captions||[]){const previous=c.words||[];c.words=previous.map(()=>mild.words[mildIndex++]);if(c.words.some((word,index)=>word.display!==previous[index].display))c.text=joinCaptionWords(c.words);}
  for(const id of mild.resolvedIssueIds)resolved.add(id);
  for(const review of state.reviewCaptions){
    if(review.type!=='repeat' || /\s/.test(String(review.spokenText||'').trim()) || !repeatKey(review.spokenText))continue;
    const nearby=(state.captions||[]).filter(c=>(!review.sourceMediaId || !c.sourceMediaId || c.sourceMediaId===review.sourceMediaId) && (!review.captionTrackId || (c.trackId||'caption')===review.captionTrackId)).flatMap(c=>c.words||[]).filter(w=>w.end>review.start-1.2 && w.start<review.end+1.2).sort((a,b)=>a.start-b.start);
    const at=nearby.findIndex(w=>w.issueId===(review.issueId||review.id) && w.start<review.end && w.end>review.start);
    if(at<0)continue;
    const key=repeatKey(review.spokenText);
    const fragments=new Set([nearby[at-1],nearby[at+1]].filter(w=>w && repeatKey(w.display)===key && Number.isFinite(w.sourceStart) && Number.isFinite(w.sourceEnd) && w.sourceEnd-w.sourceStart<.06 && [...(state.videoLayers||[]),...(state.audioAssets||[])].some(media=>Math.abs(Number(media.sourceEnd)-w.sourceEnd)<.002 && w.start<media.end && w.end>media.end)));
    for(const caption of state.captions||[])if((caption.words||[]).some(w=>fragments.has(w))){caption.words=caption.words.filter(w=>!fragments.has(w));caption.text=joinCaptionWords(caption.words);if(caption.words.length){caption.start=caption.words[0].start;caption.end=caption.words.at(-1).end;}}
    const neighbors=[nearby[at-1],nearby[at+1]].filter(w=>w && !fragments.has(w));
    if(neighbors.length && !neighbors.some(w=>repeatKey(w.display)===key && Math.max(0,Math.max(w.start,nearby[at].start)-Math.min(w.end,nearby[at].end))<.6)) {
      resolved.add(review.issueId||review.id);
      for(const w of (state.captions||[]).flatMap(c=>c.words||[]))if(w.issueId===(review.issueId||review.id)){w.issueId='';w.issueType='';w.action='';w.reviewDismissed=true;}
    }
  }
  for (const caption of state.captions || []) {
    const contraction=correctContractionCaptionWords(caption.words || [],[...state.reviewCaptions,...state.issues]);
    const correction = correctNumericCaptionWords(contraction.words, [...state.reviewCaptions,...state.issues]);
    caption.words = correction.words;
    if (correction.words.some(w=>w.autoNumericCorrected || w.autoContractionCorrected || w.scriptureRestored)) caption.text = joinCaptionWords(correction.words);
    for (const id of contraction.resolvedIssueIds) resolved.add(id);
    for (const id of correction.resolvedIssueIds) resolved.add(id);
  }
  for (const word of (state.captions || []).flatMap(c=>c.words || [])) if (word.issueId) resolved.delete(word.issueId);
  // Older analyses sometimes kept additions only in the review lane.
  // Preserve that speech as green subtitle words before dropping its hint.
  for (const review of state.reviewCaptions) {
    if (!['addition','extra'].includes(review.type) || !review.pendingCaption || review.alreadyDisplayed) continue;
    const words = (review.words || []).map(word => ({...word,issueType:'addition',matchType:'spoken_addition',issueId:'',action:''}));
    if (!words.length) continue;
    const present = (state.captions || []).some(c => (c.words || []).some(w =>
      w.start < review.end && w.end > review.start && words.some(v => v.display === w.display)));
    if (!present) state.captions.push({id:uid(),start:review.start,end:review.end,
      text:words.map(w=>w.display).join(' '),words,trackId:review.captionTrackId || 'caption',
      ownerClipId:review.ownerClipId,ownerClipType:review.ownerClipType,
      sourceMediaId:review.sourceMediaId,sourceStart:review.sourceStart,sourceEnd:review.sourceEnd,
      transcriptId:review.transcriptId});
  }
  state.reviewCaptions = state.reviewCaptions.filter(review => {
    if (review.meaningImpact === 'same') { resolved.add(review.issueId || review.id); return false; }
    if (resolved.has(review.issueId || review.id)) return false;
    if (['addition','extra'].includes(review.type) && !review.unverifiedAddition) { resolved.add(review.issueId || review.id); return false; }
    if (review.type === 'mismatch' && captionCorrectionKey(review.spokenText) && captionCorrectionKey(review.expectedText) &&
        !captionCorrectionDiffers(review.spokenText, review.expectedText)) {
      resolved.add(review.issueId || review.id); cosmetic.add(review.issueId || review.id); return false;
    }
    if (!review.captionCorrectionReview) return true;
    const exists = (state.captions || []).some(caption => (caption.words || []).some(word =>
      word.issueId === review.issueId && !word.userKept && word.matchType !== 'edited' &&
      word.start < review.end && word.end > review.start));
    if (!exists) resolved.add(review.issueId);
    return exists;
  });
  state.issues = state.issues.filter(issue => !resolved.has(issue.id) && !['addition','extra'].includes(issue.type));
  state.matchIssues = (state.matchIssues || []).filter(issue => !resolved.has(issue.id) && !['addition','extra'].includes(issue.type));
  for (const caption of state.captions || []) {
    for (const word of caption.words || []) {
      if (cosmetic.has(word.issueId)) { if(word.acronymReviewId)word.reviewDismissed=true; word.issueId = ''; word.issueType = ''; word.action = ''; }
      if (word.meaningReview?.meaningImpact === 'same' || word.autoMildCorrected || word.autoContractionCorrected || word.autoNumericCorrected || word.reviewDismissed || word.userKept || word.matchType === 'edited' || word.issueType === 'edited-timing') continue;
      const recognized = word.recognizedDisplay || word.originalDisplay || word.display || '';
      const expected = word.referenceExpected || word.expectedDisplay || '';
      const addition = ['addition','extra'].includes(word.issueType) || word.matchType === 'spoken_addition';
      if (addition) { word.issueType = 'addition'; word.matchType = 'spoken_addition'; word.issueId = ''; word.action = ''; continue; }
      if (word.matchType === 'near' && expected) {
        if (word.issueId) resolved.add(word.issueId);
        word.display=expected;
        word.issueType=''; word.issueId=''; word.action='';
        continue;
      }
      if (!captionCorrectionDiffers(recognized, expected)) {
        if (word.issueType === 'mismatch') { word.issueType = ''; word.issueId = ''; word.action = ''; }
        continue;
      }
      if (word.issueType === 'repeat') continue;
      const existing = state.reviewCaptions.find(review =>
        (word.issueId && (review.issueId || review.id) === word.issueId) &&
        (!review.ownerClipId || review.ownerClipId === caption.ownerClipId) &&
        word.start < review.end && word.end > review.start);
      if (existing) continue;
      const id = word.issueId || uid();
      word.issueId = id;
      word.issueType = addition ? 'addition' : 'mismatch';
      word.expectedDisplay = expected;
      word.action = 'review';
      const review = {
        id: uid(), issueId: id, start: word.start, end: word.end,
        sourceStart: word.sourceStart, sourceEnd: word.sourceEnd,
        ownerClipId: caption.ownerClipId, ownerClipType: caption.ownerClipType,
        sourceMediaId: caption.sourceMediaId, captionTrackId: caption.trackId || 'caption',
        transcriptId: caption.transcriptId, trackId: 'review', type: word.issueType,
        action: 'review', spokenText: recognized, expectedText: expected,
        text: recognized, words: [{...word, display: recognized}],
        scripture: !!word.scriptureReference, alreadyDisplayed: true,
        needsAudioReview: true, confirmedCut: false,
        captionCorrectionReview: true,
      };
      state.reviewCaptions.push(review);
      if (!state.issues.some(issue => issue.id === id)) state.issues.push({...review, id});
    }
  }
  normalizeCaptionPhraseReviews();
  dedupeCaptionMismatchReviews();
  for(const record of state.captionRecoveryArchive || [])for(const word of [...(record.caption?.words || []),...(record.word?[record.word]:[])])if(resolved.has(word.issueId)){word.issueId='';word.issueType='';word.action='';word.reviewDismissed=true;}
  if(reviewDetailsDialog?.open && !state.reviewCaptions.some(r=>r.id===reviewDetailsDialog.reviewId))reviewDetailsDialog.close();
}
function normalizeCaptionPhraseReviews() {
  const merged=mergeCaptionPhraseReviews(state.captions || [],state.reviewCaptions || []);
  state.reviewCaptions=merged.reviews;
  if (!merged.aliases.size) return;
  for (const field of ['issues','matchIssues']) {
    state[field]=(state[field] || []).filter(issue=>!merged.aliases.has(issue.id));
    for(const issue of state[field]) {
      const review=merged.reviews.find(r=>(r.issueId || r.id)===issue.id);
      if(review) Object.assign(issue,{start:review.start,end:review.end,spokenText:review.spokenText,expectedText:review.expectedText});
    }
  }
}

function sameCaptionMismatchOccurrence(left, right) {
  if (!left || !right || left.type !== 'mismatch' || right.type !== 'mismatch') return false;
  const key = value => captionCorrectionKey(value || '');
  if (!key(left.spokenText) || key(left.spokenText) !== key(right.spokenText) ||
      !key(left.expectedText) || key(left.expectedText) !== key(right.expectedText)) return false;
  const leftIssueId = String(left.issueId || ''), rightIssueId = String(right.issueId || '');
  const sameIssue = !!leftIssueId && leftIssueId === rightIssueId;
  for (const field of ['captionTrackId','sourceMediaId','transcriptId'])
    if (String(left[field] || '') !== String(right[field] || '')) return false;
  if (!sameIssue && String(left.ownerClipId || '') !== String(right.ownerClipId || '')) return false;
  const aStart = Number(left.start), aEnd = Number(left.end), bStart = Number(right.start), bEnd = Number(right.end);
  if (![aStart,aEnd,bStart,bEnd].every(Number.isFinite) || aEnd <= aStart || bEnd <= bStart) return false;
  const overlap = Math.min(aEnd,bEnd) - Math.max(aStart,bStart);
  const shorter = Math.min(aEnd-aStart,bEnd-bStart);
  return (overlap > .005 && overlap / shorter >= .75) ||
    (Math.abs(aStart-bStart) <= .035 && Math.abs(aEnd-bEnd) <= .06);
}

function dedupeCaptionMismatchReviews() {
  const kept = [], aliases = new Map(), droppedReviewIds = new Set();
  for (const review of state.reviewCaptions || []) {
    const existing = kept.find(item => sameCaptionMismatchOccurrence(item,review));
    if (!existing) { kept.push(review); continue; }
    const canonical = String(existing.issueId || existing.id || '');
    for (const alias of [review.issueId || review.id, review.id])
      if (alias && String(alias) !== canonical) aliases.set(String(alias),canonical);
    if (review.id) droppedReviewIds.add(String(review.id));
    // One caption mismatch can be linked to both the video and its paired
    // audio clip. Keep one review marker, but retain the caption-owning record
    // so replacement actions still resolve the right subtitle words.
    if (review.captionCorrectionReview && !existing.captionCorrectionReview) {
      Object.assign(existing, {
        ownerClipId: review.ownerClipId,
        ownerClipType: review.ownerClipType,
        sourceMediaId: review.sourceMediaId || existing.sourceMediaId,
        sourceStart: review.sourceStart ?? existing.sourceStart,
        sourceEnd: review.sourceEnd ?? existing.sourceEnd,
        captionTrackId: review.captionTrackId || existing.captionTrackId,
        transcriptId: review.transcriptId || existing.transcriptId,
        trackId: review.trackId || existing.trackId,
        captionCorrectionReview: true,
        needsAudioReview: review.needsAudioReview ?? existing.needsAudioReview,
      });
    }
    const words = [...(existing.words || [])];
    for (const word of review.words || []) {
      const duplicate = words.some(item => Number(item.start) === Number(word.start) &&
        Number(item.end) === Number(word.end) && String(item.display || '') === String(word.display || ''));
      if (!duplicate) words.push(word);
    }
    if (words.length) existing.words = words;
  }
  state.reviewCaptions = kept;
  if (aliases.size) {
    for (const caption of state.captions || []) for (const word of caption.words || []) {
      const alias = String(word.issueId || '');
      if (aliases.has(alias)) word.issueId = aliases.get(alias);
      const acronymAlias = String(word.acronymReviewId || '');
      if (aliases.has(acronymAlias)) word.acronymReviewId = aliases.get(acronymAlias);
    }
    for (const review of state.reviewCaptions) {
      const alias = String(review.issueId || '');
      if (aliases.has(alias)) review.issueId = aliases.get(alias);
    }
  }
  for (const field of ['issues','matchIssues']) {
    const seen = [];
    state[field] = (state[field] || []).filter(issue => {
      const alias = String(issue.issueId || issue.id || '');
      if (aliases.has(alias)) issue.issueId = aliases.get(alias);
      const idAlias = String(issue.id || '');
      if (aliases.has(idAlias)) issue.id = aliases.get(idAlias);
      if (seen.some(item => sameCaptionMismatchOccurrence(item,issue))) return false;
      seen.push(issue);
      return !issue.id || !droppedReviewIds.has(String(issue.id));
    });
  }
}

// A fixed hover card stays readable even for clips narrower than a word.
let reviewHoverCard;
function hideReviewHoverCard() { if (reviewHoverCard) reviewHoverCard.hidden = true; }
function showReviewHoverCard(event) {
  const clip = event.target.closest?.('.clip[data-type="review"]');
  const token=event.target.closest?.('[data-meaning-word]');
  const caption=token && state.captions.find(c=>c.id===token.closest('.clip')?.dataset.id);
  const review = (clip && state.reviewCaptions.find(item => item.id === clip.dataset.id)) || caption?.words?.[Number(token?.dataset.meaningWord)]?.meaningReview;
  if (!review) { hideReviewHoverCard(); return; }
  if (!reviewHoverCard) {
    reviewHoverCard = document.createElement('div');
    reviewHoverCard.className = 'review-hover-card';
    reviewHoverCard.setAttribute('role', 'tooltip');
    document.body.appendChild(reviewHoverCard);
  }
  reviewHoverCard.dataset.reviewId = review.id;
  reviewHoverCard.textContent = reviewClipTitle(review);
  reviewHoverCard.hidden = false;
  const bounds = reviewHoverCard.getBoundingClientRect();
  reviewHoverCard.style.left = `${Math.max(8, Math.min(event.clientX + 12, window.innerWidth - bounds.width - 8))}px`;
  reviewHoverCard.style.top = `${Math.max(8, event.clientY - bounds.height - 12)}px`;
}
$("timelineContent").addEventListener('pointermove', showReviewHoverCard);
$("timelineContent").addEventListener('pointerleave', hideReviewHoverCard);
$("timelineContent").addEventListener('pointerdown', hideReviewHoverCard);
$("timelineScroll").addEventListener('scroll', hideReviewHoverCard);

let reviewDetailsDialog = null;
function reviewCutCaptionConflict(review, start, end) {
  const candidates = [];
  for (const caption of state.captions || []) {
    if (review.captionTrackId && caption.trackId && caption.trackId !== review.captionTrackId) continue;
    if (review.ownerClipId && caption.ownerClipId && caption.ownerClipId !== review.ownerClipId) continue;
    if (review.sourceMediaId && caption.sourceMediaId && caption.sourceMediaId !== review.sourceMediaId) continue;
    const words = caption.words?.length ? caption.words : [{
      display: caption.text, start: caption.start, end: caption.end,
      issueType: caption.issueType, matchType: caption.matchType,
    }];
    for (const word of words) {
      if (word.issueType === 'addition' || word.issueType === 'extra' || word.matchType === 'spoken_addition') continue;
      const wordStart = Number(word.start), wordEnd = Number(word.end);
      if (Number.isFinite(wordStart) && Number.isFinite(wordEnd) && wordStart < end - .004 && wordEnd > start + .004)
        candidates.push(word);
    }
  }
  return candidates[0] || null;
}
function buildUnverifiedCutControls(review) {
  const panel = document.createElement('div');
  panel.className = 'review-extra-cut-controls';
  panel.hidden = true;
  const note = document.createElement('p');
  note.className = 'small';
  note.textContent = '剪切边界按识别时间预填；试听剪后效果，必要时微调，再确认剪掉。';
  const range = document.createElement('div');
  range.className = 'review-extra-cut-range';
  const makeTimeInput = (labelText, value) => {
    const label = document.createElement('label');
    label.className = 'small';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.max = String(Number(state.duration || 0));
    input.step = '0.01'; input.value = Number(value || 0).toFixed(2);
    input.setAttribute('aria-label', labelText);
    label.appendChild(input);
    range.appendChild(label);
    return input;
  };
  const startInput = makeTimeInput('开始（秒）', review.start);
  const endInput = makeTimeInput('结束（秒）', review.end);
  const status = document.createElement('p');
  status.className = 'small review-extra-cut-status';
  const actions = document.createElement('div');
  actions.className = 'review-details-actions';
  const preview = document.createElement('button');
  preview.className = 'btn small'; preview.textContent = '试听剪后';
  preview.classList.add('review-extra-cut-preview');
  preview.type = 'button';
  const commit = document.createElement('button');
  commit.className = 'btn small primary'; commit.textContent = '确认剪掉';
  commit.type = 'button';
  const back = document.createElement('button');
  back.className = 'btn small'; back.textContent = '返回'; back.type = 'button';
  const readRange = () => ({ start: Number(startInput.value), end: Number(endInput.value) });
  const validate = () => {
    const { start, end } = readRange();
    const conflict = reviewCutCaptionConflict(review, start, end);
    const rangeValid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start + .02 && end <= Number(state.duration || 0);
    const previewable = rangeValid && typeof reviewCutAudioTarget === 'function' && !!reviewCutAudioTarget(review, start, end);
    const valid = rangeValid && !conflict && previewable;
    status.classList.toggle('warning', !!conflict);
    status.textContent = conflict
      ? `剪切范围碰到正文字幕“${String(conflict.display || conflict.text || '').trim()}”；请调整边界，避免删掉正文。`
      : !rangeValid ? '请检查开始和结束时间。'
      : !previewable ? '无法定位这段口语的原始音频，暂时不能安全试听和剪切。'
      : '边界可用；剪掉前请试听拼接效果。';
    commit.disabled = !valid;
    preview.disabled = !valid;
    if (typeof stopReviewCutPreview === 'function') stopReviewCutPreview(preview);
    return valid;
  };
  startInput.addEventListener('input', validate);
  endInput.addEventListener('input', validate);
  preview.addEventListener('click', () => {
    if (preview.dataset.active === 'true') { stopReviewCutPreview(preview); return; }
    if (!validate()) return;
    const { start, end } = readRange();
    void auditionReviewCutPreview(review, start, end, preview);
  });
  commit.addEventListener('click', () => {
    if (!validate()) return;
    if (isTrackLocked('review')) return toast('待处理轨道已锁定，无法剪除这段口语');
    const { start, end } = readRange();
    stopReviewCutPreview(preview);
    reviewDetailsDialog.close();
    cutScriptIssue(review.issueId || review.id, { scope: { ...review, start, end } });
  });
  back.addEventListener('click', () => { stopReviewCutPreview(preview); panel.hidden = true; });
  actions.append(preview, commit, back);
  panel.append(note, range, status, actions);
  validate();
  return panel;
}
function buildMissingCaptionControls(review) {
  const panel = document.createElement('div');
  panel.className = 'review-extra-cut-controls review-missing-caption-controls';
  panel.hidden = true;
  const note = document.createElement('p');
  note.className = 'small';
  note.textContent = '先试听附近音频。只有确认录音里确实说了这段文案时，才手动补入字幕；请按实际发音调整时间。';
  const textLabel = document.createElement('label');
  textLabel.className = 'small';
  textLabel.textContent = '要补入的字幕';
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.value = String(review.expectedText || review.expected || '').trim();
  textInput.setAttribute('aria-label', '要补入的字幕');
  textLabel.appendChild(textInput);
  const range = document.createElement('div');
  range.className = 'review-extra-cut-range';
  const duration = Math.max(0, Number(state.duration || 0));
  const startValue = Math.min(duration, Math.max(0, Number(review.start ?? state.currentTime ?? 0)));
  const initialTokens = editableCaptionTokens(textInput.value);
  const estimatedLength = Math.max(.3, Math.min(1.8, initialTokens.length * .3));
  const endValue = Math.min(duration, Math.max(Number(review.end || startValue), startValue + estimatedLength));
  const makeTimeInput = (labelText, value) => {
    const label = document.createElement('label');
    label.className = 'small';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.max = String(duration);
    input.step = '0.01'; input.value = Number(value || 0).toFixed(2);
    input.setAttribute('aria-label', labelText);
    label.appendChild(input);
    range.appendChild(label);
    return input;
  };
  const startInput = makeTimeInput('开始时间（秒）', startValue);
  const endInput = makeTimeInput('结束时间（秒）', endValue);
  const status = document.createElement('p');
  status.className = 'small review-extra-cut-status';
  const actions = document.createElement('div');
  actions.className = 'review-details-actions';
  const preview = document.createElement('button');
  preview.className = 'btn small review-extra-cut-preview';
  preview.textContent = '试听所选范围';
  preview.type = 'button';
  const insert = document.createElement('button');
  insert.className = 'btn small primary';
  insert.textContent = '确认有词，补入字幕';
  insert.type = 'button';
  const cancel = document.createElement('button');
  cancel.className = 'btn small';
  cancel.textContent = '返回';
  cancel.type = 'button';
  const readRange = () => ({ start: Number(startInput.value), end: Number(endInput.value) });
  const hasCaptionOverlap = (start, end) => (state.captions || []).some(caption => {
    if ((caption.trackId || 'caption') !== (review.captionTrackId || 'caption')) return false;
    const words = caption.words?.length ? caption.words : [{ start: caption.start, end: caption.end }];
    return words.some(word => Number(word.start) < end - .005 && Number(word.end) > start + .005);
  });
  const validate = () => {
    const { start, end } = readRange();
    const tokens = editableCaptionTokens(textInput.value);
    const rangeValid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start + .02 && end <= duration;
    const overlap = rangeValid && hasCaptionOverlap(start, end);
    const locked = isTrackLocked(review.captionTrackId || 'caption') || isTrackLocked('review');
    status.classList.toggle('warning', !!overlap || locked);
    status.textContent = !tokens.length ? '请填写要补入的文案。'
      : !rangeValid ? '请检查开始和结束时间。'
      : overlap ? '所选时间与已有字幕重叠；请试听并调整时间范围。'
      : locked ? '字幕或待确认轨道已锁定。'
      : '只有确认录音中有这段口播后，才点击补入。';
    preview.disabled = !rangeValid;
    insert.disabled = !tokens.length || !rangeValid || overlap || locked;
    return { valid: !insert.disabled, start, end, tokens };
  };
  for (const input of [textInput, startInput, endInput]) input.addEventListener('input', validate);
  preview.addEventListener('click', () => {
    const { start, end } = readRange();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start)
      void auditionReviewSegment(review.id, { start, end });
  });
  insert.addEventListener('click', () => {
    const result = validate();
    if (!result.valid) return;
    snapshot();
    const issueId = review.issueId || review.id;
    const span = result.end - result.start;
    const words = result.tokens.map((display, index) => ({
      display,
      norm: String(display).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
      originalDisplay: display,
      expectedDisplay: display,
      recognizedDisplay: display,
      start: result.start + span * index / result.tokens.length,
      end: result.start + span * (index + 1) / result.tokens.length,
      matchType: 'edited',
      issueType: '', issueId: '', action: '',
      userKept: true, userInserted: true, manuallyConfirmedSpoken: true,
    }));
    const caption = {
      id: uid(), start: result.start, end: result.end,
      text: joinCaptionWords(words), words,
      trackId: review.captionTrackId || 'caption',
      ownerClipId: review.ownerClipId, ownerClipType: review.ownerClipType,
      sourceMediaId: review.sourceMediaId, transcriptId: review.transcriptId || '',
    };
    state.captions ||= [];
    state.captions.push(caption);
    state.captions.sort((left, right) => left.start - right.start);
    state.reviewCaptions = (state.reviewCaptions || []).filter(item => item.id !== review.id && (item.issueId || item.id) !== issueId);
    state.issues = (state.issues || []).filter(item => item.id !== issueId);
    state.matchIssues = (state.matchIssues || []).filter(item => item.id !== issueId);
    state.selected = { type: 'caption', id: caption.id };
    state.selectedItems = [state.selected];
    reviewDetailsDialog.close();
    seekTimeline(result.start);
    renderAll();
    queueAutosave();
    toast('已按你的选择补入字幕；音频未改动');
  });
  cancel.addEventListener('click', () => { panel.hidden = true; });
  actions.append(preview, insert, cancel);
  panel.append(note, textLabel, range, status, actions);
  validate();
  return panel;
}
function insertMissingReviewCaption(review) {
  const text = String(review.expectedText || review.expected || '').trim();
  const tokens = editableCaptionTokens(text);
  if (!tokens.length) return toast('没有可补入的正确文案');
  const duration = Math.max(0, Number(state.duration || review.end || 0));
  const start = Math.min(duration, Math.max(0, Number(review.start || 0)));
  let end = Math.min(duration, Math.max(start, Number(review.end || start)));
  if (end <= start + .02) end = Math.min(duration, start + Math.max(.12, tokens.length * .18));
  if (end <= start + .02) return toast('识别位置无效，无法补入字幕');
  if (isTrackLocked(review.captionTrackId || 'caption') || isTrackLocked('review'))
    return toast('字幕或待处理轨道已锁定');

  snapshot();
  const span = end - start;
  const words = tokens.map((display, index) => ({
    display,
    norm: String(display).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
    originalDisplay: display,
    expectedDisplay: display,
    recognizedDisplay: display,
    start: start + span * index / tokens.length,
    end: start + span * (index + 1) / tokens.length,
    matchType: 'edited', issueType: '', issueId: '', action: '',
    userKept: true, userInserted: true, manuallyConfirmedSpoken: true,
  }));
  state.captions ||= [];
  const trackId = review.captionTrackId || 'caption';
  const target = state.captions.find(caption =>
    (caption.trackId || 'caption') === trackId &&
    (!review.ownerClipId || !caption.ownerClipId || caption.ownerClipId === review.ownerClipId) &&
    Number(caption.start) < end && Number(caption.end) > start);
  let caption;
  if (target) {
    if (!target.words?.length) {
      const targetStart = Number(target.start || 0);
      const targetEnd = Math.max(targetStart + .04, Number(target.end || targetStart + .04));
      target.words = editableCaptionTokens(target.text || '').map((display, index, all) => ({
        display,
        start: targetStart + (targetEnd - targetStart) * index / Math.max(1, all.length),
        end: targetStart + (targetEnd - targetStart) * (index + 1) / Math.max(1, all.length),
      }));
    }
    target.words.push(...words);
    target.words.sort((left, right) => Number(left.start) - Number(right.start) || Number(left.end) - Number(right.end));
    target.start = Math.min(Number(target.start || start), start);
    target.end = Math.max(Number(target.end || end), end);
    target.text = joinCaptionWords(target.words);
    caption = target;
  } else {
    caption = {
      id: uid(), start, end, text: joinCaptionWords(words), words, trackId,
      ownerClipId: review.ownerClipId, ownerClipType: review.ownerClipType,
      sourceMediaId: review.sourceMediaId, transcriptId: review.transcriptId || '',
    };
    state.captions.push(caption);
  }
  state.captions.sort((left, right) => left.start - right.start);
  const issueId = review.issueId || review.id;
  state.reviewCaptions = state.reviewCaptions.filter(item => item.id !== review.id && (item.issueId || item.id) !== issueId);
  state.issues = (state.issues || []).filter(item => item.id !== issueId);
  state.matchIssues = (state.matchIssues || []).filter(item => item.id !== issueId);
  state.selected = { type: 'caption', id: caption.id };
  state.selectedItems = [state.selected];
  reviewDetailsDialog.close();
  seekTimeline(start);
  renderAll();
  queueAutosave();
  toast('已按识别位置补入字幕；音频未改动');
}
function showReviewDetails(id) {
  const review = state.reviewCaptions.find(r => r.id === id || r.issueId === id);
  if (!review) return;
  stopReviewCutPreview();
  hideReviewHoverCard();
  if (!reviewDetailsDialog) {
    reviewDetailsDialog = document.createElement('dialog');
    reviewDetailsDialog.className = 'review-details-dialog';
    reviewDetailsDialog.setAttribute('aria-label', '字幕差异详情');
    let pressedOutside = false;
    const outside = event => {
      const bounds = reviewDetailsDialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    reviewDetailsDialog.addEventListener('pointerdown', event => { pressedOutside = event.target === reviewDetailsDialog && outside(event); });
    reviewDetailsDialog.addEventListener('click', event => {
      if (pressedOutside && event.target === reviewDetailsDialog && outside(event)) reviewDetailsDialog.close();
      pressedOutside = false;
    });
    reviewDetailsDialog.addEventListener('close', () => stopReviewCutPreview());
    document.body.appendChild(reviewDetailsDialog);
  }
  reviewDetailsDialog.reviewId = review.id;
  reviewDetailsDialog.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = reviewClipTitle(review).split('\n')[0];
  const detail = document.createElement('p');
  detail.className = 'review-details-text';
  detail.textContent = reviewClipDetails(review);
  const actions = document.createElement('div');
  actions.className = 'review-details-actions';
  const button = (label, action, danger = false, title = '') => {
    const element = document.createElement('button');
    element.className = 'btn small' + (danger ? ' danger' : ''); element.textContent = label;
    if (title) element.title = title;
    element.onclick = action; actions.appendChild(element); return element;
  };
  const ordered=[], orderedIssueIds=new Set();
  for (const item of state.reviewCaptions.filter(r=>['mismatch','repeat','missing','unverifiedAddition'].includes(r.type)).sort((a,b)=>a.start-b.start)) {
    const issueId=String(item.issueId||item.id||'');
    if (!issueId || orderedIssueIds.has(issueId)) continue;
    orderedIssueIds.add(issueId); ordered.push(item);
  }
  const position=ordered.findIndex(r=>String(r.issueId||r.id)===String(review.issueId||review.id));
  if(position>0)button('上一处',()=>showReviewDetails(ordered[position-1].id));
  if(position>=0 && position<ordered.length-1)button('下一处',()=>showReviewDetails(ordered[position+1].id));
  const missingSpeech = review.type === 'missing' || review.action === 'missing';
  const unverifiedAddition = review.type === 'unverifiedAddition' || review.unverifiedAddition;
  const repeatedSpeech = review.type === 'repeat';
  const audition = () => {
    stopReviewCutPreview();
    reviewDetailsDialog.close();
    auditionReviewSegment(review.id);
  };
  const keepRecognized = () => {
    if (review.type === 'mismatch') {
      if (replaceReviewCaption(review.id, 'spoken')) reviewDetailsDialog.close();
      return;
    }
    stopReviewCutPreview();
    reviewDetailsDialog.close();
    acceptReviewSegment(review.id);
  };
  const deleteSpokenSegment = () => {
    if (isTrackLocked('review') || isTrackLocked(review.captionTrackId || 'caption'))
      return toast('字幕或待处理轨道已锁定，无法删除这段');
    if (unverifiedAddition) {
      const conflict = reviewCutCaptionConflict(review, Number(review.start), Number(review.end));
      if (conflict) return toast(`删除范围碰到正文字幕“${String(conflict.display || conflict.text || '').trim()}”；已取消操作以保护正文`);
    }
    stopReviewCutPreview();
    reviewDetailsDialog.close();
    if (repeatedSpeech) deleteRepeatedReview(review.id);
    else cutScriptIssue(review.issueId || review.id, { scope: review });
  };
  button('试听', audition);
  if (missingSpeech) {
    button('音频有词，补入字幕', () => insertMissingReviewCaption(review));
    button(review.confirmedMissing ? '已确认录音缺读' : '确认录音确实未读', () => {
      if (isTrackLocked('review')) return toast('待确认轨道已锁定');
      snapshot();
      review.confirmedMissing = true;
      review.needsAudioReview = false;
      review.reason = '已确认录音未读出这段文案。';
      const issueId = review.issueId || review.id;
      for (const item of [...(state.issues || []), ...(state.matchIssues || [])]) {
        if (item.id === issueId || item.issueId === issueId) {
          item.confirmedMissing = true;
          item.needsAudioReview = false;
          item.reason = review.reason;
        }
      }
      reviewDetailsDialog.close();
      renderAll(); queueAutosave(); toast('已确认确实缺读，紫色标记保留；可随时删除提示');
    });
  } else {
    if (review.type === 'mismatch') button('使用正确文案', () => { if(replaceReviewCaption(review.id,'expected')) reviewDetailsDialog.close(); });
    button('使用识别文案', keepRecognized);
    if (unverifiedAddition || repeatedSpeech)
      button('删除', deleteSpokenSegment, true, '删除对应字幕，并同步剪掉对应视频和音频');
  }
  button('忽略提示', () => { reviewDetailsDialog.close(); dismissReviewHints([review.id]); });
  button('关闭', () => reviewDetailsDialog.close());
  reviewDetailsDialog.append(heading, detail, actions);
  if (!reviewDetailsDialog.open) reviewDetailsDialog.showModal();
}

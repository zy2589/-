function isTime(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function reviewCaptionScopeMatches(review, caption) {
  const trackId = caption.trackId || 'caption';
  if (review.captionTrackId && review.captionTrackId !== trackId) return false;
  if (review.ownerClipId && review.ownerClipId !== (caption.ownerClipId || '')) return false;
  if (review.sourceMediaId && review.sourceMediaId !== (caption.sourceMediaId || '')) return false;
  return true;
}

function reviewWordTargets(review) {
  const issueId = String(review.issueId || review.id || '');
  return (Array.isArray(review.words) ? review.words : []).filter(word => {
    const start = Number(word?.start), end = Number(word?.end);
    return (!word?.issueId || String(word.issueId) === issueId) &&
      isTime(word?.start) && isTime(word?.end) && end > start;
  });
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart) > 0.005;
}

function reviewWordOverlapsCaptionWord(target, caption, word) {
  const targetSourceStart = Number(target?.sourceStart), targetSourceEnd = Number(target?.sourceEnd);
  const wordSourceStart = Number(word?.sourceStart), wordSourceEnd = Number(word?.sourceEnd);
  if ([target?.sourceStart, target?.sourceEnd, word?.sourceStart, word?.sourceEnd].every(isTime) &&
      targetSourceEnd > targetSourceStart && wordSourceEnd > wordSourceStart &&
      (!target.sourceMediaId || !caption.sourceMediaId || target.sourceMediaId === caption.sourceMediaId))
    return rangesOverlap(targetSourceStart, targetSourceEnd, wordSourceStart, wordSourceEnd);
  return rangesOverlap(Number(target.start), Number(target.end), Number(word.start), Number(word.end));
}

function reviewWordsCoverCaption(review, caption) {
  const targets = reviewWordTargets(review);
  if (!targets.length) return true;
  const useSource = isTime(caption.sourceStart) && isTime(caption.sourceEnd) &&
    Number(caption.sourceEnd) > Number(caption.sourceStart) && targets.every(target =>
      isTime(target.sourceStart) && isTime(target.sourceEnd) &&
      Number(target.sourceEnd) > Number(target.sourceStart) &&
      (!target.sourceMediaId || !caption.sourceMediaId || target.sourceMediaId === caption.sourceMediaId));
  const start = useSource ? Number(caption.sourceStart) : Number(caption.start);
  const end = useSource ? Number(caption.sourceEnd) : Number(caption.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const intervals = targets.map(target => useSource
    ? [Number(target.sourceStart), Number(target.sourceEnd)]
    : [Number(target.start), Number(target.end)]).sort((a, b) => a[0] - b[0]);
  let coveredUntil = start;
  for (const [rangeStart, rangeEnd] of intervals) {
    if (rangeStart > coveredUntil + 0.005) return false;
    if (rangeEnd > coveredUntil) coveredUntil = rangeEnd;
    if (coveredUntil >= end - 0.005) return true;
  }
  return coveredUntil >= end - 0.005;
}

export function reviewCaptionWordMatches(review, caption, word) {
  if (!reviewCaptionScopeMatches(review, caption)) return false;
  const issueId = String(review.issueId || review.id || '');
  const wordStart = Number(word?.start), wordEnd = Number(word?.end);
  const reviewStart = Number(review.start), reviewEnd = Number(review.end);
  if (!(!!issueId && String(word?.issueId || '') === issueId &&
    isTime(word?.start) && isTime(word?.end) && wordEnd > wordStart &&
    isTime(review.start) && isTime(review.end) && reviewEnd > reviewStart &&
    wordStart < reviewEnd && wordEnd > reviewStart)) return false;
  const targets = reviewWordTargets(review);
  return !targets.length || targets.some(target => reviewWordOverlapsCaptionWord(target, caption, word));
}

export function reviewCaptionBlockOverlaps(review, caption) {
  if (!reviewCaptionScopeMatches(review, caption)) return false;
  const captionStart = Number(caption.start), captionEnd = Number(caption.end);
  const reviewStart = Number(review.start), reviewEnd = Number(review.end);
  return isTime(caption.start) && isTime(caption.end) && captionEnd > captionStart &&
    isTime(review.start) && isTime(review.end) && reviewEnd > reviewStart &&
    captionStart < reviewEnd && captionEnd > reviewStart;
}

export function reviewCaptionBlockIsCovered(review, caption, margin = 0.005) {
  if (!reviewCaptionBlockOverlaps(review, caption)) return false;
  const captionStart = Number(caption.start), captionEnd = Number(caption.end);
  const reviewStart = Number(review.start), reviewEnd = Number(review.end);
  return isTime(caption.start) && isTime(caption.end) && isTime(review.start) && isTime(review.end) &&
    captionStart >= reviewStart - margin && captionEnd <= reviewEnd + margin &&
    reviewWordsCoverCaption(review, caption);
}

export function planReviewCaptionDeletion(captions, reviews, {
  lockedTracks = {},
  joinWords = words => words.map(word => word.display || word.text || '').filter(Boolean).join(' '),
} = {}) {
  const selected = Array.isArray(reviews) ? reviews.filter(Boolean) : [];
  const result = {
    captions: [],
    removedCaptionIds: new Set(),
    removedWords: [],
    removedReviewIds: new Set(),
    removedIssueIds: new Set(),
    ambiguousCaptionIds: new Set(),
  };

  // Older projects may lack track/source ownership on a review marker. Never
  // interpret missing scope as permission to delete matching words from every
  // track or source in the same timeline interval.
  const ambiguousScopeCaptions = new Set();
  for (const review of selected) {
    const unscoped = { ...review, captionTrackId: '', ownerClipId: '', sourceMediaId: '' };
    const candidates = (Array.isArray(captions) ? captions : []).filter(caption =>
      (Array.isArray(caption.words) ? caption.words : []).some(word =>
        reviewCaptionWordMatches(unscoped, caption, word)));
    const distinct = field => new Set(candidates.map(caption => String(
      field === 'trackId' ? caption.trackId || 'caption' : caption[field] || '',
    )));
    const ambiguous = (!review.captionTrackId && distinct('trackId').size > 1) ||
      (!review.ownerClipId && distinct('ownerClipId').size > 1) ||
      (!review.sourceMediaId && distinct('sourceMediaId').size > 1);
    if (ambiguous) {
      for (const caption of candidates) ambiguousScopeCaptions.add(caption);
    }
  }

  for (const caption of Array.isArray(captions) ? captions : []) {
    if (ambiguousScopeCaptions.has(caption)) {
      result.ambiguousCaptionIds.add(caption.id);
      result.captions.push(caption);
      continue;
    }
    const trackId = caption.trackId || 'caption';
    if (lockedTracks[trackId]) {
      result.captions.push(caption);
      continue;
    }

    const words = Array.isArray(caption.words) ? caption.words : [];
    if (words.length) {
      const remaining = [];
      let changed = false;
      for (const word of words) {
        const matches = selected.filter(review => reviewCaptionWordMatches(review, caption, word));
        if (!matches.length) {
          remaining.push(word);
          continue;
        }
        changed = true;
        result.removedWords.push({ captionId: caption.id, caption, word });
        for (const review of matches) {
          result.removedReviewIds.add(review.id);
          result.removedIssueIds.add(String(review.issueId || review.id));
        }
      }
      if (!changed) {
        result.captions.push(caption);
        continue;
      }
      if (!remaining.length) {
        result.removedCaptionIds.add(caption.id);
        continue;
      }
      remaining.sort((a, b) => Number(a.start) - Number(b.start));
      const updated = { ...caption, words: remaining, text: joinWords(remaining) };
      const timedWords = remaining.filter(word => Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end)));
      if (timedWords.length) {
        updated.start = Math.min(...timedWords.map(word => Number(word.start)));
        updated.end = Math.max(...timedWords.map(word => Number(word.end)));
      }
      const sourceTimedWords = remaining.filter(word => Number.isFinite(Number(word.sourceStart)) &&
        Number.isFinite(Number(word.sourceEnd)) && Number(word.sourceEnd) > Number(word.sourceStart));
      if (sourceTimedWords.length === remaining.length) {
        updated.sourceStart = Math.min(...sourceTimedWords.map(word => Number(word.sourceStart)));
        updated.sourceEnd = Math.max(...sourceTimedWords.map(word => Number(word.sourceEnd)));
      } else {
        delete updated.sourceStart;
        delete updated.sourceEnd;
      }
      result.captions.push(updated);
      continue;
    }

    const overlapping = selected.filter(review => reviewCaptionBlockOverlaps(review, caption));
    if (!overlapping.length) {
      result.captions.push(caption);
      continue;
    }
    const covering = overlapping.filter(review => reviewCaptionBlockIsCovered(review, caption));
    if (covering.length !== overlapping.length) {
      result.ambiguousCaptionIds.add(caption.id);
      result.captions.push(caption);
      continue;
    }
    result.removedCaptionIds.add(caption.id);
    for (const review of covering) {
      result.removedReviewIds.add(review.id);
      result.removedIssueIds.add(String(review.issueId || review.id));
    }
  }

  return result;
}

export function planIssueCaptionRemoval(captions, issue, options = {}) {
  const issueId = String(issue?.issueId || issue?.id || '');
  if (!issueId) return { blocked: true, reason: 'missing-issue-id', deletion: null };
  const review = { ...issue, id: issue.id || issueId, issueId };
  const deletion = planReviewCaptionDeletion(captions, [review], options);
  const original = Array.isArray(captions) ? captions : [];
  const hasText = original.some(caption => (caption.words || []).length || String(caption.text || '').trim());
  const hasRemainingText = deletion.captions.some(caption =>
    (caption.words || []).length || String(caption.text || '').trim());
  const removedAny = deletion.removedWords.length > 0 || deletion.removedCaptionIds.size > 0;
  let reason = '';
  if (deletion.ambiguousCaptionIds.size) reason = 'ambiguous-scope';
  else if (hasText && !hasRemainingText) reason = 'would-remove-all-text';
  else if (hasText && !removedAny) reason = 'no-exact-caption-match';
  return { blocked: !!reason, reason, review, deletion };
}

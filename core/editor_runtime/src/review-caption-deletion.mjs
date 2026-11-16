function reviewCaptionScopeMatches(review, caption) {
  const trackId = caption.trackId || 'caption';
  if (review.captionTrackId && review.captionTrackId !== trackId) return false;
  if (review.ownerClipId && review.ownerClipId !== caption.ownerClipId) return false;
  return true;
}

export function reviewCaptionWordMatches(review, caption, word) {
  if (!reviewCaptionScopeMatches(review, caption)) return false;
  const issueId = String(review.issueId || review.id || '');
  const wordStart = Number(word?.start), wordEnd = Number(word?.end);
  const reviewStart = Number(review.start), reviewEnd = Number(review.end);
  return !!issueId && String(word?.issueId || '') === issueId &&
    Number.isFinite(wordStart) && Number.isFinite(wordEnd) && wordEnd > wordStart &&
    Number.isFinite(reviewStart) && Number.isFinite(reviewEnd) && reviewEnd > reviewStart &&
    wordStart < reviewEnd && wordEnd > reviewStart;
}

export function reviewCaptionBlockOverlaps(review, caption) {
  if (!reviewCaptionScopeMatches(review, caption)) return false;
  const captionStart = Number(caption.start), captionEnd = Number(caption.end);
  const reviewStart = Number(review.start), reviewEnd = Number(review.end);
  return Number.isFinite(captionStart) && Number.isFinite(captionEnd) && captionEnd > captionStart &&
    Number.isFinite(reviewStart) && Number.isFinite(reviewEnd) && reviewEnd > reviewStart &&
    captionStart < reviewEnd && captionEnd > reviewStart;
}

export function reviewCaptionBlockIsCovered(review, caption, margin = 0.005) {
  if (!reviewCaptionBlockOverlaps(review, caption)) return false;
  const captionStart = Number(caption.start), captionEnd = Number(caption.end);
  const reviewStart = Number(review.start), reviewEnd = Number(review.end);
  return captionStart >= reviewStart - margin && captionEnd <= reviewEnd + margin;
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

  for (const caption of Array.isArray(captions) ? captions : []) {
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

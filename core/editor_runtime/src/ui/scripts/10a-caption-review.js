// Keep every unresolved lexical difference visible on the review track,
// including older projects whose CC words did not have review clips.
function syncCaptionCorrectionReviews() {
  state.reviewCaptions ||= [];
  state.issues ||= [];
  normalizeCaptionPhraseReviews();
  dedupeCaptionMismatchReviews();
  const resolved = new Set(correctExpandedCaptionWords(state.captions));
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
    if (['addition','extra'].includes(review.type)) { resolved.add(review.issueId || review.id); return false; }
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
const meaningReviewPending = new Set();
const meaningReviewFailures = new Map();
const meaningReviewTasks = new Map();
function loadCaptionMeaning(review,event,force=false){
  if(meaningReviewTasks.has(review.id))return meaningReviewTasks.get(review.id);
  const task=fetchCaptionMeaning(review,event,force);
  meaningReviewTasks.set(review.id,task);
  task.finally(()=>meaningReviewTasks.delete(review.id));
  return task;
}
async function fetchCaptionMeaning(review, event, force = false) {
  const context = captionMeaningContext(state.captions, review);
  const contextKey = JSON.stringify({spoken:review.spokenText,expected:review.expectedText,...context});
  const requestKey = review.id + ':' + contextKey;
  if (review.meaningContextKey && review.meaningContextKey !== contextKey) {
    review.spokenZh = ''; review.expectedZh = ''; review.meaningMode = '';
  }
  if (review.type !== 'mismatch' || (review.meaningVersion === 2 && review.meaningMode === 'context' &&
      review.meaningContextKey === contextKey && review.spokenZh && review.expectedZh) || meaningReviewPending.has(review.id) ||
      (!force && Date.now()-(meaningReviewFailures.get(requestKey)||0)<60000)) return;
  const project=state.projectId;
  const spoken=review.spokenText,expected=review.expectedText;
  let meaningTimeout;
  meaningReviewPending.add(review.id);
  review.meaningReviewStatus='loading';
  try {
    const fallback=await nativeCall('captionMeaningFallback',{items:[{id:review.id,spoken,expected,...context}]});
    const definition=fallback.items?.find(i=>i.id===review.id);
    if(definition && state.projectId===project){Object.assign(review,definition,{meaningReviewStatus:'dictionary'});refreshCaptionMeaningDialog();}
    const result=await Promise.race([nativeCall('reviewCaptionMeanings',{items:[{id:review.id,spoken,expected,...context}]}),new Promise((_,reject)=>{meaningTimeout=setTimeout(()=>reject(Error('中文查询超时')),20000);})]);
    const row=result.items?.find(i=>i.id===review.id);
    if (!row) {
      meaningReviewFailures.set(requestKey,Date.now());
      if (state.projectId===project) {
        review.meaningReviewStatus=result.status==='unavailable'?'unavailable':'failed';
        if (reviewHoverCard && !reviewHoverCard.hidden) reviewHoverCard.textContent=reviewClipTitle(review);
      }
      return;
    }
    const current=state.reviewCaptions.find(r=>r.id===review.id);
    if (state.projectId!==project || !current || current.spokenText!==spoken || current.expectedText!==expected ||
        JSON.stringify(captionMeaningContext(state.captions,current))!==JSON.stringify(context)) return;
    Object.assign(current,row,{meaningReviewStatus:result.status,spokenPhrase:context.spokenPhrase,expectedPhrase:context.expectedPhrase,meaningContextKey:contextKey});
    if (row.meaningMode === 'context') meaningReviewFailures.delete(requestKey);
    else meaningReviewFailures.set(requestKey,Date.now());
    for (const issue of state.issues) if (issue.id===(current.issueId || current.id)) Object.assign(issue,row,{id:issue.id});
    for (const caption of state.captions) for (const word of caption.words || []) if (word.issueId===(current.issueId || current.id)) {
      word.meaningReview={...row,spokenText:spoken,expectedText:expected,type:'mismatch'};
      if (row.meaningImpact==='same') {word.issueType='';word.issueId='';word.action='';word.matchType='match';}
    }
    renderTimeline();renderCaptionInspector(true);renderAutoTranscript();queueAutosave();
    if (row.meaningImpact!=='same') {
      if (reviewHoverCard && !reviewHoverCard.hidden && reviewHoverCard.dataset.reviewId === current.id) reviewHoverCard.textContent=reviewClipTitle(current);
    } else hideReviewHoverCard();
  } catch {
    meaningReviewFailures.set(requestKey,Date.now());
    review.meaningReviewStatus='failed';
    if (reviewHoverCard && !reviewHoverCard.hidden && reviewHoverCard.dataset.reviewId === review.id) reviewHoverCard.textContent=reviewClipTitle(review);
  }
  finally {clearTimeout(meaningTimeout);meaningReviewPending.delete(review.id);refreshCaptionMeaningDialog();}
}
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
function showReviewDetails(id) {
  const review = state.reviewCaptions.find(r => r.id === id || r.issueId === id);
  if (!review) return;
  if (review.meaningContextKey && review.meaningContextKey !== JSON.stringify({spoken:review.spokenText,expected:review.expectedText,...captionMeaningContext(state.captions,review)})) {
    review.spokenZh = ''; review.expectedZh = ''; review.meaningMode = '';
  }
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
    document.body.appendChild(reviewDetailsDialog);
  }
  reviewDetailsDialog.reviewId = review.id;
  reviewDetailsDialog.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = reviewClipTitle(review).split('\n')[0];
  const detail = document.createElement('p');
  detail.className = 'review-details-text';
  if (review.type === 'mismatch') Object.assign(review, captionMeaningContext(state.captions, review));
  detail.textContent = reviewClipDetails(review);
  const actions = document.createElement('div');
  actions.className = 'review-details-actions';
  const button = (label, action) => {
    const element = document.createElement('button');
    element.className = 'btn small'; element.textContent = label;
    element.onclick = action; actions.appendChild(element);
  };
  const ordered=state.reviewCaptions.filter(r=>['mismatch','repeat','missing'].includes(r.type)).sort((a,b)=>a.start-b.start);
  const position=ordered.findIndex(r=>r.id===review.id);
  if(position>0)button('上一处',()=>showReviewDetails(ordered[position-1].id));
  if(position>=0 && position<ordered.length-1)button('下一处',()=>showReviewDetails(ordered[position+1].id));
  if(review.type==='mismatch')button('重试中文',()=>loadCaptionMeaning(review,null,true));
  button('试听', () => { reviewDetailsDialog.close(); auditionReviewSegment(review.id); });
  if (review.type === 'mismatch') button('使用正确文案', () => { if(replaceReviewCaption(review.id,'expected')) reviewDetailsDialog.close(); });
  if (review.type !== 'missing' && review.action !== 'missing')
    button('使用识别文案', () => { if(replaceReviewCaption(review.id,'spoken')) reviewDetailsDialog.close(); });
  button('忽略提示', () => { reviewDetailsDialog.close(); snapshot(); dismissReviewHints([review.id]); });
  button('关闭', () => reviewDetailsDialog.close());
  reviewDetailsDialog.append(heading, detail, actions);
  if (!reviewDetailsDialog.open) reviewDetailsDialog.showModal();
  if (review.type === 'mismatch') {
    Promise.resolve(loadCaptionMeaning(review)).then(() => {
      if (reviewDetailsDialog.open && detail.isConnected) detail.textContent = reviewClipDetails(review);
    });
  }
}

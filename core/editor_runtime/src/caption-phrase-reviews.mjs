// Repair word-level hints that each inherited the same multi-word manuscript phrase.
// Distinct occurrences, tracks, owners, and manually edited words stay separate.
export function mergeCaptionPhraseReviews(captions, reviews) {
  const result = [...reviews];
  const aliases = new Map();
  const key = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}' ]/gu,'').replace(/\s+/g,' ').trim();
  const tokens = value => key(value).split(' ').filter(Boolean);
  const wordEntries = review => captions.filter(c =>
    (!review.captionTrackId || c.trackId === review.captionTrackId) &&
    (!review.ownerClipId || c.ownerClipId === review.ownerClipId)).flatMap(c => (c.words || []).map(word => ({caption:c,word})))
    .filter(({word}) => word.issueId === (review.issueId || review.id) && word.start < review.end && word.end > review.start);
  for (const review of result.filter(r=>r.type==='mismatch' && /^[A-Z]{2,8}[.]?$/.test(r.expectedText || ''))) {
    const letters=String(review.expectedText).replace(/\./g,'').toLowerCase();
    const entries=captions.filter(c=>(!review.ownerClipId || c.ownerClipId===review.ownerClipId) && (!review.captionTrackId || (c.trackId||'caption')===review.captionTrackId)).flatMap(c=>(c.words||[]).map(word=>({caption:c,word}))).sort((a,b)=>a.word.start-b.word.start);
    const end=entries.findIndex(e=>e.word.issueId===(review.issueId||review.id) && e.word.end>=review.end-.02);
    if(end<0)continue;
    const group=entries.slice(Math.max(0,end-letters.length+1),end+1);
    if(group.length!==letters.length || group.some((e,i)=>! /^[a-z][.]?$/i.test(e.word.recognizedDisplay||e.word.originalDisplay||e.word.display||'') || e.word.userKept || e.word.reviewDismissed || i && e.word.start-group[i-1].word.end>.4))continue;
    const spoken=group.map(e=>(e.word.recognizedDisplay||e.word.originalDisplay||e.word.display).replace(/\./g,'').toLowerCase()).join('');
    if(spoken.slice(0,-1)!==letters.slice(0,-1))continue;
    for(const {word} of group){word.issueId=review.issueId||review.id;word.acronymReviewId=word.issueId;word.issueType='mismatch';word.referenceExpected=review.expectedText;word.expectedDisplay=review.expectedText;}
    Object.assign(review,{start:group[0].word.start,end:group.at(-1).word.end,sourceStart:group[0].word.sourceStart,sourceEnd:group.at(-1).word.sourceEnd,spokenText:group.map(e=>e.word.recognizedDisplay||e.word.originalDisplay||e.word.display).join(' '),captionCorrectionReview:true});
  }
  const sorted = result.filter(r => r.type === 'mismatch').sort((a,b)=>a.start-b.start);
  for (let i=0;i<sorted.length;i++) {
    const first=sorted[i]; if (!result.includes(first)) continue;
    const target=key(first.expectedText); const expected=tokens(target);
    if (expected.length < 2) continue;
    let members=wordEntries(first);
    if (!members.length) continue;
    for(let j=i+1;j<sorted.length;j++) {
      const next=sorted[j]; if(!result.includes(next)) continue;
      if (next.start-first.end > .12) break;
      if (next.start < first.start || key(next.expectedText)!==target ||
          next.ownerClipId!==first.ownerClipId || next.captionTrackId!==first.captionTrackId ||
          next.transcriptId!==first.transcriptId || next.sourceMediaId!==first.sourceMediaId) continue;
      const candidate=wordEntries(next), joined=[...new Map([...members,...candidate].map(e=>[e.word,e])).values()].sort((a,b)=>a.word.start-b.word.start);
      if (!candidate.length || joined.some(({word})=>word.userKept || word.reviewDismissed || word.matchType==='edited' ||
          key(word.referenceExpected || word.expectedDisplay)!==target || tokens(word.recognizedDisplay || word.originalDisplay || word.display).length>=expected.length)) continue;
      if (joined.reduce((n,{word})=>n+tokens(word.recognizedDisplay || word.originalDisplay || word.display).length,0)>expected.length+1) continue;
      const canonical=first.issueId || first.id, old=next.issueId || next.id;
      aliases.set(old,canonical);
      for(const {word} of joined) word.issueId=canonical;
      first.end=Math.max(first.end,next.end);
      first.start=Math.min(first.start,next.start);
      if(Number.isFinite(next.sourceEnd)) first.sourceEnd=next.sourceEnd;
      first.spokenText=joined.map(({word})=>word.recognizedDisplay || word.originalDisplay || word.display).join(' ');
      first.words=joined.map(({word})=>({...word}));
      first.captionCorrectionReview=true;
      delete first.spokenZh; delete first.expectedZh; delete first.meaningImpact;
      result.splice(result.indexOf(next),1);members=joined;
    }
  }
  return {reviews:result,aliases};
}

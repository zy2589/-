import {displayWords,normalizeWord} from './engine.mjs';

// Re-listen without reference text: repeated speech can be omitted by ASR even
// when every manuscript word already has a match. Never fill gaps from text.
export async function recoverUntranscribedGaps({segments,duration,transcribe,sourceClips,maxChecks=12}) {
  if(typeof transcribe!=='function')return segments;
  const original=segments.map(s=>({...s})).sort((a,b)=>a.start-b.start),result=original.map(s=>({...s}));
  let checks=0,changed=false;
  for(let i=1;i<original.length;i++) {
    const left=original[i-1],right=original[i];
    if(right.start-left.end<1.2 || right.start-left.end>12)continue;
    if(Array.isArray(sourceClips) && !sourceClips.some(c=>c.sourceStart<right.start && c.sourceEnd>left.end))continue;
    if(checks++>=maxChecks)break;
    const from=Math.max(0,left.end-.6),to=Math.min(duration,right.end+.3);
    let heard;try{heard=await transcribe(from,to-from);}catch(error){
      if(error?.name==='AbortError'||error?.message==='cancelled')throw error;
      continue;
    }
    const fresh=(Array.isArray(heard)?heard:[]).filter(s=>s && displayWords(s.text).length===1 && !s.recoveredFromManuscript &&
      Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.start>=0&&s.end<=to-from+.001&&s.end>s.start+.02)
      .map(s=>({...s,start:s.start+from,end:s.end+from,audioVerified:true}))
      .filter(s=>(s.start+s.end)/2>=Math.max(left.start+.04,left.end-.3) && (s.start+s.end)/2<right.start+.05)
      .sort((a,b)=>a.start-b.start||a.end-b.end);
    for(const word of fresh) {
      const overlaps=result.filter(s=>s.start<word.end && s.end>word.start);
      if(overlaps.some(s=>normalizeWord(s.text)===normalizeWord(word.text)))continue;
      // Only the two boundary words may have overestimated timestamps. Preserve
      // their text, shortening a boundary only when enough of it still remains.
      if(overlaps.some(s=>!(s.start===left.start || s.start===right.start) ||
        !(s.start<word.start && word.start-s.start>=.04 || s.end>word.end && s.end-word.end>=.04)))continue;
      for(const s of overlaps){if(s.start<word.start)s.end=word.start;else s.start=word.end;}
      result.push(word);changed=true;
    }
  }
  return changed?result.sort((a,b)=>a.start-b.start||a.end-b.end):segments;
}

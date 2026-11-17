import {displayWords,normalizeWord} from './engine.mjs';

// Re-listen without reference text: repeated speech can be omitted by ASR even
// when every manuscript word already has a match. Never fill gaps from text.
export async function recoverUntranscribedGaps({segments,duration,transcribe,sourceClips,maxChecks=24}) {
  if(typeof transcribe!=='function')return segments;
  const original=segments.map(s=>({...s})).sort((a,b)=>a.start-b.start),result=original.map(s=>({...s}));
  const gaps=[];
  for(let i=1;i<original.length;i++) {
    const left=original[i-1],right=original[i],gap=right.start-left.end;
    if(gap<1.2)continue;
    if(Array.isArray(sourceClips) && !sourceClips.some(c=>c.sourceStart<right.start && c.sourceEnd>left.end))continue;
    gaps.push({left,right,gap});
  }
  // Recover the longest omissions first so short pauses cannot consume the
  // request budget before a genuinely missing speech passage is checked.
  gaps.sort((a,b)=>b.gap-a.gap || a.left.start-b.left.start);
  let checks=0,changed=false;
  const probeSeconds=11.5,probeOverlap=.8;
  for(const {left,right} of gaps) {
    const from=Math.max(0,left.end-.6),to=Math.min(duration,right.start+.3);
    if(to<=from)continue;
    const probes=[];
    if(to-from<=probeSeconds)probes.push({start:from,end:to});
    else {
      const stride=probeSeconds-probeOverlap;
      for(let start=from;start<to;start+=stride)
        probes.push({start,end:Math.min(to,start+probeSeconds)});
    }
    for(const probe of probes) {
      if(checks>=maxChecks)break;
      checks++;
      const length=probe.end-probe.start;
      let heard;try{heard=await transcribe(probe.start,length);}catch(error){
        if(error?.name==='AbortError'||error?.message==='cancelled')throw error;
        continue;
      }
      const fresh=(Array.isArray(heard)?heard:[]).filter(s=>s && displayWords(s.text).length===1 && !s.recoveredFromManuscript &&
        Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.start>=0&&s.start<length&&s.end>s.start+.02)
        .map(s=>({...s,start:s.start+probe.start,end:Math.min(length,s.end)+probe.start,audioVerified:true}))
        .filter(s=>(s.start+s.end)/2>=Math.max(left.start+.04,left.end-.3) && (s.start+s.end)/2<right.start+.05)
        .sort((a,b)=>a.start-b.start||a.end-b.end);
      for(const word of fresh) {
        const norm=normalizeWord(word.text);
        const nearDuplicate=result.some(s=>normalizeWord(s.text)===norm && Math.abs((s.start+s.end-word.start-word.end)/2)<.35);
        if(nearDuplicate)continue;
        const overlaps=result.filter(s=>s.start<word.end && s.end>word.start);
        if(overlaps.some(s=>normalizeWord(s.text)===norm))continue;
        // Only the two boundary words may have overestimated timestamps. Preserve
        // their text, shortening a boundary only when enough of it still remains.
        if(overlaps.some(s=>!(s.start===left.start || s.start===right.start) ||
          !(s.start<word.start && word.start-s.start>=.04 || s.end>word.end && s.end-word.end>=.04)))continue;
        for(const s of overlaps){if(s.start<word.start)s.end=word.start;else s.start=word.end;}
        result.push(word);changed=true;
      }
    }
  }
  return changed?result.sort((a,b)=>a.start-b.start||a.end-b.end):segments;
}

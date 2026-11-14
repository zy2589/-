import {displayWords, normalizeWord} from './engine.mjs';

// Sentence spans are not word timestamps. Re-listen to the actual sentence,
// without the manuscript prompt. Keep the original recognized sentence if the
// selected engine only returns coarse timing or the verification call fails.
export async function refineSentenceTimings(segments, {duration, transcribe}) {
  const result=[];
  for (const segment of segments) {
    const tokens=displayWords(segment.text);
    if(tokens.length<=1){result.push({...segment});continue;}
    const start=Math.max(0,Number(segment.start)-.25);
    const end=Math.min(duration,Number(segment.end)+.25);
    let heard=[];
    try { heard=await transcribe(start,end-start); }
    catch(error) {
      if(error?.name==='AbortError'||error?.message==='cancelled')throw error;
      result.push({...segment,timingReliable:'sentence',timingVerificationError:String(error?.message||error)});
      continue;
    }
    const words=(heard||[]).filter(w=>displayWords(w.text).length===1 && Number.isFinite(w.start) && Number.isFinite(w.end) && w.start>=0 && w.end>w.start && w.end<=end-start+.001)
      .map(w=>({...w,start:w.start+start,end:w.end+start}));
    const expected=tokens.map(w=>normalizeWord(w.display));
    let hit=-1;
    for(let i=0;i<=words.length-tokens.length;i++){
      if(expected.every((text,j)=>normalizeWord(words[i+j].text)===text &&
        (!j || (words[i+j].start>=words[i+j-1].start && words[i+j].end>=words[i+j-1].end))) &&
        words[i].start>=Number(segment.start)-.25 && words[i+tokens.length-1].end<=Number(segment.end)+.25){hit=i;break;}
    }
    if(hit<0){result.push({...segment,timingReliable:'sentence'});continue;}
    result.push(...words.slice(hit,hit+tokens.length).map((w,i)=>({...segment,text:tokens[i].display,start:w.start,end:w.end,timingReliable:true})));
  }
  return result;
}

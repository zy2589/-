import {displayWords,normalizeWord} from './engine.mjs';

const token=s=>displayWords(s?.text).length===1 ? normalizeWord(s.text) : '';
function closeSpelling(a,b) {
 if(a===b)return !!a;
 if(!/^[a-z]{4,}$/.test(a)||!/^[a-z]{4,}$/.test(b)||Math.abs(a.length-b.length)!==1)return false;
 return a.length>b.length?a.startsWith(b):b.startsWith(a);
}

// Never deduplicate by spelling or timestamps alone. A fresh, unprompted audio
// transcription must contain the full bounded context with exactly one copy.
export async function verifyAdjacentAsrEchoes({segments,duration,transcribe,maxChecks=12}) {
 if(typeof transcribe!=='function')return segments;
 const original=segments.map(s=>({...s})).sort((a,b)=>a.start-b.start),result=[];
 let checks=0;
 for(let i=0;i<original.length;i++) {
  const first=original[i],second=original[i+1],left=original[i-1],right=original[i+2];
  if(!left||!right||!second||!closeSpelling(token(first),token(second)) ||
    !token(left)||!token(right)||closeSpelling(token(left),token(first))||closeSpelling(token(right),token(second))||
    second.start-first.end>.18||second.start<first.start||second.end-first.start>1.6||
    first.recoveredFromManuscript||second.recoveredFromManuscript||checks>=maxChecks) {
   result.push(first);continue;
  }
  checks++;
  const from=Math.max(0,left.start-.25),to=Math.min(duration,right.end+.25);
  let heard;
  try {heard=await transcribe(from,to-from);}catch(error){
   if(error?.name==='AbortError'||error?.message==='cancelled')throw error;
   result.push(first);continue;
  }
  const fresh=(Array.isArray(heard)?heard:[]).filter(w=>token(w)&&Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.start>=0&&w.end>w.start&&w.end<=to-from+.05)
   .map(w=>({...w,start:w.start+from,end:w.end+from})).sort((a,b)=>a.start-b.start);
  // Require all three context words, in order, and no second occurrence in the
  // original pair's acoustic interval. Incomplete or disputed evidence stays raw.
  const matches=[];
  for(let k=1;k+1<fresh.length;k++)if(token(fresh[k-1])===token(left)&&token(fresh[k+1])===token(right)&&
    [token(first),token(second)].includes(token(fresh[k]))&&fresh[k].start>=first.start-.25&&fresh[k].end<=second.end+.25)matches.push(fresh[k]);
  const copies=fresh.filter(w=>closeSpelling(token(w),token(first))&&w.end>first.start-.1&&w.start<second.end+.1);
  if(matches.length!==1||copies.length!==1){result.push(first);continue;}
  const verified=matches[0];
  result.push({...first,text:verified.text,start:Math.max(left.end,verified.start),end:Math.min(right.start,verified.end),
   audioVerified:true,asrEchoVerified:true,asrEchoOriginal:[first,second]});
  if(result.at(-1).end<=result.at(-1).start){result[result.length-1]=first;continue;}
  i++;
 }
 return result;
}

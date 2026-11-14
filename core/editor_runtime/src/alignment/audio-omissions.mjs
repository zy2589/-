import {alignScript} from './engine.mjs';

// A missing ASR token is not evidence of an unread word. Recover only tokens
// heard in a fresh, unprompted audio pass between the same spoken neighbours.
export async function recoverAudioOmissions({segments,script,duration,transcribe,maxChecks=12}) {
  if (!script || typeof transcribe!=='function') return segments;
  const aligned=alignScript({segments,script,duration,recoverMissing:false});
  const words=aligned.spoken.map(w=>({...w})),operations=aligned.operations;
  let checks=0,recoveredAny=false;
  for(let i=0;i<operations.length;i++) {
    if(operations[i].type!=='missing')continue;
    const start=i;
    while(operations[i]?.type==='missing')i++;
    const run=operations.slice(start,i),left=operations[start-1],right=operations[i];
    if(run.length>2 || !left?.spoken || !right?.spoken ||
       !['match','near'].includes(left.type) || !['match','near'].includes(right.type))continue;
    if(checks++>=maxChecks)break;
    const from=Math.max(0,left.spoken.start-1.4),to=Math.min(duration,right.spoken.end+1.6);
    if(to<=from || to-from>12)continue;
    let heard;
    try {heard=await transcribe(from,to-from);} catch(error) {
      if(error?.name==='AbortError'||error?.message==='cancelled')throw error;
      continue;
    }
    const fresh=alignScript({segments:heard,script:'',duration:to-from,recoverMissing:false}).spoken;
    const wanted=[left.spoken.norm,...run.map(op=>op.expected.norm),right.spoken.norm];
    for(let j=0;j<=fresh.length-wanted.length;j++) {
      const sequence=fresh.slice(j,j+wanted.length);
      if(!sequence.every((w,k)=>w.norm===wanted[k]))continue;
      if(Math.abs(sequence[0].start+from-left.spoken.start)>1 ||
         Math.abs(sequence.at(-1).end+from-right.spoken.end)>1)continue;
      const recovered=sequence.slice(1,-1).map(w=>({...w,start:w.start+from,end:w.end+from,audioVerified:true}));
      const before=words.find(w=>w.norm===left.spoken.norm&&Math.abs(w.start-left.spoken.start)<.001);
      const after=words.find(w=>w.norm===right.spoken.norm&&Math.abs(w.end-right.spoken.end)<.001);
      if(!before||!after || recovered[0].start<before.start+.04 || recovered.at(-1).end>after.end-.04)continue;
      before.end=Math.min(before.end,recovered[0].start);
      after.start=Math.max(after.start,recovered.at(-1).end);
      words.push(...recovered);recoveredAny=true;break;
    }
  }
  if(!recoveredAny)return segments;
  return words.sort((a,b)=>a.start-b.start).map(w=>({...w,text:w.display,timebase:'seconds'}));
}

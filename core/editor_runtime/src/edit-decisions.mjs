export function editSourceClips(sourceDuration, removals = [], manualCuts = [], playbackRate = 1) {
        sourceDuration = Math.max(0, Number(sourceDuration) || 0);
        if (!Number.isFinite(sourceDuration)) return [];
        // Imported and restored decisions may overlap or arrive out of order.
        const ranges = removals.map(r => ({start: Math.max(0, Number(r?.start)), end: Math.min(sourceDuration, Number(r?.end))}))
          .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
          .sort((a,b) => a.start-b.start);
        removals = [];
        for (const range of ranges) {
          const previous = removals.at(-1);
          if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
          else removals.push({...range});
        }
        manualCuts = [...new Set(manualCuts.map(Number).filter(Number.isFinite))];
        const base = [];
        const speed = Number.isFinite(Number(playbackRate)) && Number(playbackRate) > 0 ? Math.max(0.05, Number(playbackRate)) : 1;
        let source = 0,
          timeline = 0;
        for (const r of removals) {
          if (r.start > source + 0.002) {
            base.push({
              sourceStart: source,
              sourceEnd: r.start,
              start: timeline / speed,
              end: (timeline + r.start - source) / speed,
            });
            timeline += r.start - source;
          }
          source = r.end;
        }
        if (source < sourceDuration - 0.002)
          base.push({
            sourceStart: source,
            sourceEnd: sourceDuration,
            start: timeline / speed,
            end: (timeline + sourceDuration - source) / speed,
          });
        const clips = [];
        for (const b of base) {
          const cuts = manualCuts
              .filter(
                (c) => c > b.sourceStart + 0.002 && c < b.sourceEnd - 0.002,
              )
              .sort((a, z) => a - z),
            points = [b.sourceStart, ...cuts, b.sourceEnd];
          for (let i = 0; i < points.length - 1; i++) {
            const s = points[i],
              e = points[i + 1],
              start = b.start + (s - b.sourceStart) / speed;
            clips.push({
              id: `v-${s.toFixed(4)}-${e.toFixed(4)}`,
              sourceStart: s,
              sourceEnd: e,
              start,
              end: start + (e - s) / speed,
            });
          }
        }
        return clips;
      }
// Pure editing arithmetic shared with the browser. Timeline and source clocks are distinct.
export function editRate(clip,fallback=1){
 const span=Number(clip.end)-Number(clip.start);
 const sourceSpan=Number(clip.sourceEnd)-Number(clip.sourceStart||0);
 return span>0&&sourceSpan>0 ? sourceSpan/span : Math.max(.05,Number(clip.playbackRate||fallback));
}
export function editFrame(time,fps=30){
 if (!Number.isFinite(Number(time))) throw new RangeError('Invalid edit time');
 if (!Number.isFinite(Number(fps)) || Number(fps) <= 0) throw new RangeError('Invalid frame rate');
 return Math.round(Number(time)*Number(fps))/Number(fps);
}
export function editMoveDelta(clips,delta,{fps=30,max=Infinity}={}){
 if(!clips.length)return 0;
 const minDelta=-Math.min(...clips.map(c=>Number(c.start)));
 const maxDelta=Number.isFinite(max)?max-Math.max(...clips.map(c=>Number(c.end))):Infinity;
 const lower=Math.ceil((minDelta-1e-8)*fps)/fps;
 const upper=Math.floor((maxDelta+1e-8)*fps)/fps;
 if(lower>upper)return 0;
 return Math.max(lower,Math.min(upper,editFrame(delta,fps)));
}
export function previewVideoClips(clips,time,{visible=()=>true,rate=1,lead=2}={}){
 const mapping=clip=>{const speed=editRate(clip,rate);return JSON.stringify([clip.url,clip.trackId,speed.toFixed(8),(Number(clip.sourceStart||0)-clip.start*speed).toFixed(8)]);};
 const live=[],keys=new Set(),upcoming=new Map();
 for(const clip of clips)if(visible(clip.trackId)&&time>=clip.start&&time<clip.end){live.push(clip);keys.add(mapping(clip));}
 // Keep a single discontinuous standby per track, even with dense short cuts.
 for(const clip of clips){
  if(!visible(clip.trackId)||clip.start<=time||clip.start>time+lead||keys.has(mapping(clip)))continue;
  const previous=upcoming.get(clip.trackId);
  if(!previous||clip.start<previous.start)upcoming.set(clip.trackId,clip);
 }
 return [...live,...upcoming.values()];
}
export function editHistoryDelta(before,after){
 const old={},next={};
 for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
  if(JSON.stringify(before[key])===JSON.stringify(after[key]))continue;
  old[key]=before[key]??null;next[key]=after[key]??null;
 }
 return Object.keys(old).length?JSON.parse(JSON.stringify({__historyDelta:true,before:old,after:next})):null;
}
export function editTrackEnabled(track,locks={},syncLocks={},ripple=false){return !locks[track]&&(!ripple||syncLocks[track]!==false);}
// Insert at `from`, or remove [from + delta, from]. Preserve source handles.
export function editRipple(clips,from,delta,{id=()=>crypto.randomUUID(),enabled=()=>true,excluded=new Set(),rate=1,onSplit=()=>{}}={}){
 if(Math.abs(delta)<1e-8)return clips;
 const boundary=delta<0?from+delta:from;
 const portion=(clip,start,end,newId)=>{
  const part={...clip,id:newId||clip.id,start,end};
  if(Number.isFinite(clip.sourceStart)){
   const speed=editRate(clip,rate);
   part.sourceStart=clip.sourceStart+(start-clip.start)*speed;
   part.sourceEnd=clip.sourceStart+(end-clip.start)*speed;
  }
  if(clip.words){
   part.words=clip.words.filter(w=>w.end>start&&w.start<end).map(w=>({...w,start:Math.max(start,w.start),end:Math.min(end,w.end)}));
   part.text=part.words.map(w=>w.display||w.text||'').join(' ').replace(/\s+([,.!?;:])/g,'$1');
  }
  return part;
 };
 const shift=clip=>({...clip,start:clip.start+delta,end:clip.end+delta,...(clip.words?{words:clip.words.map(w=>({...w,start:w.start+delta,end:w.end+delta}))}:{})});
 return clips.flatMap(clip=>{
  if(excluded.has(clip.id)||!enabled(clip)||clip.end<=boundary+1e-8)return [clip];
  if(clip.start>=from-1e-8)return [shift(clip)];
  const result=[];
  if(clip.start<boundary-1e-8)result.push(portion(clip,clip.start,boundary));
  if(clip.end>from+1e-8){
   const right=portion(clip,from,clip.end,result.length?id():clip.id);
   if(result.length&&right.linkGroupId)right.linkGroupId+=`:ripple:${from.toFixed(7)}`;
   if(result.length)onSplit(result[0],right);
   result.push(shift(right));
  }
  return result;
 });
}
export function editTrim(clip,edge,target,{fps=30,rate=editRate(clip),ripple=false,min=0,max=Infinity}={}){
 const result={...clip},frame=1/fps,sourceStart=Number(clip.sourceStart||0);
 const sourceEnd=sourceStart+(clip.end-clip.start)*rate;
 const duration=Number(clip.sourceDuration||clip.duration||sourceEnd);
 const lo=edge==='start'?Math.max(min,clip.start-sourceStart/rate):clip.start+frame;
 const hi=edge==='start'?clip.end-frame:Math.min(max,clip.end+(duration-sourceEnd)/rate);
 const lower=Math.ceil((lo-1e-8)*fps)/fps,upper=Math.floor((hi+1e-8)*fps)/fps;
 if(lower>upper)return {...clip,sourceStart,sourceEnd};
 const value=Math.max(lower,Math.min(upper,editFrame(target,fps)));
 if(edge==='start'){result.start=value;result.sourceStart=sourceStart+(value-clip.start)*rate;result.sourceEnd=sourceEnd;if(ripple){result.start=clip.start;result.end=clip.end-(value-clip.start);}}
 else{result.end=value;result.sourceStart=sourceStart;result.sourceEnd=sourceEnd+(value-clip.end)*rate;}
 return result;
}
export function editSlip(clip,delta,{fps=30,rate=editRate(clip)}={}){
 const span=(clip.end-clip.start)*rate,source=Number(clip.sourceStart||0);
 const change=editFrame(delta,fps)*rate;
 const start=Math.max(0,Math.min(Number(clip.sourceDuration||clip.duration||source+span)-span,source+change));
 return {...clip,sourceStart:start,sourceEnd:start+span};
}
// All linked edges move by the same timeline delta, preserving intentional J/L offsets.
export function editLinkedTrim(clips,edge,delta,{fps=30,ripple=false,bounds=[]}={}){
 let applied=editFrame(delta,fps);
 for(let index=0;index<clips.length;index++){
  const clip=clips[index],rate=editRate(clip),next=editTrim(clip,edge,clip[edge]+applied,{fps,ripple,rate,...bounds[index]});
  const available=edge==='start'?(next.sourceStart-Number(clip.sourceStart||0))/rate:next.end-clip.end;
  applied=applied>=0?Math.min(applied,available):Math.max(applied,available);
 }
 return clips.map((clip,index)=>editTrim(clip,edge,clip[edge]+applied,{fps,ripple,...bounds[index]}));
}
export function editLinkedSlip(clips,delta,{fps=30}={}){
 let applied=editFrame(delta,fps);
 for(const clip of clips){
  const next=editSlip(clip,applied,{fps}),available=(next.sourceStart-Number(clip.sourceStart||0))/editRate(clip);
  applied=applied>=0?Math.min(applied,available):Math.max(applied,available);
 }
 return clips.map(clip=>editSlip(clip,applied,{fps}));
}
export function editRoll(left,right,target,{fps=30,rateLeft=editRate(left),rateRight=editRate(right)}={}){
 if(Math.abs(left.end-right.start)>1e-7)throw Error('滚动修剪需要相邻片段');
 const old=left.end;
 const a=editTrim(left,'end',target,{fps,rate:rateLeft,max:right.end-1/fps});
 const b=editTrim(right,'start',a.end,{fps,rate:rateRight,min:left.start+1/fps});
 const end=editTrim(left,'end',b.start,{fps,rate:rateLeft,max:right.end-1/fps});
 return {left:end,right:editTrim(right,'start',end.end,{fps,rate:rateRight}),delta:end.end-old};
}
export function editSlide(left,clip,right,delta,{fps=30}={}){
 if(Math.abs(left.end-clip.start)>1e-7||Math.abs(clip.end-right.start)>1e-7)throw Error('滑动需要左右相邻片段');
 const requested=editFrame(delta,fps),a=editTrim(left,'end',left.end+requested,{fps}),b=editTrim(right,'start',right.start+requested,{fps});
 const applied=requested>=0?Math.min(a.end-left.end,b.start-right.start):Math.max(a.end-left.end,b.start-right.start);
 return {left:editTrim(left,'end',left.end+applied,{fps}),clip:{...clip,start:clip.start+applied,end:clip.end+applied},right:editTrim(right,'start',right.start+applied,{fps})};
}
export function editOverwrite(clips,start,end,{id=()=>crypto.randomUUID(),rate=1}={}){
 return clips.flatMap(clip=>{
  if(clip.end<=start||clip.start>=end)return [{...clip}];
  const output=[],speed=editRate(clip,rate),source=Number(clip.sourceStart||0);
  if(clip.start<start)output.push({...clip,end:start,sourceEnd:source+(start-clip.start)*speed});
  if(clip.end>end)output.push({...clip,id:clip.start<start?id():clip.id,linkGroupId:clip.start<start&&clip.linkGroupId?`${clip.linkGroupId}:after:${end.toFixed(7)}`:clip.linkGroupId,start:end,sourceStart:source+(end-clip.start)*speed,sourceEnd:source+(clip.end-clip.start)*speed});
  return output;
 });
}

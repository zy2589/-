function editMediaItems(){
 return [
  ...mainClips().map(obj=>({type:'video',obj,track:state.mainVideoTrackMap?.[obj.id]||'video'})),
  ...mainAudioClips().map(obj=>({type:'audio',obj,track:state.mainAudioTrackMap?.[obj.id]||'audio'})),
  ...state.videoLayers.map(obj=>({type:'videolayer',obj,track:obj.trackId||'video'})),
  ...state.audioAssets.map(obj=>({type:'audioasset',obj,track:obj.trackId||'audio'}))];
}
function editNeighborBounds(object,type){
 const track=selectionTrackId(type,object.id),others=editMediaItems().filter(x=>x.track===track&&x.obj.id!==object.id);
 return {min:Math.max(0,...others.filter(x=>x.obj.end<=object.start+1e-7).map(x=>x.obj.end)),max:Math.min(Infinity,...others.filter(x=>x.obj.start>=object.end-1e-7).map(x=>x.obj.start))};
}
function applyEditRipple(from,delta,excluded=[],targetTracks=[],{onlyTargetTracks=false}={}){
 if(Math.abs(delta)<1e-8)return;
 const skip=new Set(excluded.map(x=>x.id));
 const directTracks=new Set([...targetTracks,...excluded.map(x=>x.trackId).filter(Boolean)]);
 // Main clips keep their source references; only placed timeline offsets change.
 if (!onlyTargetTracks) materializeTimelineMedia();
 const nested=(state.compoundClips||[]).filter(g=>g.nestedTimeline);
 const nestedMembers=new Set(nested.flatMap(g=>(g.members||[]).map(x=>x.id)));
 const nextGroups=[];
 for(const group of nested){
  const enabled=group.members.every(m=>!selectionIsLocked(m.type,m.id))&&group.members.some(m=>directTracks.has(selectionTrackId(m.type,m.id))||!onlyTargetTracks&&state.trackSyncLocks?.[selectionTrackId(m.type,m.id)]!==false);
  const parts=editRipple([group],from,delta,{id:uid,enabled:()=>enabled&&!group.members.some(m=>skip.has(m.id))});
  if(!parts.length){for(const member of group.members){const list=timelineCollection(member.type);if(list){const index=list.findIndex(x=>x.id===member.id);if(index>=0)list.splice(index,1);}}}
  for(let part of parts){if(part.id!==group.id)part=cloneNestedInstance(part,uid);nextGroups.push(part);}
 }
 state.compoundClips=[...(state.compoundClips||[]).filter(g=>!g.nestedTimeline),...nextGroups];
 for(const [type,list] of [['videolayer',state.videoLayers],['audioasset',state.audioAssets],['image',state.images],['text',state.titles],['caption',state.captions],['review',state.reviewCaptions]]){
  const updated=editRipple(list||[],from,delta,{id:uid,excluded:new Set([...skip,...nestedMembers]),rate:Number(state.audio.speed||1),enabled:item=>{const track=overlayTrackId(type,item);return !isTrackLocked(track)&&(directTracks.has(track)||!onlyTargetTracks&&state.trackSyncLocks?.[track]!==false);},onSplit:type==='videolayer'?splitBoundCaptions:undefined});
  list.splice(0,list.length,...updated);
 }
 const mutes=state.audioMutes||[];
 const shiftedMutes=editRipple(mutes,from,delta,{id:uid,rate:Number(state.audio.speed||1),enabled:item=>{const track=item.trackId||'audio';return !isTrackLocked(track)&&(directTracks.has(track)||!onlyTargetTracks&&state.trackSyncLocks?.[track]!==false);}});
 mutes.splice(0,mutes.length,...shiftedMutes);
 for(const group of nextGroups)applyNestedProjection(state,group);
 if (!onlyTargetTracks) reconcileEditLinks();
}
function materializeTimelineMedia(){
 for(const clip of [...mainClips()])materializeMainSegment('video',clip.id);
 if(!state.avLinked)for(const clip of [...mainAudioClips()])materializeMainSegment('audio',clip.id);
}
function splitBoundCaptions(left,right){
 const boundary=right.start,extra=[];
 for(const caption of [...(state.captions||[]),...(state.reviewCaptions||[])]){
  if(caption.ownerClipId!==left.id||isTrackLocked(caption.trackId||'caption'))continue;
  if(caption.start>=boundary-1e-7){caption.ownerClipId=right.id;continue;}
  if(caption.end<=boundary+1e-7)continue;
  const copy=cloneClipData(caption);copy.id=uid();copy.ownerClipId=right.id;
  copy.start=boundary;caption.end=boundary;
  const source=Number(right.sourceStart||0);caption.sourceEnd=source;copy.sourceStart=source;
  if(caption.words?.length){
   const before=[],after=[];
   for(const word of caption.words){
    if(word.start<boundary)before.push({...word,end:Math.min(word.end,boundary),sourceEnd:Math.min(Number(word.sourceEnd??source),source)});
    if(word.end>boundary)after.push({...word,start:Math.max(word.start,boundary),sourceStart:Math.max(Number(word.sourceStart??source),source)});
   }
   caption.words=before;copy.words=after;caption.text=joinCaptionWords(before);copy.text=joinCaptionWords(after);
  }
  extra.push({copy,review:(state.reviewCaptions||[]).includes(caption)});
 }
 for(const {copy,review} of extra)(review?state.reviewCaptions:state.captions).push(copy);
 if(typeof syncReviewIssueTimes==='function')syncReviewIssueTimes();
}
function reconcileEditLinks(){
 for(const video of state.videoLayers)if(!isTrackLocked(video.trackId||'video'))video.linkedAudioId=video.linkGroupId?state.audioAssets.find(a=>a.linkGroupId===video.linkGroupId)?.id||'':'';
 for(const audio of state.audioAssets)if(!isTrackLocked(audio.trackId||'audio'))audio.linkedVideoId=audio.linkGroupId?state.videoLayers.find(v=>v.linkGroupId===audio.linkGroupId)?.id||'':'';
}
function overwriteEditableClips(clips,start,end){
 const result=editOverwrite(clips,start,end,{id:uid,rate:Number(state.audio.speed||1)});
 for(const original of clips){const left=result.find(x=>x.id===original.id),right=result.find(x=>x.id!==original.id&&x.start===end&&x.end===original.end&&x.path===original.path&&x.trackId===original.trackId);if(left&&right&&original.start<start&&original.end>end)splitBoundCaptions(left,right);}
 return result;
}
function cutSourceMediaPauses(removals){
 const path=state.video.path,sourceClips=editMediaItems().filter(x=>(x.type==='video'||x.type==='videolayer'&&(x.obj.path===path||x.obj.sourceMediaId===path))&&editTrackEnabled(x.track,state.trackLocks,state.trackSyncLocks,true));
 const ranges=[];
 for(const {obj} of sourceClips)for(const cut of removals){const rate=editRate(obj,Number(state.audio.speed||1)),a=Math.max(Number(obj.sourceStart||0),cut.start),b=Math.min(Number(obj.sourceEnd??(Number(obj.sourceStart||0)+(obj.end-obj.start)*rate)),cut.end);if(b>a){const start=frameAlignedTime(obj.start+(a-Number(obj.sourceStart||0))/rate),end=frameAlignedTime(obj.start+(b-Number(obj.sourceStart||0))/rate);if(end>start)ranges.push({start,end});}}
 const cuts=normalizeRemovalsList(ranges);materializeTimelineMedia();
 for(const cut of [...cuts].reverse()){
  for(const [type,list] of [['videolayer',state.videoLayers],['audioasset',state.audioAssets],['image',state.images],['text',state.titles]]){
   const enabled=list.filter(x=>editTrackEnabled(overlayTrackId(type,x),state.trackLocks,state.trackSyncLocks,true)),locked=list.filter(x=>!enabled.includes(x));
   list.splice(0,list.length,...locked,...overwriteEditableClips(enabled,cut.start,cut.end));
  }
  applyEditRipple(cut.end,cut.start-cut.end);
 }
 reconcileEditLinks();remapCaptionsFromSource(mainClips());recomputeContentDuration();renderAll();queueAutosave();
 return cuts.reduce((sum,c)=>sum+c.end-c.start,0);
}
function editPasteSpace(entries,at,mode){
 materializeTimelineMedia();
 const offset=at-timelineClipboard.start;
 if(mode==='insert'){
  const length=timelineClipboard.end-timelineClipboard.start;
  applyEditRipple(at,length);return;
 }
 for(const entry of entries){
  const list=timelineCollection(entry.type);if(!list)continue;
  const track=entry.object.trackId,start=entry.object.start+offset,end=entry.object.end+offset;
  const other=list.filter(x=>x.trackId!==track),same=list.filter(x=>x.trackId===track);
  list.splice(0,list.length,...other,...overwriteEditableClips(same,start,end));
 }
}
function moveBoundCaptions(clip,previous){
 if(!previous||selectionIsLocked('caption',''))return;
 const rate=editRate(clip,Number(state.audio.speed||1));
 for(const caption of [...state.captions,...(state.reviewCaptions||[])]){
  if(caption.ownerClipId!==clip.id||isTrackLocked(caption.trackId||'caption')||!isTrackSyncLocked(caption.trackId||'caption'))continue;
  const map=t=>clip.start+(t-Number(clip.sourceStart||0))/rate;
  if(Number.isFinite(caption.sourceStart)){caption.start=map(caption.sourceStart);caption.end=map(caption.sourceEnd);}
  for(const word of caption.words||[])if(Number.isFinite(word.sourceStart)){word.start=map(word.sourceStart);word.end=map(word.sourceEnd);}
 }
 if(typeof syncReviewIssueTimes==='function')syncReviewIssueTimes();
}

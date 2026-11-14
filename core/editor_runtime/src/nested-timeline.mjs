// Nested timelines retain untrimmed child instances; outer clips are projections.
export function nestedCollection(type){return {videolayer:'videoLayers',audioasset:'audioAssets',image:'images',text:'titles',caption:'captions',review:'reviewCaptions'}[type];}
export function cloneNestedInstance(group,id=()=>crypto.randomUUID(),existing=new Map()){
 const copy=JSON.parse(JSON.stringify(group)),ids=new Map(existing);
 const collect=g=>{if(!ids.has(g.id))ids.set(g.id,id());for(const e of g.nestedTimeline?.children||[])if(!ids.has(e.object.id))ids.set(e.object.id,id());for(const inner of g.nestedTimeline?.compounds||[])collect(inner);};collect(copy);
 const groups=new Map();
 const rewrite=value=>{if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){
  if(['id','ownerClipId','linkedAudioId','linkedVideoId','compoundId'].includes(key)&&ids.has(child))value[key]=ids.get(child);
  else if(key==='linkGroupId'&&child){if(!groups.has(child))groups.set(child,id());value[key]=groups.get(child);}
  else if(child&&typeof child==='object')rewrite(child);
 }};rewrite(copy);return copy;
}
export function projectNestedChildren(group){
 const sourceIn=Number(group.sourceStart||0),sourceOut=Number(group.sourceEnd??group.sourceDuration);
 const rate=(sourceOut-sourceIn)/(group.end-group.start);
 if(!(rate>0))return [];
 const nestedOrder=group.nestedTimeline?.trackOrder||[];
 const videoTrackId=group.videoTrackId||"video",audioTrackId=group.audioTrackId||"";
 const output=[];
 for(const entry of group.nestedTimeline?.children||[]){
  const c=entry.object,a=Math.max(sourceIn,c.start),b=Math.min(sourceOut,c.end);if(b<=a+1e-8)continue;
  const clip=JSON.parse(JSON.stringify(c)),localRate=Number(c.sourceEnd)>Number(c.sourceStart||0)?(c.sourceEnd-Number(c.sourceStart||0))/(c.end-c.start):Number(c.playbackRate||1);
  clip.start=group.start+(a-sourceIn)/rate;clip.end=group.start+(b-sourceIn)/rate;
  if(['videolayer','audioasset'].includes(entry.type)){
   clip.sourceStart=Number(c.sourceStart||0)+(a-c.start)*localRate;
   clip.sourceEnd=Number(c.sourceStart||0)+(b-c.start)*localRate;
   clip.playbackRate=localRate*rate;
  }
  if(c.words){
   clip.words=c.words.filter(w=>w.start<b&&w.end>a).map(w=>({...w,start:group.start+(Math.max(a,w.start)-sourceIn)/rate,end:group.start+(Math.min(b,w.end)-sourceIn)/rate}));
   clip.text=clip.words.map(w=>w.display||w.text||'').join(' ').replace(/\s+([,.!?;:])/g,'$1');
  }
  // Projected children retain their own transforms. The preview and export
  // compositors apply the compound's outer transform once to the flattened
  // stack, matching a native compound clip and keeping the nested edit intact.
  const isAudio=['audioasset'].includes(entry.type);
  const sourceTrackId=clip.trackId||entry.type;
  const sourceRank=nestedOrder.indexOf(sourceTrackId);
  const stackOrder=sourceRank<0?0:(nestedOrder.length-sourceRank)/(nestedOrder.length+1)*9;
  clip.compoundSourceTrackId=sourceTrackId;
  clip.compoundTrackId=isAudio?(audioTrackId||sourceTrackId):videoTrackId;
  clip.compoundStackOrder=stackOrder;
  if(entry.type==='videolayer'||entry.type==='image'||entry.type==='text')clip.trackId=videoTrackId;
  else if(isAudio&&audioTrackId)clip.trackId=audioTrackId;
  clip.compoundId=group.id;
  output.push({type:entry.type,object:clip});
 }
 return output;
}
export function applyNestedProjection(project,group){
 const oldIds=new Set((group.members||[]).map(x=>x.id));
 for(const key of ['videoLayers','audioAssets','images','titles','captions','reviewCaptions'])project[key]=(project[key]||[]).filter(x=>!oldIds.has(x.id)&&x.compoundId!==group.id);
 const entries=projectNestedChildren(group);
 for(const entry of entries){const key=nestedCollection(entry.type);if(key)(project[key]||=[]).push(entry.object);}
 group.members=entries.map(x=>({type:x.type,id:x.object.id}));
 return project;
}
export function updateNestedChildren(project,groupId,childProject){
 const group=(project.compoundClips||[]).find(g=>g.id===groupId);if(!group)return project;
 const children=[];
 for(const [type,key] of Object.entries({videolayer:'videoLayers',audioasset:'audioAssets',image:'images',text:'titles',caption:'captions',review:'reviewCaptions'}))for(const object of childProject[key]||[])children.push({type,object:JSON.parse(JSON.stringify(object))});
 group.nestedTimeline={...group.nestedTimeline,children,compounds:childProject.compoundClips||[],trackOrder:childProject.trackOrder,trackDefinitions:childProject.trackDefinitions,trackLocks:childProject.trackLocks,trackSyncLocks:childProject.trackSyncLocks};
 group.sourceDuration=Math.max(group.sourceDuration||0,...children.map(x=>x.object.end));
 return applyNestedProjection(project,group);
}

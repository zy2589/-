const compoundEditFrames=[];
function pasteNestedClipboardGroups(clipboard,ids,shift){
 for(const group of clipboard.compounds||[]){
  if(!group.members.every(m=>ids.has(selectionKey(m.type,m.id))))continue;
  const mapped=new Map(group.members.map(m=>[m.id,ids.get(selectionKey(m.type,m.id))]));
  const copy=cloneNestedInstance(group,uid,mapped);copy.start+=shift;copy.end+=shift;
  state.compoundClips.push(copy);applyNestedProjection(state,copy);
 }
}
function bakeCompoundForDecompose(group){
 if(!group)return;
 const transform=group.transform||{},scale=Math.max(.05,Math.min(8,Number(transform.scale||1))),rotation=Number(transform.rotation||0),angle=rotation*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle),x=Number(transform.x||0),y=Number(transform.y||0),opacity=Math.max(0,Math.min(1,Number(transform.opacity??1)));
 for(const member of group.members||[]){
  const object=timelineObjectFor(member.type,member.id);if(!object)continue;
  if(['videolayer','image','text'].includes(member.type)){
   const oldX=Number(object.x||0),oldY=Number(object.y||0);
   object.x=x+scale*(oldX*cos-oldY*sin);object.y=y+scale*(oldX*sin+oldY*cos);
   object.scale=Math.max(.03,Number(object.scale||1)*scale);object.rotation=Number(object.rotation||0)+rotation;
   object.opacity=Math.max(0,Math.min(1,Number(object.opacity??1)*opacity));
   for(const key of ['cropTop','cropBottom','cropLeft','cropRight'])object[key]=Math.min(95,Number(object[key]||0)+Number(transform[key]||0));
  }
  if(object.compoundSourceTrackId)object.trackId=object.compoundSourceTrackId;
  delete object.compoundId;delete object.compoundTrackId;delete object.compoundStackOrder;delete object.compoundSourceTrackId;
 }
}
function compoundProjectForSave(){
 let project=projectData();
 for(const frame of [...compoundEditFrames].reverse())project=updateNestedChildren(cloneClipData(frame.project),frame.groupId,project);
 return project;
}
function createNestedCompoundFromSelection(){
 let selected=expandLinkedSelection(resolveWorkingSelection(state.selectedItems?.length?state.selectedItems:[state.selected]));
 if(selected.some(x=>selectionIsLocked(x.type,x.id)))return toast('请先解锁要放入复合片段的轨道');
 if(selected.length<2)return toast('请先选择两个或更多片段');
 snapshot();
 selected=selected.map(x=>['video','audio'].includes(x.type)?materializeMainSegment(x.type,x.id)||x:x);
 // Linked materialization can replace both IDs at once.
 selected=expandLinkedSelection(state.selectedItems?.length?state.selectedItems:selected);
 const entries=[...new Map(selected.map(x=>{const entry=timelineCopyEntry(x.type,x.id);return [x.type+':'+x.id,entry];})).values()].filter(Boolean);
 if(entries.length<2){restoreSnapshot();return toast('请选择可编辑的时间线片段');}
 for(const entry of entries){
  if(entry.type!=='videolayer'||(entry.object.spliceRegionId&&entry.object.spliceRegionId!=='auto'))continue;
  const region=window.spliceRegionForExport?.({type:'layer',clip:entry.object,settings:entry.object,media:entry.object});
  if(region)entry.object.spliceRegionId=region.id;
 }
 const start=Math.min(...entries.map(x=>x.object.start)),end=Math.max(...entries.map(x=>x.object.end));
 const id=`compound-${uid()}`;
 const children=entries.map(entry=>{const object=cloneClipData(entry.object);object.start-=start;object.end-=start;for(const word of object.words||[]){word.start-=start;word.end-=start;}delete object.compoundId;return {type:entry.type,object};});
 const keys=new Set(entries.map(x=>x.object.id));
 const inner=(state.compoundClips||[]).filter(g=>(g.members||[]).every(x=>keys.has(x.id)));
 state.compoundClips=(state.compoundClips||[]).filter(g=>!inner.includes(g));
 const memberTrack=(entry)=>entry.type==='video'?state.mainVideoTrackMap?.[entry.object.id]||'video':entry.type==='audio'?state.mainAudioTrackMap?.[entry.object.id]||'audio':entry.object.trackId||entry.type;
 const videoTracks=entries.filter(x=>['video','videolayer','image','text','caption','review'].includes(x.type)).map(memberTrack),audioTracks=entries.filter(x=>['audio','audioasset'].includes(x.type)).map(memberTrack);
 const trackRank=(track)=>{const i=state.trackOrder.indexOf(track);return i<0?Number.MAX_SAFE_INTEGER:i;};
 const group={id,name:`复合片段 ${state.compoundClips.length+1}`,start,end,sourceStart:0,sourceEnd:end-start,sourceDuration:end-start,
  videoTrackId:videoTracks.sort((a,b)=>trackRank(a)-trackRank(b))[0]||'video',audioTrackId:audioTracks.sort((a,b)=>trackRank(a)-trackRank(b))[0]||'',
  transform:{x:0,y:0,scale:1,rotation:0,opacity:1,cropTop:0,cropBottom:0,cropLeft:0,cropRight:0},canvasWidth:state.width,canvasHeight:state.height,
  members:entries.map(x=>({type:x.type,id:x.object.id})),nestedTimeline:{children,compounds:inner.map(g=>({...cloneClipData(g),start:g.start-start,end:g.end-start})),trackOrder:[...state.trackOrder],trackDefinitions:cloneClipData(state.trackDefinitions||{}),width:state.width,height:state.height}};
 state.compoundClips.push(group);applyNestedProjection(state,group);
 state.selectedItems=[{type:'compound',id:group.id}];state.selected=state.selectedItems[0];
 recomputeContentDuration();renderAll();queueAutosave();toast('已创建复合片段；双击可编辑内部时间线');return true;
}
function openCompoundTimeline(id){
 const group=state.compoundClips.find(x=>x.id===id);if(!group)return;
 group.transform||={x:0,y:0,scale:1,rotation:0,opacity:1,cropTop:0,cropBottom:0,cropLeft:0,cropRight:0};
 if((group.members||[]).some(x=>selectionIsLocked(x.type,x.id)))return toast('复合片段含锁定轨道，请先解锁');
 if(state.playing)togglePlay();
 if(!group.nestedTimeline){
  const entries=group.members.map(x=>timelineCopyEntry(x.type,x.id)).filter(Boolean);
  group.sourceStart=0;group.sourceEnd=group.end-group.start;group.sourceDuration=group.sourceEnd;
  group.nestedTimeline={children:entries.map(entry=>{const object=cloneClipData(entry.object);object.start-=group.start;object.end-=group.start;for(const w of object.words||[]){w.start-=group.start;w.end-=group.start;}return {...entry,object};})};
 }
 const project=projectData();
 compoundEditFrames.push({project:cloneClipData(project),groupId:id,undo:state.undo,redo:state.redo,time:state.currentTime});
 for(const key of ['videoLayers','audioAssets','images','titles','captions','reviewCaptions'])state[key]=[];
 for(const entry of group.nestedTimeline.children||[]){const key=nestedCollection(entry.type);if(key)state[key].push(cloneClipData(entry.object));}
 state.compoundClips=cloneClipData(group.nestedTimeline.compounds||[]);
 state.removals=[{start:0,end:state.sourceDuration,source:'nested-source'}];state.mainAudioRemovals=cloneClipData(state.removals);
 state.manualCuts=[];state.mainAudioManualCuts=[];state.audioCuts=[];state.audioMutes=[];state.issues=[];state.matchIssues=[];state.captionRecoveryArchive=[];
 state.trackOrder=group.nestedTimeline.trackOrder||state.trackOrder;state.trackDefinitions=group.nestedTimeline.trackDefinitions||state.trackDefinitions;
 state.trackLocks=group.nestedTimeline.trackLocks||{};state.trackSyncLocks=group.nestedTimeline.trackSyncLocks||{};
 state.undo=[];state.redo=[];state.selectedItems=[];state.selected={type:'',id:''};state.currentTime=group.sourceStart||0;
 recomputeContentDuration();renderAll();seekTimeline(state.currentTime);syncCompoundNavigation();
}
function closeCompoundTimeline(){
 const frame=compoundEditFrames.pop();if(!frame)return;
 if(state.playing)togglePlay();
 const before=JSON.stringify(frame.project),project=updateNestedChildren(cloneClipData(frame.project),frame.groupId,projectData());
 state.undo=frame.undo;state.redo=frame.redo;
 if(JSON.stringify(project)!==before){state.undo.push(before);state.redo=[];if(state.undo.length>100)state.undo.shift();}
 applyHistoryState(project);recomputeContentDuration();seekTimeline(frame.time);renderAll();syncCompoundNavigation();queueAutosave();
}
function syncCompoundNavigation(){const button=$('exitCompoundTimeline');if(button){button.hidden=!compoundEditFrames.length;button.textContent=`返回上层时间线${compoundEditFrames.length>1?'（'+compoundEditFrames.length+'）':''}`;}}
const compoundBack=document.createElement('button');compoundBack.id='exitCompoundTimeline';compoundBack.className='btn';compoundBack.hidden=true;compoundBack.onclick=closeCompoundTimeline;
$('createCompoundClip')?.parentElement?.appendChild(compoundBack);
const enterProjectBeforeCompound=enterProject;
enterProject=async function(...args){while(compoundEditFrames.length)closeCompoundTimeline();return enterProjectBeforeCompound(...args);};
$('timelineContent').addEventListener('dblclick',event=>{const proxy=event.target.closest('[data-compound-proxy]');if(proxy){event.preventDefault();event.stopPropagation();openCompoundTimeline(proxy.dataset.compoundId);}},true);

// Manipulate the outer instance, never the untrimmed children.
(()=>{
 const surface=$('timelineContent'),original=surface.onpointerdown;let drag=null,pending=null,paintFrame=0;
 const acceptsTrack=(trackId,kind)=>{
  const targetKind=trackInfo(trackId)?.kind;
  return kind==='audio'?targetKind==='audio':['video','image','text'].includes(targetKind);
 };
 surface.onpointerdown=function(event){
  const proxy=event.target.closest('[data-compound-proxy]'),group=proxy&&state.compoundClips.find(g=>g.id===proxy.dataset.compoundId);
  if(event.button!==0||!group?.nestedTimeline||event.ctrlKey)return original.call(this,event);
  if(group.members.some(x=>selectionIsLocked(x.type,x.id)))return toast('复合片段含锁定轨道');
  drag={pointer:event.pointerId,x:event.clientX,y:event.clientY,scroll:$('timelineScroll').scrollLeft,group,origin:cloneClipData(group),before:cloneClipData(projectData(true)),edge:event.target.closest('[data-trim]')?.dataset.trim,slip:event.altKey,kind:proxy.classList.contains('audio')?'audio':'video',originTrackId:proxy.dataset.trackId||'',targetTrackId:proxy.dataset.trackId||''};
  state.selectedItems=[{type:'compound',id:group.id}];state.selected=state.selectedItems[0];
  renderTimeline();renderPreviewObjects();updateInspector();updateSelectionBox();
  event.preventDefault();event.stopPropagation();
 };
 function paint(event){
  if(!drag)return;
  const delta=(event.clientX-drag.x+$('timelineScroll').scrollLeft-drag.scroll)/state.zoom,origin=drag.origin;
  const targetRow=document.elementFromPoint(event.clientX,event.clientY)?.closest('.trackrow[data-track-key]');
  const targetTrackId=targetRow?.dataset.trackKey||'';
  const trackChanged=!!(targetTrackId&&targetTrackId!==drag.originTrackId&&acceptsTrack(targetTrackId,drag.kind)&&!isTrackLocked(targetTrackId));
  if(!drag.moved&&Math.abs(delta)<frameDuration()/2&&!trackChanged)return;
  if(!drag.moved)surface.setPointerCapture?.(event.pointerId);
  drag.moved=true;
  let next;
  if(drag.edge)next=editTrim(origin,drag.edge,origin[drag.edge]+delta,{fps:timelineFrameRate()});
  else if(drag.slip)next=editSlip(origin,delta,{fps:timelineFrameRate()});
  else{const start=frameAlignedTime(Math.max(0,origin.start+delta));next={...origin,start,end:start+origin.end-origin.start};}
  if(targetTrackId&&acceptsTrack(targetTrackId,drag.kind)&&!isTrackLocked(targetTrackId))drag.targetTrackId=targetTrackId;
  Object.assign(drag.group,next);applyNestedProjection(state,drag.group);recomputeContentDuration();renderTimeline();renderPreviewObjects();
 }
 document.addEventListener('pointermove',event=>{if(drag?.pointer!==event.pointerId)return;pending=event;if(!paintFrame)paintFrame=requestAnimationFrame(()=>{paintFrame=0;paint(pending);});},true);
 document.addEventListener('pointerup',event=>{
  if(drag?.pointer!==event.pointerId)return;if(paintFrame)cancelAnimationFrame(paintFrame);paintFrame=0;paint(event);
  if(!drag.moved){drag=null;return;}
  if(drag.targetTrackId&&acceptsTrack(drag.targetTrackId,drag.kind)&&!isTrackLocked(drag.targetTrackId)){
   if(drag.kind==='audio')drag.group.audioTrackId=drag.targetTrackId;
   else drag.group.videoTrackId=drag.targetTrackId;
   applyNestedProjection(state,drag.group);
  }
  const delta=editHistoryDelta(drag.before,projectData(true));if(delta){state.undo.push(JSON.stringify(delta));state.redo=[];queueAutosave();}
  drag=null;renderAll();
 },true);
 function cancel(){if(!drag)return;if(paintFrame)cancelAnimationFrame(paintFrame);paintFrame=0;applyHistoryState(drag.before);drag=null;renderAll();}
 document.addEventListener('pointercancel',cancel);window.addEventListener('keydown',event=>{if(event.key==='Escape'&&drag){event.preventDefault();cancel();}},true);
})();

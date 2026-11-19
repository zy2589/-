// Grouped timeline gestures are transactional. Main-track body gestures keep
// their packed source clips and do not remap captions as a side effect.
(()=>{
 const surface=$('timelineContent'),original=surface.onpointerdown;
 let transaction=null,advanced=null,frame=0,pending=null;
 const unlocked=item=>!selectionIsLocked(item.type,item.obj.id);
 function partners(item){return [item,...(state.avLinked?editMediaItems().filter(x=>x.obj!==item.obj&&item.obj.linkGroupId&&x.obj.linkGroupId===item.obj.linkGroupId):[])].filter(unlocked);}
 surface.onpointerdown=function(e){
  const element=e.target.closest('.clip[data-type][data-id]');
  if(e.button!==0||!element||!['video','audio','videolayer','audioasset'].includes(element.dataset.type)||editTool==='blade'||selectionIsLocked(element.dataset.type,element.dataset.id))return original.call(this,e);
  const mainTrackBodyGesture=['video','audio'].includes(element.dataset.type)&&!e.target.closest('[data-trim]')&&!(editTool==='trim'&&e.shiftKey);
  const before=JSON.stringify(projectData(true)),undoLength=state.undo.length;
  transaction={before,undoLength,pointer:e.pointerId};
  timelineHistoryTransaction=true;
  let type=element.dataset.type,id=element.dataset.id;
  if(!mainTrackBodyGesture&&(type==='video'||type==='audio')){
   const replacement=materializeMainSegment(type,id);if(replacement){type=replacement.type;id=replacement.id;element.dataset.type=type;element.dataset.id=id;}
  }
  // Materialize all selected main instances before the original handler collects movement.
  if(!mainTrackBodyGesture)for(const item of [...(state.selectedItems||[])])if(['video','audio'].includes(item.type)&&!selectionIsLocked(item.type,item.id))materializeMainSegment(item.type,item.id);
  const obj=timelineObjectFor(type,id),edge=e.target.closest('[data-trim]')?.dataset.trim;
  if(obj&&editTool==='trim'&&e.shiftKey){
   materializeTimelineMedia();
   const items=editMediaItems().filter(x=>x.track===(obj.trackId||selectionTrackId(type,id))).sort((a,b)=>a.obj.start-b.obj.start);
   const index=items.findIndex(x=>x.obj===obj),anchor=items[index];
   const chosen=edge?edge==='end'?[anchor,items[index+1]]:[items[index-1],anchor]:[items[index-1],anchor,items[index+1]];
   if(chosen.some(x=>!x||!unlocked(x))){toast('需要可编辑的相邻片段');cancel();return;}
   if(chosen.some((x,i)=>i&&Math.abs(chosen[i-1].obj.end-x.obj.start)>1e-7)){toast('相邻片段之间不能有空隙');cancel();return;}
   const groups=chosen.map(partners),snapshots=groups.map(group=>group.map(x=>({...x,original:cloneClipData(x.obj)})));
   advanced={pointer:e.pointerId,startX:e.clientX,scroll:$('timelineScroll').scrollLeft,kind:edge?'roll':'slide',groups:snapshots,edge};
   surface.setPointerCapture?.(e.pointerId);e.preventDefault();e.stopPropagation();return;
  }
  try{original.call(this,e);}catch(error){cancel();throw error;}
  if(timelineDrag)timelineDrag.originScrollLeft=$("timelineScroll").scrollLeft;
  if(timelineDrag?.moving)timelineDrag.moving=timelineDrag.moving.filter(item=>!selectionIsLocked(item.type,item.id));
 };
 function paint(e){
  if(!advanced)return;
  const scroll=$('timelineScroll'),rect=scroll.getBoundingClientRect();
  if(e.clientX>rect.right-40)scroll.scrollLeft+=12;else if(e.clientX<rect.left+40)scroll.scrollLeft=Math.max(0,scroll.scrollLeft-12);
  const delta=(e.clientX-advanced.startX+scroll.scrollLeft-advanced.scroll)/state.zoom,groups=advanced.groups,originals=groups.map(x=>x[0].original);
  let result;
  if(advanced.kind==='roll'){const roll=editRoll(originals[0],originals[1],originals[0].end+delta,{fps:timelineFrameRate()});result=[roll.left,roll.right];}
  else{const slide=editSlide(...originals,delta,{fps:timelineFrameRate()});result=[slide.left,slide.clip,slide.right];}
  let applied=result[0].end-originals[0].end;
  for(let index=0;index<groups.length;index++)for(const item of groups[index]){
   if(advanced.kind==='slide'&&index===1){applied=Math.max(applied,-item.original.start);continue;}
   const edge=index===0?'end':'start',own=item.original,limited=editTrim(own,edge,own[edge]+applied,{fps:timelineFrameRate()}),available=limited[edge]-own[edge];
   applied=applied>=0?Math.min(applied,available):Math.max(applied,available);
  }
  if(advanced.kind==='roll'){const roll=editRoll(originals[0],originals[1],originals[0].end+applied,{fps:timelineFrameRate()});result=[roll.left,roll.right];}
  else{const slide=editSlide(...originals,applied,{fps:timelineFrameRate()});result=[slide.left,slide.clip,slide.right];}
  groups.forEach((group,index)=>group.forEach(item=>{
   const base=originals[index],next=result[index],own=item.original,rate=editRate(own,Number(state.audio.speed||1));
   let changed={...own};
   if(advanced.kind==='slide'&&index===1){changed.start+=next.start-base.start;changed.end+=next.end-base.end;}
   else {const edge=index===0?'end':'start';changed=editTrim(own,edge,own[edge]+next[edge]-base[edge],{fps:timelineFrameRate(),rate});}
   Object.assign(item.obj,changed);updateTimelineClipGeometry(item.type,item.obj.id,item.obj);
  }));
 }
 document.addEventListener('pointermove',e=>{if(advanced?.pointer!==e.pointerId)return;pending=e;if(!frame)frame=requestAnimationFrame(()=>{frame=0;paint(pending);});},true);
 document.addEventListener('pointerup',e=>{if(transaction?.pointer===e.pointerId&&timelineDrag?.moving&&!timelineDrag.slip)transaction.moving=timelineDrag.moving.filter(x=>Math.abs(x.obj.start-x.originStart)>1e-7);},true);
 document.addEventListener('pointerup',e=>{
  if(!transaction||transaction.pointer!==e.pointerId)return;
  if(frame){cancelAnimationFrame(frame);frame=0;}if(advanced)paint(e);
  const before=transaction.before;
  if(transaction.moving?.length){
   materializeTimelineMedia();const movingIds=new Set(transaction.moving.map(x=>x.obj.id));
   for(const item of transaction.moving){const list=timelineCollection(item.type);if(!list)continue;const others=list.filter(x=>!movingIds.has(x.id)&&x.trackId===item.obj.trackId),untouched=list.filter(x=>movingIds.has(x.id)||x.trackId!==item.obj.trackId);list.splice(0,list.length,...untouched,...overwriteEditableClips(others,item.obj.start,item.obj.end));}
   recomputeContentDuration();renderAll();
  }
  if(advanced){advanced=null;recomputeContentDuration();renderAll();}
  reconcileEditLinks();
  // Earlier handlers may have recorded snapshots; replace them with the single pre-gesture state.
  state.undo.splice(transaction.undoLength);
  const delta=editHistoryDelta(JSON.parse(before),projectData(true));
  if(delta){state.undo.push(JSON.stringify(delta));state.redo=[];if(state.undo.length>100)state.undo.shift();queueAutosave();}
  transaction=null;timelineHistoryTransaction=false;
 });
 function cancel(){if(frame)cancelAnimationFrame(frame);frame=0;advanced=null;timelineDrag=null;timelineHistoryTransaction=false;if(transaction){state.undo.splice(transaction.undoLength);applyHistoryState(JSON.parse(transaction.before));transaction=null;}}
 document.addEventListener('pointercancel',cancel);
 window.addEventListener('blur',cancel);
 window.addEventListener('keydown',e=>{if(e.key==='Escape'&&transaction){e.preventDefault();cancel();}},true);
})();

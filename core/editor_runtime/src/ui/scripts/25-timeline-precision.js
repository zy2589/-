// Optional precision tools keep their transient state out of saved projects.
let detailWaveformSource = "";
const detailWaveformCache = new Map();
const detailWaveformPending = new Set();
let detailWaveformTimer = 0;
function detailedWaveformAt(start, end) {
  if (detailWaveformSource !== state.video?.path || state.zoom < 240) return null;
  const detail = detailWaveformCache.get(Math.floor(start / 8) * 8);
  return detail && start >= detail.start && end <= detail.start + detail.duration ? detail : null;
}
function requestDetailedWaveform() {
  clearTimeout(detailWaveformTimer);
  if (state.zoom < 240 || !state.video?.path) return;
  detailWaveformTimer = setTimeout(async () => {
    const source = state.video?.path;
    if (detailWaveformSource !== source) { detailWaveformSource = source; detailWaveformCache.clear(); }
    const scroll = $("timelineScroll");
    const from = scroll.scrollLeft / state.zoom, to = (scroll.scrollLeft + scroll.clientWidth) / state.zoom;
    const desired = new Set();
    for (const clip of mainAudioClips()) {
      if (clip.end <= from || clip.start >= to) continue;
      const speed = (clip.sourceEnd - clip.sourceStart) / (clip.end - clip.start);
      const a = clip.sourceStart + (Math.max(from, clip.start) - clip.start) * speed;
      const b = clip.sourceStart + (Math.min(to, clip.end) - clip.start) * speed;
      for (let start = Math.floor(a / 8) * 8; start < b; start += 8) desired.add(start);
    }
    for (const start of [...desired].slice(0, 12)) {
      if (state.video?.path !== source || state.zoom < 240) return;
      const key = `${source}|${start}`;
      if (detailWaveformCache.has(start) || detailWaveformPending.has(key)) continue;
      detailWaveformPending.add(key);
      try {
        const result = await nativeCall("waveformDetail", { inputPath: source, start, duration: 8 });
        if (state.video?.path !== source || detailWaveformSource !== source) return;
        detailWaveformCache.set(start, result);
        while (detailWaveformCache.size > 16) detailWaveformCache.delete(detailWaveformCache.keys().next().value);
        drawWaveform();
      } catch { /* The overview remains usable if detail decoding fails. */ }
      finally { detailWaveformPending.delete(key); }
    }
  }, 180);
}

function zoomTimelineRange(start, end) {
  const scroll = $("timelineScroll");
  setTimelineZoomAroundPlayhead(clamp((scroll.clientWidth - 80) / Math.max(frameDuration(), end - start), .1, 6000));
  scroll.scrollLeft = Math.max(0, start * state.zoom - 40);
  renderTimeline();
}
$("timelineZoomAnchor")?.addEventListener("change", event => { state.timelineZoomAnchor = event.target.value; });
$("zoomCutDetail")?.addEventListener("click", () => {
  setTimelineZoomAroundPlayhead(Math.min(6000, timelineFrameRate() * 24));
  const scroll = $("timelineScroll");
  scroll.scrollLeft = Math.max(0, state.currentTime * state.zoom - scroll.clientWidth / 2);
  renderTimeline(); requestDetailedWaveform();
});
$("zoomSelectedClips")?.addEventListener("click", () => {
  const items = (state.selectedItems?.length ? state.selectedItems : [state.selected])
    .filter(Boolean).map(item => timelineObjectFor(item.type, item.id)).filter(Boolean);
  if (!items.length) return toast("请先选择要放大的片段");
  zoomTimelineRange(Math.min(...items.map(item => item.start)), Math.max(...items.map(item => item.end)));
});
window.addEventListener("keydown", event => {
  if (event.key === "Control" && typeof timelineDrag !== "undefined" && timelineDrag) { state.snapTemporarilyDisabled = true; hideSnapGuide(); }
}, true);
window.addEventListener("keyup", event => { if (event.key === "Control") state.snapTemporarilyDisabled = false; }, true);
window.addEventListener("blur", () => { state.snapTemporarilyDisabled = false; });
window.addEventListener("pointerup", () => { state.snapTemporarilyDisabled = false; });

let precisionCutContext = null;
let cutFrameGeneration = 0;
function precisionCutPair() {
  const tracks=new Map();
  for(const entry of editMediaItems().filter(x=>['video','videolayer'].includes(x.type))){
    if(!tracks.has(entry.track))tracks.set(entry.track,[]);
    tracks.get(entry.track).push({...entry.obj,sourceStart:Number(entry.obj.sourceStart||0),sourceEnd:Number(entry.obj.sourceEnd??(Number(entry.obj.sourceStart||0)+(entry.obj.end-entry.obj.start)*editRate(entry.obj,Number(state.audio.speed||1)))),editType:entry.type});
  }
  let best=null;
  const selectedTrack=selectionTrackId();
  for(const [track,clips] of tracks){
    clips.sort((a,b)=>a.start-b.start);
    for(let i=0;i<clips.length-1;i++){
      const left=clips[i],right=clips[i+1],time=(left.end+right.start)/2;
      const score=Math.abs(time-state.currentTime)+(track===selectedTrack?0:100000);
      if(!best||score<best.score)best={left,right,time,score,track};
    }
  }
  return best;
}
async function presentCutFrame(video, time, generation, clip) {
  const url = clip?.url || state.video?.url;
  if (video.dataset.sourceUrl !== url) { video.dataset.sourceUrl = url; video.src = url; video.load(); }
  video.pause(); video.muted = true;
  video.style.visibility = "hidden";
  const seek = () => {
    if (generation !== cutFrameGeneration) return;
    const sourceFps=Number(clip?.frameRate||state.video?.frameRate||timelineFrameRate());
    const target=Math.max(0,Math.min((Math.floor(Math.max(0,time)*sourceFps+1e-7)+.25)/sourceFps,Math.max(0,video.duration-.25/sourceFps)));
    video.onseeked = () => {
      if (generation === cutFrameGeneration && Math.abs(video.currentTime - target) < frameDuration() / 2) video.style.visibility = "visible";
    };
    if (Math.abs(video.currentTime-target) < 1e-6 && video.readyState >= 2) video.style.visibility = "visible";
    else video.currentTime = target;
  };
  if (video.readyState >= 1) seek(); else video.onloadedmetadata = seek;
}
function refreshCutInspector(pair = precisionCutPair()) {
  if (!pair) return toast("至少需要两个视频片段才能精修切口");
  precisionCutContext = {...pair, projectId:state.projectId, path:state.video?.path};
  const generation = ++cutFrameGeneration;
  const leftRate = (pair.left.sourceEnd-pair.left.sourceStart)/(pair.left.end-pair.left.start);
  presentCutFrame($("cutBeforeVideo"), pair.left.sourceEnd-frameDuration()*leftRate, generation, pair.left);
  presentCutFrame($("cutAfterVideo"), pair.right.sourceStart, generation, pair.right);
  $("cutInspectorTime").textContent = `${formatTimecode(pair.left.end)} → ${formatTimecode(pair.right.start)} · ${timelineFrameRate().toFixed(3).replace(/\.000$/, "")} fps（NDF）`;
}
function nudgeCutEdge(side, frames) {
  const context = precisionCutContext;
  if (!context || context.projectId !== state.projectId || context.path !== state.video?.path) return toast("工程已变化，请重新打开切口精修");
  let type=context[side].editType||'video',id=context[side].id;
  if(selectionIsLocked(type,id))return toast('当前轨道已锁定');
  snapshot();
  if(type==='video'){const replacement=materializeMainSegment(type,id);if(!replacement){state.undo.pop();return refreshCutInspector();}type=replacement.type;id=replacement.id;}
  const clip=timelineObjectFor(type,id);if(!clip){state.undo.pop();return refreshCutInspector();}
  const edge=side==='left'?'end':'start';
  const linked=[{type,id,obj:clip},...linkedTimelineObjects(type,id).filter(x=>!selectionIsLocked(x.type,x.id))];
  const next=editLinkedTrim(linked.map(x=>x.obj),edge,frames*frameDuration(),{fps:timelineFrameRate(),bounds:linked.map(x=>editNeighborBounds(x.obj,x.type))});
  const time=next[0][edge];
  if(Math.abs(time-clip[edge])<frameDuration()/2){restoreSnapshot();return toast('已到可用素材或相邻切口边界');}
  if(state.playing)togglePlay();state.cutPreviewRange=null;$('loopCutPreview').textContent='循环试听前后 1 秒';
  linked.forEach((x,i)=>Object.assign(x.obj,next[i]));
  recomputeContentDuration();seekTimeline(time);renderAll();queueAutosave();refreshCutInspector();
}
$("openCutInspector")?.addEventListener("click", () => {
  if (!precisionCutPair()) return toast("请先切出至少两个视频片段");
  const dialog = $("cutInspector"); if (!dialog.open) dialog.show();
  refreshCutInspector();
});
document.querySelectorAll("[data-cut-nudge]").forEach(button => button.addEventListener("click", () => nudgeCutEdge(button.dataset.cutSide, Number(button.dataset.cutNudge))));
$("closeCutInspector")?.addEventListener("click", () => $("cutInspector").close());
$("cutInspector")?.addEventListener("close", () => {
  ++cutFrameGeneration; state.cutPreviewRange = null;
  $("loopCutPreview").textContent = "循环试听前后 1 秒";
  for (const id of ["cutBeforeVideo","cutAfterVideo"]) { const video=$(id); video.pause(); video.removeAttribute("src"); delete video.dataset.sourceUrl; video.load(); }
});
$("loopCutPreview")?.addEventListener("click", async () => {
  if (state.cutPreviewRange) { state.cutPreviewRange=null; if(state.playing) await togglePlay(); $("loopCutPreview").textContent="循环试听前后 1 秒"; return; }
  const context=precisionCutContext;
  if (!context || context.path!==state.video?.path || context.projectId!==state.projectId) return;
  if(state.playing) await togglePlay();
  state.cutPreviewRange={start:Math.max(0,context.left.end-1),end:Math.min(state.duration,context.right.start+1),projectId:state.projectId};
  seekTimeline(state.cutPreviewRange.start); await togglePlay();
  $("loopCutPreview").textContent="停止循环试听";
});
function serviceCutPreviewLoop() {
  const range=state.cutPreviewRange;
  if (!range || !state.playing) return false;
  if (range.projectId!==state.projectId) { state.cutPreviewRange=null; return false; }
  if (state.currentTime>=range.end-frameDuration()/4) { seekTimeline(range.start); return true; }
  return false;
}

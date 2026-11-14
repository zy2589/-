// Clipboard stores source references and deep copies of edit settings, never media files.
let timelineClipboard = null;
function cloneClipData(value) { return JSON.parse(JSON.stringify(value)); }
function timelineCopyEntry(type, id) {
  const main = type === "video" ? mainClips().find(c => c.id === id)
    : type === "audio" ? mainAudioClips().find(c => c.id === id) : null;
  if (!main) {
    const object = timelineObjectFor(type, id);
    return object && ["videolayer", "audioasset", "image", "text", "caption"].includes(type)
      ? {type, object: cloneClipData(object)} : null;
  }
  const media = type==="audio"&&state.denoiseEnabled&&state.denoisedAudio?.path ? {...state.video,...state.denoisedAudio,playbackAudioPath:"",playbackAudioUrl:"",sourceMediaId:state.video.path} : state.video;
  const settings = type === "video" ? mainVideoSettings(main) : audioSettingsFor(type, id);
  return {type: type === "video" ? "videolayer" : "audioasset", object: cloneClipData({
    ...media, ...settings, ...main, id, libraryId: media.id,
    trackId: selectionTrackId(type, id), sourceDuration: state.sourceDuration,
    waveform: state.waveform || [], x: settings?.x || 0, y: settings?.y || 0,
    previewUrl: type === "audio" ? "" : media.previewUrl,
    previewPath: type === "audio" ? "" : media.previewPath,
    scale: settings?.scale ?? 1, volume: settings?.volume ?? 1,
    linkGroupId: state.avLinked ? `main:${id}` : "",
  })};
}
function timelineCollection(type) {
  return {videolayer:state.videoLayers, audioasset:state.audioAssets, image:state.images,
    text:state.titles, caption:state.captions}[type];
}
function copyTimelineClips() {
  const selected = resolveWorkingSelection(state.selectedItems?.length ? state.selectedItems : [state.selected]);
  const entries = expandLinkedSelection(selected).map(item => timelineCopyEntry(item.type,item.id)).filter(Boolean);
  const owners=new Set(entries.filter(e=>['videolayer','audioasset'].includes(e.type)).map(e=>e.object.id));
  for(const caption of state.captions||[])if(owners.has(caption.ownerClipId)&&!entries.some(e=>e.type==='caption'&&e.object.id===caption.id))entries.push({type:'caption',object:cloneClipData(caption)});
  if (!entries.length) { toast("请先选择要复制的素材"); return false; }
  timelineClipboard = {entries, start:Math.min(...entries.map(e=>e.object.start)), end:Math.max(...entries.map(e=>e.object.end))};
  const copiedIds=new Set(entries.map(e=>e.object.id));
  timelineClipboard.compounds=(state.compoundClips||[]).filter(g=>g.nestedTimeline&&g.members.every(m=>copiedIds.has(m.id))).map(cloneClipData);
  toast(`已复制 ${entries.length} 个片段`);
  return true;
}
function pasteTimelineClips(at = state.currentTime, mode = "overwrite") {
  if (!timelineClipboard) return toast("请先复制时间线素材");
  const entries = timelineClipboard.entries.filter(e => !isTrackLocked(e.object.trackId));
  if (!entries.length) return toast("目标轨道已锁定，请先解锁");
  snapshot();
  at=frameAlignedTime(Math.max(0,Number(at)||0));
  editPasteSpace(entries,at,mode);
  const ids = new Map(entries.map(e=>[selectionKey(e.type,e.object.id),uid()])), groups = new Map();
  const shift = Math.max(0, Number(at)||0) - timelineClipboard.start;
  const selected = [];
  for (const entry of entries) {
    const object = cloneClipData(entry.object);
    object.id = ids.get(selectionKey(entry.type,object.id)); object.start += shift; object.end += shift;
    if (object.words) object.words.forEach(w => { w.start += shift; w.end += shift; });
    if (object.linkGroupId) {
      if (!groups.has(object.linkGroupId)) groups.set(object.linkGroupId,uid());
      object.linkGroupId = groups.get(object.linkGroupId);
    }
    object.linkedVideoId = ids.get(selectionKey("videolayer",object.linkedVideoId)) || "";
    object.linkedAudioId = ids.get(selectionKey("audioasset",object.linkedAudioId)) || "";
    if(object.ownerClipId)object.ownerClipId=ids.get(selectionKey("videolayer",object.ownerClipId))||ids.get(selectionKey("audioasset",object.ownerClipId))||ids.get(selectionKey("video",object.ownerClipId))||object.ownerClipId;
    delete object.compoundId;
    const kind = entry.type === "audioasset" ? "audio" : ["video", "videolayer", "image", "text"].includes(entry.type) ? "video" : entry.type;
    if (["video", "audio", "caption"].includes(kind) &&
        (!state.trackOrder.includes(object.trackId) || trackInfo(object.trackId).kind !== kind)) {
      object.trackId = resolveTrackForInsert(kind, object.start, object.end, "", object.name || `${trackMeta[kind]?.label || "素材"}轨道`);
    }
    timelineCollection(entry.type).push(object);
    selected.push({type:entry.type,id:object.id});
  }
  if(typeof pasteNestedClipboardGroups==='function')pasteNestedClipboardGroups(timelineClipboard,ids,shift);
  reconcileEditLinks();
  state.selectedItems = selected; state.selected = selected[0];
  recomputeContentDuration(); renderAll(); queueAutosave();
  toast(`已粘贴 ${selected.length} 个片段${entries.length < timelineClipboard.entries.length ? "，锁定轨道已跳过" : ""}`);
}
function duplicateTimelineClips() {
  if (copyTimelineClips()) pasteTimelineClips(timelineClipboard.end);
}

// Give a packed main segment independent source handles before editing it.
// Its linked partner keeps the same content and position, including on a locked track.
function materializeMainSegment(type, id) {
  const videoBefore = mainClips(), audioBefore = mainAudioClips();
  const clip = (type === "video" ? videoBefore : audioBefore).find(c=>c.id===id);
  if (!clip) return null;
  const targets = state.avLinked
    ? [{type:"video",id}, {type:"audio",id}]
    : [{type,id}];
  const replacements = new Map();
  const group = uid();
  for (const target of targets) {
    const entry = timelineCopyEntry(target.type,target.id);
    if (!entry) continue;
    const object = entry.object;
    object.id = uid(); object.linkGroupId = state.avLinked ? group : "";
    object.sourceMediaId=object.sourceMediaId||state.video.path;
    for(const caption of [...(state.captions||[]),...(state.reviewCaptions||[])]){if((caption.ownerClipType||"video")===target.type&&(caption.ownerClipId===id||(!caption.ownerClipId&&caption.start>=clip.start-1e-7&&caption.end<=clip.end+1e-7))){caption.ownerClipId=object.id;caption.ownerClipType=entry.type==='audioasset'?'audioasset':'videolayer';caption.sourceMediaId=state.video.path;
      const rate=(clip.sourceEnd-clip.sourceStart)/(clip.end-clip.start);
      if(!Number.isFinite(caption.sourceStart)){caption.sourceStart=clip.sourceStart+(caption.start-clip.start)*rate;caption.sourceEnd=clip.sourceStart+(caption.end-clip.start)*rate;}
      for(const word of caption.words||[])if(!Number.isFinite(word.sourceStart)){word.sourceStart=clip.sourceStart+(word.start-clip.start)*rate;word.sourceEnd=clip.sourceStart+(word.end-clip.start)*rate;}}}
    timelineCollection(entry.type).push(object);
    replacements.set(selectionKey(target.type,target.id),{type:entry.type,id:object.id});
  }
  const removal = {start:clip.sourceStart,end:clip.sourceEnd,source:"independent-clip"};
  if (type === "video" || state.avLinked) {
    state.removals = normalizeRemovalsList([...state.removals,removal]);
    const packed = baseMainClips();
    state.mainVideoClipOffsets = offsetsFromPlaced(packed,videoBefore,Number(state.mainTimelineOffset||0));
    if (state.avLinked) state.mainAudioClipOffsets = {...state.mainVideoClipOffsets};
    adoptClipMaps(videoBefore,packed);
  } else {
    state.mainAudioRemovals = normalizeRemovalsList([...state.mainAudioRemovals,removal]);
    const packed = buildPackedMainClips(state.mainAudioRemovals,state.mainAudioManualCuts,state.sourceDuration,state.audio.speed);
    state.mainAudioClipOffsets = offsetsFromPlaced(packed,audioBefore,Number(state.mainAudioTimelineOffset||0));
    adoptMainAudioMaps(audioBefore);
  }
  const remap = item => replacements.get(selectionKey(item.type,item.id)) || item;
  state.selectedItems = (state.selectedItems||[]).map(remap); state.selected = remap(state.selected);
  for (const compound of state.compoundClips||[]) compound.members = compound.members.map(remap);
  return replacements.get(selectionKey(type,id));
}

var cropEditing = false, cropPointer = null, previewToolMode = "transform";
function selectedPreviewVisualActive() {
  const selected = state.selected || {};
  if (selected.type === "video") {
    const clip = activeMainVideoClip();
    return !!clip && (selected.id === "main" || selected.id === clip.id);
  }
  const object = currentObject();
  return !!object && ["videolayer", "image"].includes(selected.type) &&
    state.currentTime >= Number(object.start || 0) && state.currentTime < Number(object.end || 0);
}
function syncPreviewToolUi() {
  const object = currentObject();
  const supported = ["video", "videolayer", "image"].includes(state.selected?.type) && !!object && selectedPreviewVisualActive();
  const menu = $("previewToolMenu");
  const modeButton = $("previewToolButton");
  const modeLabel = $("previewToolLabel");
  const transformButton = menu?.querySelector('[data-preview-tool="transform"]');
  const cropButton = menu?.querySelector('[data-preview-tool="crop"]');
  if (modeButton) {
    modeButton.dataset.mode = previewToolMode;
    modeButton.setAttribute("aria-label", previewToolMode === "crop" ? "当前工具：裁切" : "当前工具：变换");
    modeButton.setAttribute("aria-expanded", String(!!menu && !menu.hidden));
  }
  if (modeLabel) modeLabel.textContent = previewToolMode === "crop" ? "裁切" : "变换";
  const modeSymbol = modeButton?.querySelector(".preview-tool-symbol");
  if (modeSymbol) modeSymbol.textContent = previewToolMode === "crop" ? "◩" : "▱";
  if (transformButton) transformButton.classList.toggle("active", previewToolMode === "transform");
  if (cropButton) {
    cropButton.classList.toggle("active", previewToolMode === "crop");
    cropButton.disabled = !supported || selectionIsLocked();
  }
  const manualCrop = $("manualCropBtn");
  if (manualCrop) {
    manualCrop.classList.toggle("active", previewToolMode === "crop");
    manualCrop.textContent = previewToolMode === "crop" ? "完成手动裁剪" : "手动拖动裁剪";
  }
  const range = $("previewZoomRange"), output = $("previewZoomValue"), objectScale = $("objectScale");
  if (range) {
    range.disabled = !supported || selectionIsLocked();
    const scale = Math.round(clamp(Number(object?.scale || 1) * 100, 10, 300));
    range.value = String(scale);
    if (output) output.value = output.textContent = `${scale}%`;
    if (objectScale) objectScale.value = String(scale);
    const inspectorOutput = $("scaleOut");
    if (inspectorOutput) inspectorOutput.textContent = `${scale}%`;
  }
}
function setPreviewToolMode(mode) {
  const next = mode === "crop" ? "crop" : "transform";
  if (next === "crop") {
    if (!guardUnlocked()) return false;
    if (!["video", "videolayer", "image"].includes(state.selected?.type) || !currentObject() || !selectedPreviewVisualActive()) {
      toast("请先选中一个视频或图片，再使用裁切工具。");
      return false;
    }
  }
  previewToolMode = next;
  cropEditing = next === "crop";
  const menu = $("previewToolMenu");
  if (menu) menu.hidden = true;
  syncPreviewToolUi();
  updateSelectionBox();
  return true;
}
window.syncPreviewToolUi = syncPreviewToolUi;
window.setPreviewToolMode = setPreviewToolMode;
function cropContentBounds(element, object = {}) {
  if (window.__clipAssistantWorkspaceMode === "splice" && ["video", "videolayer", "image"].includes(state.selected?.type)) {
    const box = $("selectionBox");
    const clip = state.selected.type === "video"
      ? activeMainVideoClip()
      : object;
    const target = state.selected.type === "video"
      ? (clip ? { type: "main", clip, settings: object, media: state.video } : null)
      : { type: "layer", clip: object, settings: object, media: object };
    if (target && window.spliceSelectionBounds?.(target) && box?.classList.contains("on"))
      return { width: box.clientWidth || 1, height: box.clientHeight || 1, left: 0, top: 0 };
  }
  const width = element?.clientWidth || $("frame")?.clientWidth || 1, height = element?.clientHeight || $("frame")?.clientHeight || 1;
  const sourceWidth = element?.videoWidth || element?.naturalWidth || Number(object.width) || width;
  const sourceHeight = element?.videoHeight || element?.naturalHeight || Number(object.height) || height;
  const contain = element?.tagName === "VIDEO";
  const scale = contain ? Math.min(width/sourceWidth,height/sourceHeight) : 1;
  const w = contain ? sourceWidth*scale : width, h = contain ? sourceHeight*scale : height;
  return {width:w,height:h,left:(width-w)/2,top:(height-h)/2};
}
function previewCropMask(object, element) {
  const bounds = cropContentBounds(element,object);
  return `inset(${bounds.top+bounds.height*Number(object.cropTop||0)/100}px ${bounds.left+bounds.width*Number(object.cropRight||0)/100}px ${bounds.top+bounds.height*Number(object.cropBottom||0)/100}px ${bounds.left+bounds.width*Number(object.cropLeft||0)/100}px)`;
}
function selectedCropElement() {
  return state.selected.type === "video" ? getActiveVideo()
    : $("frame").querySelector(`[data-type="${state.selected.type}"][data-id="${state.selected.id}"]`);
}
function syncCropHandles() {
  const box = $("selectionBox"), object = currentObject();
  const enabled = cropEditing && ["video","videolayer","image"].includes(state.selected.type) && object && selectedPreviewVisualActive() && !selectionIsLocked();
  if (cropEditing && !enabled) { cropEditing = false; previewToolMode = "transform"; }
  box.classList.toggle("crop-editing",!!enabled);
  syncPreviewToolUi();
  if (!enabled) return;
  let overlay = box.querySelector(".crop-overlay");
  if (!overlay) {
    overlay = document.createElement("div"); overlay.className = "crop-overlay";
    overlay.innerHTML = ["n","ne","e","se","s","sw","w","nw"].map(side=>`<i class="crop-handle ${side}" data-crop-handle="${side}" title="拖动裁剪；按住 Shift 精细调整"></i>`).join("");
    box.appendChild(overlay);
  }
  const bounds = cropContentBounds(selectedCropElement(),object);
  overlay.style.inset = `${bounds.top+bounds.height*Number(object.cropTop||0)/100}px ${bounds.left+bounds.width*Number(object.cropRight||0)/100}px ${bounds.top+bounds.height*Number(object.cropBottom||0)/100}px ${bounds.left+bounds.width*Number(object.cropLeft||0)/100}px`;
}
$("manualCropBtn")?.addEventListener("click",()=>{
  setPreviewToolMode(cropEditing ? "transform" : "crop");
});
$("previewToolButton")?.addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = $("previewToolMenu");
  if (menu) menu.hidden = !menu.hidden;
  syncPreviewToolUi();
});
$("previewToolMenu")?.querySelectorAll("[data-preview-tool]").forEach((button) => {
  button.addEventListener("click", () => setPreviewToolMode(button.dataset.previewTool));
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".preview-tool-select")) {
    const menu = $("previewToolMenu");
    if (menu && !menu.hidden) { menu.hidden = true; syncPreviewToolUi(); }
  }
});
function setPreviewZoom(value) {
  const scale = $("objectScale");
  if (!scale || !$("previewZoomRange") || $("previewZoomRange").disabled) return;
  scale.value = String(clamp(Number(value) || 100, Number(scale.min || 10), Number(scale.max || 300)));
  scale.dispatchEvent(new Event("input", { bubbles: true }));
  syncPreviewToolUi();
}
$("previewZoomRange")?.addEventListener("pointerdown", () => { if (guardUnlocked()) snapshot(); });
$("previewZoomRange")?.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && guardUnlocked()) snapshot();
});
$("previewZoomRange")?.addEventListener("input", (event) => setPreviewZoom(event.target.value));
$("previewZoomOut")?.addEventListener("click", () => { if (guardUnlocked()) { snapshot(); setPreviewZoom(Number($("previewZoomRange")?.value || 100) - 5); } });
$("previewZoomIn")?.addEventListener("click", () => { if (guardUnlocked()) { snapshot(); setPreviewZoom(Number($("previewZoomRange")?.value || 100) + 5); } });
$("objectScale")?.addEventListener("input", syncPreviewToolUi);
for (const key of ["cropTop","cropBottom","cropLeft","cropRight"]) {
  const slider = $(key), output = $(`${key}Out`);
  if (!slider || !output) continue;
  const field = document.createElement("input");
  field.type="number"; field.min="0"; field.max="95"; field.step="0.01";
  field.className="crop-number"; field.id=`${key}Exact`; field.setAttribute("aria-label",`${output.parentElement.textContent.split("0%")[0]}百分比`);
  output.insertAdjacentElement("afterend",field);
  field.addEventListener("change",()=>{
    if (!guardUnlocked()) return;
    snapshot(); slider.value=field.value; slider.oninput({target:slider}); updateInspector();
  });
}
$("selectionBox").addEventListener("pointerdown",event=>{
  const handle = event.target.closest("[data-crop-handle]");
  if (!handle) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (!guardUnlocked()) return;
  snapshot();
  const object = currentObject(), box = $("selectionBox");
  const matrix = new DOMMatrix(getComputedStyle(box).transform);
  const zoom = Math.max(.25,Number(state.canvasZoom||1));
  const bounds = cropContentBounds(selectedCropElement(),object);
  cropPointer = {pointer:event.pointerId,object,side:handle.dataset.cropHandle,x:event.clientX,y:event.clientY,
    width:bounds.width,height:bounds.height,inverse:matrix.inverse(),zoom,initial:cloneClipData(object)};
  box.setPointerCapture?.(event.pointerId);
},true);
function applyCropPointer(event) {
  const drag = cropPointer;
  if (!drag || drag.pointer !== event.pointerId) return;
  const dx = (event.clientX-drag.x)/drag.zoom, dy = (event.clientY-drag.y)/drag.zoom;
  const fine = event.shiftKey ? .1 : 1;
  const x = (drag.inverse.a*dx+drag.inverse.c*dy)/Math.max(1,drag.width)*100*fine;
  const y = (drag.inverse.b*dx+drag.inverse.d*dy)/Math.max(1,drag.height)*100*fine;
  for (const [side,key,opposite,delta] of [["n","cropTop","cropBottom",y],["s","cropBottom","cropTop",-y],["w","cropLeft","cropRight",x],["e","cropRight","cropLeft",-x]]) {
    if (drag.side.includes(side)) drag.object[key] = Math.round(clamp(Number(drag.initial[key]||0)+delta,0,95-Number(drag.initial[opposite]||0))*10000)/10000;
  }
  renderPreviewObjects(); updateInspector(); syncCropHandles();
}
window.addEventListener("pointermove",applyCropPointer);
window.addEventListener("pointerup",event=>{
  if (!cropPointer || cropPointer.pointer!==event.pointerId) return;
  applyCropPointer(event); cropPointer=null; queueAutosave();
});
window.addEventListener("pointercancel",()=>{ if(cropPointer) { Object.assign(cropPointer.object,cropPointer.initial); cropPointer=null; renderAll(); } });

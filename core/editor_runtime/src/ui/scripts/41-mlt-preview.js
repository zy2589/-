(() => {
  let generation = 0;
  let pendingTimer = 0;
  let inFlight = false;
  let pendingTime = null;

  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const hasActiveNumbers = value => {
    if (Array.isArray(value)) return value.some(hasActiveNumbers);
    if (!value || typeof value !== "object") return typeof value === "number" && Math.abs(value) > 0.000001;
    return Object.values(value).some(hasActiveNumbers);
  };
  const identityTransform = value => {
    const item = value || {};
    return Math.abs(number(item.x)) < .001 && Math.abs(number(item.y)) < .001 &&
      Math.abs(number(item.scale, 1) - 1) < .001 && Math.abs(number(item.rotation)) < .001 &&
      Math.abs(number(item.opacity, 1) - 1) < .001 &&
      [item.cropTop, item.cropBottom, item.cropLeft, item.cropRight].every(value => Math.abs(number(value)) < .001);
  };

  function clear() {
    generation++;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = 0;
    pendingTime = null;
    const image = document.getElementById("mltTimelineFrame");
    const layer = document.getElementById("previewClipLayer");
    if (image) image.hidden = true;
    layer?.classList.remove("mlt-rendered-preview");
  }

  function compilePreview(time) {
    if (!state.video?.path || state.video.missing || !window.ClipAssistantMlt ||
        !window.chrome?.webview || !state.trackOrder?.length) return null;
    if ((state.images || []).length || (state.titles || []).length ||
        (state.spliceRegions || []).length || (state.spliceLayout && state.spliceLayout !== "free") ||
        hasActiveNumbers(state.color) || hasActiveNumbers(state.beauty) ||
        Math.abs(number(state.audio?.speed, 1) - 1) > .0001) return null;
    const compounds = state.compoundClips || [];
    if (compounds.some(group => !identityTransform(group.transform))) return null;
    const compoundIds = new Set(compounds.map(group => String(group.id)));

    const fps = Math.max(1, number(timelineFrameRate(), 30));
    const mainClipsForPreview = mainClips();
    if (mainClipsForPreview.some(clip => {
      const settings = mainVideoSettings(clip, false) || {};
      return !identityTransform(settings) || (settings.animation && settings.animation !== "none") ||
        (Array.isArray(settings.keyframes) && settings.keyframes.length > 0);
    })) return null;
    const sourceVideoLayers = state.videoLayers || [];
    if (sourceVideoLayers.some(item => (item.compoundId && !compoundIds.has(String(item.compoundId))) || item.spliceRegion ||
        (item.splicePlaybackMode && !["normal-audio", "normal-muted"].includes(item.splicePlaybackMode)) ||
        (item.blendMode && item.blendMode !== "normal") || (item.animation && item.animation !== "none") ||
        (Array.isArray(item.keyframes) && item.keyframes.length > 0) || !identityTransform(item) ||
        hasActiveNumbers(item.color))) return null;
    const videoLayers = sourceVideoLayers.map(item => ({
      path: item.path || item.originalPath || "",
      start: item.start,
      end: item.end,
      sourceStart: item.sourceStart,
      sourceEnd: item.sourceEnd,
      trackId: item.trackId || "video",
      x: item.x || 0,
      y: item.y || 0,
      scale: item.scale || 1,
      opacity: item.opacity ?? 1,
      rotation: item.rotation || 0,
      cropTop: number(item.cropTop),
      cropBottom: number(item.cropBottom),
      cropLeft: number(item.cropLeft),
      cropRight: number(item.cropRight),
      color: item.color || {},
      compoundId: item.compoundId || "",
      compoundStackOrder: number(item.compoundStackOrder),
    }));

    const normalized = normalizeExportFrameBoundaries(mainClipsForPreview, fps).clips;
    const clips = normalized.map(clip => ({
      ...clip,
      path: state.video.path,
      trackId: state.mainVideoTrackMap?.[clip.id] || "video",
      settings: { color: {} },
    }));
    const duration = Math.max(.001, number(visibleTimelineDuration(), state.duration || 0));
    const compiled = window.ClipAssistantMlt.compile({
      inputPath: state.video.path,
      width: Math.max(16, number(state.width, 1920)),
      height: Math.max(16, number(state.height, 1080)),
      fps,
      outputDuration: duration,
      trackOrder: state.trackOrder,
      trackVisibility: effectiveTrackVisibility(),
      mainVideoClips: clips,
      videoLayers,
      mainTimelineOffset: 0,
      audio: { speed: 1 },
      includeVideo: true,
      includeAudio: false,
      format: "mp4",
      qualityMode: "balanced",
      colorSpace: "bt709",
      spliceLayout: "free",
      spliceRegions: [],
      compoundClips: compounds.map(group => ({
        id: group.id,
        transform: { ...(group.transform || {}) },
      })),
      removals: [],
      audioMutes: [],
      audioProcessingEnabled: false,
      denoise: { strength: 0 },
      beauty: {},
      blemishMarks: [],
      titles: [],
      captions: [],
      images: [],
    });
    if (!compiled.supported) return null;
    compiled.frameIndex = Math.max(0, Math.min(compiled.totalFrames - 1, Math.round(Math.max(0, time) * fps)));
    return compiled;
  }

  function request(time) {
    if (state.playing) { clear(); return; }
    generation++;
    pendingTime = number(time, state.currentTime);
    const image = document.getElementById("mltTimelineFrame");
    const layer = document.getElementById("previewClipLayer");
    if (image) image.hidden = true;
    layer?.classList.remove("mlt-rendered-preview");
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(runPendingPreview, 70);
  }

  async function runPendingPreview() {
      pendingTimer = 0;
      if (inFlight || pendingTime == null || state.playing) return;
      const requestGeneration = generation;
      const time = pendingTime;
      pendingTime = null;
      inFlight = true;
      let compiled;
      try { compiled = compilePreview(number(time, state.currentTime)); }
      catch (error) { console.warn("MLT 预览时间线编译失败", error); }
      if (!compiled) {
        const image = document.getElementById("mltTimelineFrame");
        const layer = document.getElementById("previewClipLayer");
        if (image) image.hidden = true;
        layer?.classList.remove("mlt-rendered-preview");
        inFlight = false;
        schedulePendingPreview();
        return;
      }
      try {
        const reply = await window.__desktopCall("mltPreviewFrame", compiled, 60000);
        if (requestGeneration !== generation || state.playing) return;
        if (!reply?.ok || !reply.value?.data) throw new Error(reply?.error?.message || "MLT 未返回预览帧");
        const image = document.getElementById("mltTimelineFrame");
        const layer = document.getElementById("previewClipLayer");
        if (!image || !layer) return;
        image.src = `data:image/jpeg;base64,${reply.value.data}`;
        if (typeof image.decode === "function") await image.decode();
        if (requestGeneration !== generation || state.playing) return;
        image.hidden = false;
        layer.classList.add("mlt-rendered-preview");
      } catch (error) {
        if (requestGeneration !== generation) return;
        const image = document.getElementById("mltTimelineFrame");
        const layer = document.getElementById("previewClipLayer");
        if (image) image.hidden = true;
        layer?.classList.remove("mlt-rendered-preview");
        console.warn("MLT 本地帧预览不可用，保留当前预览", error);
      } finally {
        inFlight = false;
        schedulePendingPreview();
      }
  }

  function schedulePendingPreview() {
    if (pendingTime == null || pendingTimer || state.playing) return;
    pendingTimer = setTimeout(runPendingPreview, 20);
  }

  window.requestMltTimelinePreview = request;
  window.clearMltTimelinePreview = clear;
})();

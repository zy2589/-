(() => {
  const PLAYBACK_LABELS = {
    "normal-audio": "正常播放并带声音",
    "normal-muted": "正常播放但静音",
    "freeze-resume": "定格指定帧后继续播放",
    "freeze-hold": "定格指定帧保持到片段结束",
  };
  const DEFAULT_LAYOUT = "free";
  let freezeDecoder = null;
  let freezeRequest = "";

  function spliceLayoutRegions(layout = state.spliceLayout || DEFAULT_LAYOUT) {
    const ratio = clamp(Number(state.spliceRatio || 0.5), 0.2, 0.8);
    const pip = (id, name, x, y, w, h) => ({ id, name, x, y, w, h, shape: "rect", borderColor: "#68A9A2", borderWidth: 10, kind: "pip" });
    if (layout === "split-v") return [
      { id: "top", name: "上分区", x: 0, y: 0, w: 1, h: ratio, shape: "rect", kind: "pane" },
      { id: "bottom", name: "下分区", x: 0, y: ratio, w: 1, h: 1 - ratio, shape: "rect", kind: "pane" },
    ];
    if (layout === "top-two") return [
      { id: "upper-left", name: "上左分区", x: 0, y: 0, w: 0.5, h: ratio, shape: "rect", kind: "pane" },
      { id: "upper-right", name: "上右分区", x: 0.5, y: 0, w: 0.5, h: ratio, shape: "rect", kind: "pane" },
      { id: "bottom", name: "下分区", x: 0, y: ratio, w: 1, h: 1 - ratio, shape: "rect", kind: "pane" },
    ];
    if (layout === "top-one") return [
      { id: "top", name: "上分区", x: 0, y: 0, w: 1, h: ratio, shape: "rect", kind: "pane" },
      { id: "lower-left", name: "下左分区", x: 0, y: ratio, w: 0.5, h: 1 - ratio, shape: "rect", kind: "pane" },
      { id: "lower-right", name: "下右分区", x: 0.5, y: ratio, w: 0.5, h: 1 - ratio, shape: "rect", kind: "pane" },
    ];
    if (layout === "grid-four") return [
      { id: "cell-1", name: "左上", x: 0, y: 0, w: 0.5, h: 0.5, shape: "rect", kind: "pane" },
      { id: "cell-2", name: "右上", x: 0.5, y: 0, w: 0.5, h: 0.5, shape: "rect", kind: "pane" },
      { id: "cell-3", name: "左下", x: 0, y: 0.5, w: 0.5, h: 0.5, shape: "rect", kind: "pane" },
      { id: "cell-4", name: "右下", x: 0.5, y: 0.5, w: 0.5, h: 0.5, shape: "rect", kind: "pane" },
    ];
    if (layout === "diagonal") {
      const aspect = Number(state.width || 1080) / Math.max(1, Number(state.height || 1920));
      const delta = Math.tan(Number(state.spliceAngle || 0) * Math.PI / 180) * aspect / 2;
      const left = clamp(ratio - delta, 0.02, 0.98), right = clamp(ratio + delta, 0.02, 0.98);
      return [
        { id: "diagonal-top", name: "斜切上区", x: 0, y: 0, w: 1, h: 1, points: [[0,0],[1,0],[1,right],[0,left]], shape: "polygon", kind: "pane" },
        { id: "diagonal-bottom", name: "斜切下区", x: 0, y: 0, w: 1, h: 1, points: [[0,left],[1,right],[1,1],[0,1]], shape: "polygon", kind: "pane" },
      ];
    }
    if (layout === "pip") return [
      { id: "background", name: "背景全屏", x: 0, y: 0, w: 1, h: 1, shape: "rect", kind: "background" },
      pip("pip-1", "画中画 1", 0.58, 0.05, 0.36, 0.30),
    ];
    return [];
  }

  function spliceRegions() {
    const template = spliceLayoutRegions();
    const saved = Array.isArray(state.spliceRegions) ? state.spliceRegions : [];
    const normalizePip = (region) => {
      const w = clamp(Number(region.w || .34), .04, 1);
      const h = clamp(Number(region.h || .28), .04, 1);
      return { ...region, w, h, x: clamp(Number(region.x || 0), 0, 1 - w), y: clamp(Number(region.y || 0), 0, 1 - h) };
    };
    const merged = template.map((base) => {
      const old = saved.find((region) => region.id === base.id) || {};
      const savedBorderWidth = Number(old.borderWidth ?? base.borderWidth ?? 0);
      return {
        ...base,
        name: old.name || base.name,
        shape: old.shape || base.shape,
        borderColor: old.borderColor || base.borderColor,
        borderWidth: savedBorderWidth > 0 ? Math.max(10, savedBorderWidth) : 0,
        ...(base.kind === "pip" ? normalizePip({ x: Number(old.x ?? base.x), y: Number(old.y ?? base.y), w: Number(old.w ?? base.w), h: Number(old.h ?? base.h) }) : {}),
        points: base.points || null,
      };
    });
    for (const old of saved) if (old.kind === "pip" && !merged.some((region) => region.id === old.id)) merged.push(normalizePip(old));
    return merged;
  }

  function persistSpliceRegions() {
    state.spliceRegions = spliceRegions();
  }

  function geometryPoints(region) {
    if (Array.isArray(region?.points) && region.points.length >= 3) return region.points;
    const x = Number(region?.x || 0), y = Number(region?.y || 0), w = Number(region?.w || 1), h = Number(region?.h || 1);
    const shape = region?.shape || "rect";
    if (shape === "circle" || shape === "ellipse") {
      const diameter = shape === "circle" ? Math.min(w * Number(state.width || 1080), h * Number(state.height || 1920)) : 0;
      const rx = shape === "circle" ? diameter / Math.max(1, Number(state.width || 1080)) / 2 : w / 2;
      const ry = shape === "circle" ? diameter / Math.max(1, Number(state.height || 1920)) / 2 : h / 2;
      return Array.from({ length: 48 }, (_, index) => {
        const angle = index / 48 * Math.PI * 2;
        return [x + w / 2 + Math.cos(angle) * rx, y + h / 2 + Math.sin(angle) * ry];
      });
    }
    if (shape === "square") {
      const side = Math.min(w * Number(state.width || 1080), h * Number(state.height || 1920));
      const sw = side / Math.max(1, Number(state.width || 1080)), sh = side / Math.max(1, Number(state.height || 1920));
      return [[x+(w-sw)/2,y+(h-sh)/2],[x+(w+sw)/2,y+(h-sh)/2],[x+(w+sw)/2,y+(h+sh)/2],[x+(w-sw)/2,y+(h+sh)/2]];
    }
    if (shape === "rounded") {
      const radius = Math.min(w, h) * .15, points = [];
      for (const [cx, cy, start] of [[x+w-radius,y+radius,-Math.PI/2],[x+w-radius,y+h-radius,0],[x+radius,y+h-radius,Math.PI/2],[x+radius,y+radius,Math.PI]])
        for (let step = 0; step <= 8; step++) { const angle = start + step / 8 * Math.PI / 2; points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]); }
      return points;
    }
    if (shape === "diamond") return [[x + w / 2,y],[x + w,y + h / 2],[x + w / 2,y + h],[x,y + h / 2]];
    if (shape === "triangle") return [[x + w / 2,y],[x + w,y + h],[x,y + h]];
    if (shape === "trapezoid") return [[x + w * .2,y],[x + w * .8,y],[x + w,y + h],[x,y + h]];
    if (shape === "pentagon" || shape === "hexagon" || shape === "star") {
      const count = shape === "pentagon" ? 5 : shape === "hexagon" ? 6 : 10;
      return Array.from({ length: count }, (_, index) => {
        const angle = -Math.PI / 2 + index / count * Math.PI * 2;
        const radius = shape === "star" && index % 2 ? .22 : .5;
        return [x + w / 2 + Math.cos(angle) * w * radius, y + h / 2 + Math.sin(angle) * h * radius];
      });
    }
    return region?.points || [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  }

  function selectedVideoTarget() {
    const selected = state.selected || {};
    if (selected.type === "video" && state.video) {
      const clip = selected.id === "main" ? activeMainVideoClip() : mainClips().find((item) => item.id === selected.id);
      if (!clip) return null;
      return { type: "main", clip, settings: mainVideoSettings(clip), media: state.video };
    }
    if (selected.type === "videolayer") {
      const clip = state.videoLayers.find((item) => item.id === selected.id);
      if (clip) return { type: "layer", clip, settings: clip, media: clip };
    }
    return null;
  }

  function spliceMode(item) { return PLAYBACK_LABELS[item?.splicePlaybackMode] ? item.splicePlaybackMode : "normal-audio"; }
  function spliceFreezeFrame(item) { return Math.max(0, Number(item?.spliceFreezeFrame ?? item?.sourceStart ?? 0)); }
  function spliceFreezeUntil(item) { return Math.max(Number(item?.start || 0), Number(item?.spliceFreezeUntil ?? item?.start ?? 0)); }
  function spliceShouldFreeze(item, time = state.currentTime) {
    const mode = spliceMode(item);
    return mode === "freeze-hold" || (mode === "freeze-resume" && Number(time) < spliceFreezeUntil(item));
  }
  function spliceShouldMute(item, time = state.currentTime) {
    const mode = spliceMode(item);
    return mode === "normal-muted" || mode === "freeze-hold" || (mode === "freeze-resume" && Number(time) < spliceFreezeUntil(item));
  }
  function spliceLayerSourceTime(item, time = state.currentTime) {
    if (spliceShouldFreeze(item, time)) return spliceFreezeFrame(item);
    const rate = editRate(item, Number(state.audio.speed || 1));
    return Math.max(0, Number(item.sourceStart || 0) + Math.max(0, Number(time) - Number(item.start || 0)) * rate);
  }

  function spliceVideoTrackOrder() {
    const remaining = new Set((state.videoLayers || []).map((clip) => String(clip.trackId || "")).filter(Boolean));
    const ordered = [];
    for (const id of state.trackOrder || []) {
      const key = String(id);
      if (remaining.delete(key)) ordered.push(key);
    }
    return [...ordered, ...[...remaining].sort()];
  }

  function autoSpliceRegion(target) {
    const regions = spliceRegions();
    if (!regions.length) return null;
    const savedId = target?.settings?.spliceRegionId || target?.clip?.spliceRegionId || "auto";
    const imageClip = target?.media?.kind === "image" || (target?.clip?.id && state.images?.some((item) => item.id === target.clip.id));
    if (imageClip && (target?.settings?.spliceCanvasOverlay || target?.clip?.spliceCanvasOverlay)) return null;
    if (imageClip && savedId === "auto") return null;
    if (imageClip && savedId !== "auto") {
      const asset = state.libraryAssets?.find((item) => item.id === target?.clip?.libraryId);
      const capturedRegionId = asset?.spliceCaptureSettings?.spliceRegionId || "";
      if (savedId !== capturedRegionId) return null;
    }
    if (savedId !== "auto") return regions.find((region) => region.id === savedId) || regions[0];
    const trackOrder = spliceVideoTrackOrder();
    const index = target?.type === "main"
      ? 0
      : Math.max(1, trackOrder.indexOf(String(target?.clip?.trackId || "")) + 1);
    return regions[Math.min(Math.max(0, index), regions.length - 1)] || null;
  }

  function splicePreviewStyle(target, sourceWidth = 0, sourceHeight = 0) {
    const transform = target?.settings || target?.clip || {};
    const region = autoSpliceRegion(target);
    const fw = Number(state.width || 1080), fh = Number(state.height || 1920);
    const px = ($("frame")?.clientWidth || 1) / fw, py = ($("frame")?.clientHeight || 1) / fh;
    if (!region || (state.spliceLayout === "free" && region.kind !== "pip")) {
      const baseTranslate = target?.type === "layer"
        ? `translate(calc(-50% + ${Number(transform.x || 0) * px}px),calc(-50% + ${Number(transform.y || 0) * py}px))`
        : `translate(${Number(transform.x || 0) * px}px,${Number(transform.y || 0) * py}px)`;
      return {
        transform: `${baseTranslate} rotate(${Number(transform.rotation || 0)}deg) scale(${Number(transform.scale || 1)})`,
        clipPath: previewCropMask(transform, target?.type === "main" ? getActiveVideo() : null),
        region: null,
      };
    }
    let regionWidth = Math.max(.001, Number(region.w || 1)), regionHeight = Math.max(.001, Number(region.h || 1));
    // The split divider only changes the pane fit. User x/y/scale values stay
    // as independent offsets, so resizing a pane never erases their framing.
    const srcW = Number(sourceWidth || transform.sourceWidth || 0), srcH = Number(sourceHeight || transform.sourceHeight || 0);
    let fit = 1;
    if (srcW > 0 && srcH > 0 && !region.points) {
      const base = Math.min(fw / srcW, fh / srcH);
      fit = Math.max(regionWidth * fw / (srcW * base), regionHeight * fh / (srcH * base));
    }
    const x = (Number(region.x || 0) + regionWidth / 2 - .5) * fw + Number(transform.x || 0);
    const y = (Number(region.y || 0) + regionHeight / 2 - .5) * fh + Number(transform.y || 0);
    const scale = fit * Number(transform.scale || 1);
    const rotation = Number(transform.rotation || 0) * Math.PI / 180;
    const cosine = Math.cos(rotation), sine = Math.sin(rotation);
    const points = geometryPoints(region).map(([gx, gy]) => {
      const dx = ((gx - .5) * fw - x) / Math.max(.05, scale);
      const dy = ((gy - .5) * fh - y) / Math.max(.05, scale);
      const localX = (dx * cosine + dy * sine) / fw * 100 + 50;
      const localY = (-dx * sine + dy * cosine) / fh * 100 + 50;
      return [localX, localY];
    });
    const cropLeft = clamp(Number(transform.cropLeft || 0), 0, 95),
      cropRight = clamp(Number(transform.cropRight || 0), 0, 95),
      cropTop = clamp(Number(transform.cropTop || 0), 0, 95),
      cropBottom = clamp(Number(transform.cropBottom || 0), 0, 95);
    const containScale = srcW > 0 && srcH > 0 ? Math.min(fw / srcW, fh / srcH) : 0,
      contentWidth = containScale ? srcW * containScale / fw * 100 : 100,
      contentHeight = containScale ? srcH * containScale / fh * 100 : 100,
      contentLeft = (100 - contentWidth) / 2,
      contentTop = (100 - contentHeight) / 2;
    const clipPolygon = (polygon, left, top, right, bottom) => {
      const edges = [
        { inside: p => p[0] >= left, intersect: (a,b) => [left, a[1] + (b[1]-a[1]) * (left-a[0]) / ((b[0]-a[0]) || 1e-9)] },
        { inside: p => p[0] <= right, intersect: (a,b) => [right, a[1] + (b[1]-a[1]) * (right-a[0]) / ((b[0]-a[0]) || 1e-9)] },
        { inside: p => p[1] >= top, intersect: (a,b) => [a[0] + (b[0]-a[0]) * (top-a[1]) / ((b[1]-a[1]) || 1e-9), top] },
        { inside: p => p[1] <= bottom, intersect: (a,b) => [a[0] + (b[0]-a[0]) * (bottom-a[1]) / ((b[1]-a[1]) || 1e-9), bottom] },
      ];
      let result = polygon;
      for (const edge of edges) {
        const input = result;
        result = [];
        if (!input.length) break;
        let previous = input[input.length - 1], previousInside = edge.inside(previous);
        for (const current of input) {
          const currentInside = edge.inside(current);
          if (currentInside !== previousInside) result.push(edge.intersect(previous, current));
          if (currentInside) result.push(current);
          previous = current; previousInside = currentInside;
        }
      }
      return result;
    };
    const cropActive = cropLeft || cropRight || cropTop || cropBottom;
    const clippedPoints = cropActive
      ? clipPolygon(
          points,
          contentLeft + contentWidth * cropLeft / 100,
          contentTop + contentHeight * cropTop / 100,
          contentLeft + contentWidth * (100-cropRight) / 100,
          contentTop + contentHeight * (100-cropBottom) / 100,
        )
      : points;
    const clipPath = clippedPoints.length >= 3
      ? `polygon(${clippedPoints.map(([pointX, pointY]) => `${pointX.toFixed(2)}% ${pointY.toFixed(2)}%`).join(",")})`
      : "polygon(50% 50%,50% 50%,50% 50%)";
    const regionTranslate = target?.type === "layer"
      ? `translate(calc(-50% + ${x * px}px),calc(-50% + ${y * py}px))`
      : `translate(${x * px}px,${y * py}px)`;
    return {
      transform: `${regionTranslate} rotate(${Number(transform.rotation || 0)}deg) scale(${scale})`,
      clipPath,
      region,
    };
  }

  function renderSpliceGuide() {
    const svg = $("spliceGuideLayer");
    if (!svg) return;
    const regions = spliceRegions();
    const active = state.spliceLayout !== "free" || regions.some((region) => region.kind === "pip");
    $("stage")?.classList.toggle("splice-layout-active", active);
    svg.classList.toggle("active", active);
    if (!active) { svg.innerHTML = ""; return; }
    const selectedId = state.spliceSelectedRegionId;
    const frameBounds = $("frame")?.getBoundingClientRect();
    const outputScale = Math.min(
      (frameBounds?.width || 0) / Math.max(1, Number(state.width || 1080)),
      (frameBounds?.height || 0) / Math.max(1, Number(state.height || 1920)),
    );
    const shapes = regions.map((region) => {
      const points = geometryPoints(region).map(([x,y]) => `${(x * 1000).toFixed(1)},${(y * 1000).toFixed(1)}`).join(" ");
      const stroke = region.kind === "pip"
        ? (Number(region.borderWidth || 0) > 0 ? region.borderColor || "#68A9A2" : "transparent")
        : "rgba(104,169,162,.88)";
      const width = region.kind === "pip"
        ? Math.max(region.id === selectedId ? 2 : 0, Number(region.borderWidth || 0) * outputScale)
        : Math.max(1.5, Number(region.borderWidth || 0) * 2.3);
      return `<polygon class="splice-guide-region${region.id === selectedId ? " selected" : ""}" data-region-id="${escapeHtml(region.id)}" data-region-kind="${escapeHtml(region.kind || "pane")}" points="${points}" stroke="${stroke}" stroke-width="${width}" fill="${region.kind === "pip" ? "rgba(104,169,162,.035)" : "rgba(104,169,162,.018)"}"/>`;
    });
    let separators = "";
    if (state.spliceLayout === "diagonal") {
      const [top, bottom] = regions;
      const points = top?.points || bottom?.points;
      if (points?.length) {
        const line = `M 0 ${(points[3][1] * 1000).toFixed(1)} L 1000 ${(points[2][1] * 1000).toFixed(1)}`;
        separators = `<path class="splice-guide-line splice-guide-divider-hit" data-splice-divider="true" d="${line}"/><path class="splice-guide-line" d="${line}"/>`;
      }
    } else if (["split-v", "top-two", "top-one"].includes(state.spliceLayout)) {
      const y = (Number(state.spliceRatio || .5) * 1000).toFixed(1);
      separators = `<path class="splice-guide-line splice-guide-divider-hit" data-splice-divider="true" d="M 0 ${y} L 1000 ${y}"/><path class="splice-guide-line" d="M 0 ${y} L 1000 ${y}"/>`;
    }
    svg.innerHTML = `${shapes.join("")}${separators}`;
  }

  function spliceRegionOccupied(region) {
    if (!region) return false;
    const time = Number(state.currentTime || 0);
    const main = activeMainVideoClip?.();
    if (main) {
      const track = state.mainVideoTrackMap?.[main.id] || "video";
      if (state.trackVisibility?.[track] !== false) {
        const target = { type: "main", clip: main, settings: mainVideoSettings(main), media: state.video };
        if (autoSpliceRegion(target)?.id === region.id) return true;
      }
    }
    for (const clip of state.videoLayers || []) {
      if (time < Number(clip.start || 0) || time >= Number(clip.end || 0)) continue;
      if (state.trackVisibility?.[clip.trackId] === false) continue;
      if (autoSpliceRegion({ type: "layer", clip, settings: clip, media: clip })?.id === region.id) return true;
    }
    return (state.images || []).some((image) => {
      if (time < Number(image.start || 0) || time >= Number(image.end || 0) || state.trackVisibility?.[image.trackId] === false) return false;
      if (image.spliceCanvasOverlay) return false;
      return autoSpliceRegion({ type: "layer", clip: image, settings: image, media: image })?.id === region.id;
    });
  }

  function spliceRegionAtPoint(clientX, clientY) {
    if (!spliceRegions().length) return "";
    const frame = $("frame");
    if (!frame) return "";
    const bounds = frame.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return "";
    const x = (clientX - bounds.left) / bounds.width;
    const y = (clientY - bounds.top) / bounds.height;
    const inside = (points) => {
      let hit = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi) hit = !hit;
      }
      return hit;
    };
    return [...spliceRegions()].reverse().find((region) => inside(geometryPoints(region)))?.id || "";
  }

  function spliceSelectionBounds(target) {
    const region = target ? autoSpliceRegion(target) : null;
    if (!region) return null;
    const points = geometryPoints(region);
    const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
    const left = Math.min(...xs), top = Math.min(...ys);
    return { x: left, y: top, w: Math.max(.001, Math.max(...xs) - left), h: Math.max(.001, Math.max(...ys) - top) };
  }

  function syncSplicePanel() {
    const regionSelect = $("spliceRegionSelect"), videoRegion = $("spliceVideoRegion");
    if (!regionSelect || !videoRegion) return;
    persistSpliceRegions();
    const regions = spliceRegions();
    let currentRegion = state.spliceSelectedRegionId || regions[0]?.id || "";
    if (!regions.some((region) => region.id === currentRegion)) currentRegion = "";
    if (state.spliceLayout === "pip" && !regions.some((region) => region.id === currentRegion && region.kind === "pip"))
      currentRegion = regions.find((region) => region.kind === "pip")?.id || currentRegion;
    state.spliceSelectedRegionId = currentRegion || regions[0]?.id || "";
    regionSelect.innerHTML = regions.map((region) => `<option value="${escapeHtml(region.id)}">${escapeHtml(region.name || region.id)}</option>`).join("");
    regionSelect.value = state.spliceSelectedRegionId || "";
    videoRegion.innerHTML = `<option value="auto">自动分配</option>${regions.map((region) => `<option value="${escapeHtml(region.id)}">${escapeHtml(region.name || region.id)}</option>`).join("")}`;
    const target = selectedVideoTarget();
    $("spliceSelectedVideo").textContent = target ? `${target.type === "main" ? "主视频" : "叠加视频"} · ${String(target.media?.name || target.media?.path || "视频片段").split(/[\\/]/).at(-1)}` : "尚未选择视频片段";
    const mode = target ? spliceMode(target.settings) : "normal-audio";
    $("splicePlaybackMode").value = mode;
    $("splicePlaybackMode").disabled = !target;
    $("spliceCaptureStill").disabled = !target;
    document.querySelectorAll("[data-splice-quick-mode]").forEach((button) => {
      button.disabled = !target;
      button.classList.toggle("active", !!target && button.dataset.spliceQuickMode === mode);
    });
    $("spliceFreezeControls").hidden = !target || !mode.startsWith("freeze-");
    $("spliceResumeControl").hidden = mode !== "freeze-resume";
    $("spliceFreezeFrame").disabled = !target || !mode.startsWith("freeze-");
    $("spliceCaptureFreezeFrame").disabled = !target || !mode.startsWith("freeze-");
    $("spliceFreezeUntil").disabled = !target || mode !== "freeze-resume";
    $("spliceFreezeFrameRange").disabled = !target || !mode.startsWith("freeze-");
    $("spliceFreezeUntilRange").disabled = !target || mode !== "freeze-resume";
    if (target) {
      const clip = target.clip;
      const frameValue = Number(target.settings.spliceFreezeFrame ?? clip.sourceStart ?? 0);
      const untilValue = Number(target.settings.spliceFreezeUntil ?? (clip.start + Math.min(2, clip.end - clip.start)));
      const frameStep = Math.max(.001, Number(frameDuration?.() || 1 / 30));
      const sourceDuration = Math.max(frameValue, Number(target.media?.duration || clip.sourceEnd || frameValue + 1));
      $("spliceFreezeFrame").max = String(sourceDuration);
      $("spliceFreezeFrame").step = String(frameStep);
      $("spliceFreezeFrame").value = frameValue.toFixed(3);
      $("spliceFreezeFrameRange").min = "0";
      $("spliceFreezeFrameRange").max = String(sourceDuration);
      $("spliceFreezeFrameRange").step = String(frameStep);
      $("spliceFreezeFrameRange").value = String(clamp(frameValue, 0, sourceDuration));
      $("spliceFreezeFrameValue").textContent = `${frameValue.toFixed(3)} 秒`;
      $("spliceFreezeUntil").min = String(Number(clip.start || 0));
      $("spliceFreezeUntil").max = String(Number(clip.end || clip.start || 0));
      $("spliceFreezeUntil").step = String(frameStep);
      $("spliceFreezeUntil").value = untilValue.toFixed(3);
      $("spliceFreezeUntilRange").min = String(Number(clip.start || 0));
      $("spliceFreezeUntilRange").max = String(Number(clip.end || clip.start || 0));
      $("spliceFreezeUntilRange").step = String(frameStep);
      $("spliceFreezeUntilRange").value = String(clamp(untilValue, Number(clip.start || 0), Number(clip.end || clip.start || 0)));
      $("spliceFreezeUntilValue").textContent = `${untilValue.toFixed(3)} 秒`;
      const region = autoSpliceRegion(target);
      videoRegion.value = target.settings.spliceRegionId || "auto";
      if (!regions.some((entry) => entry.id === videoRegion.value) && videoRegion.value !== "auto") videoRegion.value = "auto";
      if (regionSelect.value !== state.spliceSelectedRegionId && state.spliceSelectedRegionId) regionSelect.value = state.spliceSelectedRegionId;
    } else videoRegion.value = "auto";
    const selectedRegion = regions.find((region) => region.id === state.spliceSelectedRegionId);
    if (selectedRegion) {
      $("spliceRegionName").value = selectedRegion.name || "";
      $("spliceShape").value = selectedRegion.shape || "rect";
      $("spliceBorderColor").value = selectedRegion.borderColor || "#68A9A2";
      $("spliceBorderWidth").value = Number(selectedRegion.borderWidth || 0);
      $("spliceBorderWidthRange").value = Number(selectedRegion.borderWidth || 0);
      $("spliceBorderWidthValue").textContent = `${Number(selectedRegion.borderWidth || 0)} px`;
      const isPip = selectedRegion.kind === "pip";
      $("spliceShape").disabled = !isPip;
      $("spliceBorderColor").disabled = !isPip;
      $("spliceBorderWidth").disabled = !isPip;
      $("spliceBorderWidthRange").disabled = !isPip;
    } else {
      $("spliceShape").disabled = true;
      $("spliceBorderColor").disabled = true;
      $("spliceBorderWidth").disabled = true;
      $("spliceBorderWidthRange").disabled = true;
    }
    document.querySelectorAll("[data-splice-layout]").forEach((button) => button.classList.toggle("active", button.dataset.spliceLayout === state.spliceLayout));
    $("spliceRatio").value = Math.round(Number(state.spliceRatio || .5) * 100);
    $("spliceRatioValue").textContent = `${$("spliceRatio").value} / ${100 - Number($("spliceRatio").value)}`;
    $("spliceAngle").value = Number(state.spliceAngle || 0);
    $("spliceAngleRange").value = Number(state.spliceAngle || 0);
    $("spliceAngleValue").textContent = `${Number(state.spliceAngle || 0)}°`;
    renderSpliceGuide();
  }

  function updateSelectedSpliceTarget(update) {
    const target = selectedVideoTarget();
    if (!target) { toast("请先在时间轴或预览画面中选中一个视频片段。"); return false; }
    Object.assign(target.settings, update);
    if (target.type === "layer") Object.assign(target.clip, update);
    queueAutosave();
    syncSplicePanel();
    renderAll();
    return true;
  }

  function setFreezeParameter(key, rawValue) {
    const target = selectedVideoTarget();
    if (!target) return;
    const isFrame = key === "spliceFreezeFrame";
    const min = isFrame ? 0 : Number(target.clip.start || 0);
    const max = isFrame
      ? Math.max(min, Number(target.media?.duration || target.clip.sourceEnd || rawValue || 0))
      : Math.max(min, Number(target.clip.end || target.clip.start || 0));
    const value = clamp(Number(rawValue || 0), min, max);
    target.settings[key] = value;
    if (target.type === "layer") target.clip[key] = value;
    const input = $(isFrame ? "spliceFreezeFrame" : "spliceFreezeUntil");
    const range = $(isFrame ? "spliceFreezeFrameRange" : "spliceFreezeUntilRange");
    const output = $(isFrame ? "spliceFreezeFrameValue" : "spliceFreezeUntilValue");
    input.value = value.toFixed(3);
    range.value = String(value);
    output.textContent = `${value.toFixed(3)} 秒`;
    queueAutosave();
    renderPreviewObjects();
    if (target.type === "main") updateFreezeCanvas();
  }

  function applySpliceLayout(layout) {
    const old = spliceRegions();
    state.spliceLayout = layout;
    const next = spliceLayoutRegions(layout).map((region) => {
      const previous = old.find((item) => item.id === region.id);
      return previous ? { ...region, name: previous.name, shape: previous.shape || region.shape, borderColor: previous.borderColor, borderWidth: previous.borderWidth } : region;
    });
    for (const region of old) if (region.kind === "pip" && layout !== "pip" && !next.some((item) => item.id === region.id)) next.push(region);
    state.spliceRegions = next;
    state.spliceSelectedRegionId = (layout === "pip"
      ? next.find((region) => region.kind === "pip")
      : next[0])?.id || "";
    persistSpliceRegions();
    renderAll();
    toast(`已切换到${document.querySelector(`[data-splice-layout="${layout}"]`)?.textContent || "所选布局"}，预览分区已更新。`);
  }

  function addSplicePip() {
    const regions = spliceRegions();
    const index = regions.filter((region) => region.kind === "pip").length + 1;
    const pipWidth = .34, pipHeight = .28, gap = .035;
    const occupied = regions.filter((item) => item.kind === "pip");
    const candidates = [];
    for (let y = .02; y <= 1 - pipHeight + .001; y += pipHeight + gap)
      for (let x = .02; x <= 1 - pipWidth + .001; x += pipWidth + gap)
        candidates.push({ x: Math.min(x, 1 - pipWidth), y: Math.min(y, 1 - pipHeight) });
    candidates.push({ x: .58, y: .05 }, { x: .04, y: .36 }, { x: .58, y: .36 }, { x: .04, y: .68 }, { x: .58, y: .68 });
    const overlap = (candidate) => occupied.reduce((sum, item) => {
      const width = Math.max(0, Math.min(candidate.x + pipWidth, item.x + item.w) - Math.max(candidate.x, item.x));
      const height = Math.max(0, Math.min(candidate.y + pipHeight, item.y + item.h) - Math.max(candidate.y, item.y));
      return sum + width * height;
    }, 0);
    candidates.sort((left, right) => overlap(left) - overlap(right));
    const position = candidates[0] || { x: .04, y: .04 };
    const region = { id: `pip-${index}`, name: `画中画 ${index}`, ...position, w: pipWidth, h: pipHeight, shape: "rect", borderColor: "#68A9A2", borderWidth: 10, kind: "pip" };
    state.spliceRegions = [...regions, region];
    state.spliceSelectedRegionId = region.id;
    if (state.spliceLayout === "free") state.spliceLayout = "pip";
    renderAll();
  }

  function updateFreezeCanvas(target, activeTransform) {
    const canvas = $("spliceFreezePreviewCanvas");
    if (!canvas) return;
    const clip = activeMainVideoClip();
    const settings = clip ? mainVideoSettings(clip) : null;
    target = clip ? { type: "main", clip, settings, media: state.video } : null;
    const visible = !!target && target.type === "main" && !!(state.video?.url || state.video?.path) && !state.video?.missing && spliceShouldFreeze(settings, state.currentTime) && state.trackVisibility?.[state.mainVideoTrackMap?.[clip.id] || "video"] !== false;
    canvas.style.visibility = visible ? "visible" : "hidden";
    if (!visible) { freezeRequest = ""; return; }
    const sourceTime = spliceFreezeFrame(settings);
    const style = splicePreviewStyle(target, freezeDecoder?.videoWidth || 0, freezeDecoder?.videoHeight || 0);
    canvas.style.transform = style.transform;
    canvas.style.clipPath = style.clipPath;
    canvas.style.mixBlendMode = activeTransform?.blendMode || "normal";
    canvas.style.opacity = String(activeTransform?.opacity ?? 1);
    canvas.style.zIndex = String(Number($("video")?.style.zIndex || 1) + .5);
    const key = `${state.video?.url || ""}|${sourceTime.toFixed(4)}|${canvas.width}x${canvas.height}`;
    if (key === freezeRequest) return;
    freezeRequest = key;
    if (!state.video?.url) return;
    if (!freezeDecoder) {
      freezeDecoder = document.createElement("video");
      freezeDecoder.muted = true;
      freezeDecoder.preload = "auto";
      freezeDecoder.playsInline = true;
      freezeDecoder.addEventListener("loadedmetadata", () => { if (freezeRequest) { try { freezeDecoder.currentTime = Number(freezeRequest.split("|")[1]); } catch {} } });
      freezeDecoder.addEventListener("seeked", drawFreezeFrame);
      freezeDecoder.addEventListener("loadeddata", drawFreezeFrame);
    }
    freezeDecoder.dataset.spliceSourceUrl = state.video.url;
    if (freezeDecoder.src !== state.video.url) { freezeDecoder.src = state.video.url; freezeDecoder.load(); }
    else if (freezeDecoder.readyState >= 1 && Math.abs(Number(freezeDecoder.currentTime || 0) - sourceTime) > .015) {
      try { freezeDecoder.currentTime = sourceTime; } catch {}
    } else if (freezeDecoder.readyState >= 2) drawFreezeFrame();
  }

  function drawFreezeFrame() {
    const canvas = $("spliceFreezePreviewCanvas");
    if (!canvas || !freezeDecoder || freezeDecoder.readyState < 2 || !canvas.isConnected) return;
    const clip = activeMainVideoClip();
    const settings = clip ? mainVideoSettings(clip) : null;
    if (!clip || !settings || !spliceShouldFreeze(settings, state.currentTime)) return;
    canvas.width = Math.max(1, Number(state.width || 1080));
    canvas.height = Math.max(1, Number(state.height || 1920));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fit = Math.min(canvas.width / freezeDecoder.videoWidth, canvas.height / freezeDecoder.videoHeight);
    const width = freezeDecoder.videoWidth * fit, height = freezeDecoder.videoHeight * fit;
    try { ctx.drawImage(freezeDecoder, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height); } catch { return; }
    const style = splicePreviewStyle({ type: "main", clip, settings }, freezeDecoder.videoWidth, freezeDecoder.videoHeight);
    canvas.style.transform = style.transform;
    canvas.style.clipPath = style.clipPath;
    canvas.style.visibility = "visible";
  }

  function installSpliceEvents() {
    const guide = $("spliceGuideLayer");
    let draggedPip = null;
    let draggedContent = null;
    let draggedDivider = null;
    const activeVisualInRegion = (regionId) => {
      const time = Number(state.currentTime || 0), candidates = [];
      let paintOrder = 0;
      const main = activeMainVideoClip?.();
      if (main && state.video && state.trackVisibility?.[state.mainVideoTrackMap?.[main.id] || "video"] !== false) {
        const settings = mainVideoSettings(main);
        const target = { type: "main", clip: main, settings, media: state.video };
        if (autoSpliceRegion(target)?.id === regionId)
          candidates.push({ type: "video", id: main.id, target, z: visualZ(state.mainVideoTrackMap?.[main.id] || "video"), order: paintOrder++ });
      }
      for (const clip of state.videoLayers || []) {
        if (time < Number(clip.start || 0) || time >= Number(clip.end || 0) || state.trackVisibility?.[clip.trackId] === false) continue;
        const target = { type: "layer", clip, settings: clip, media: clip };
        if (autoSpliceRegion(target)?.id === regionId)
          candidates.push({ type: "videolayer", id: clip.id, target, z: visualZ(clip.trackId), order: paintOrder++ });
      }
      for (const clip of state.images || []) {
        if (time < Number(clip.start || 0) || time >= Number(clip.end || 0) || state.trackVisibility?.[clip.trackId] === false) continue;
        const target = { type: "layer", clip, settings: clip, media: clip };
        if (autoSpliceRegion(target)?.id === regionId)
          candidates.push({ type: "image", id: clip.id, target, z: visualZ(clip.trackId), order: paintOrder++ });
      }
      return candidates.sort((left, right) => right.z - left.z || right.order - left.order)[0] || null;
    };
    const edgeDistance = (region, clientX, clientY, bounds) => {
      const points = geometryPoints(region).map(([x, y]) => [bounds.left + x * bounds.width, bounds.top + y * bounds.height]);
      let shortest = Infinity;
      for (let index = 0; index < points.length; index += 1) {
        const [ax, ay] = points[index], [bx, by] = points[(index + 1) % points.length];
        const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
        const ratio = length2 ? clamp(((clientX - ax) * dx + (clientY - ay) * dy) / length2, 0, 1) : 0;
        shortest = Math.min(shortest, Math.hypot(clientX - (ax + dx * ratio), clientY - (ay + dy * ratio)));
      }
      return shortest;
    };
    const refreshSplicePreview = () => {
      updatePreviewTransformOnly(false);
      for (const item of [...(state.videoLayers || []), ...(state.images || [])]) {
        if (state.currentTime < Number(item.start || 0) || state.currentTime >= Number(item.end || 0)) continue;
        const element = $("frame")?.querySelector(`[data-id="${CSS.escape(String(item.id))}"][data-type="${state.videoLayers.includes(item) ? "videolayer" : "image"}"]`);
        if (!element) continue;
        const style = splicePreviewStyle({ type: "layer", clip: item, settings: item, media: item }, element.videoWidth || element.naturalWidth || item.sourceWidth, element.videoHeight || element.naturalHeight || item.sourceHeight);
        if (state.images.includes(item)) applyAnimatedObjectStyle(element, item, style.transform);
        else element.style.transform = style.transform;
        if (style.clipPath) element.style.clipPath = style.clipPath;
      }
      window.updateSpliceMainFreezePreview?.();
      updateSelectionBox();
    };
    guide?.addEventListener("pointerdown", (event) => {
      if (event.target.closest?.("[data-splice-divider]")) {
        event.preventDefault();
        event.stopPropagation();
        draggedDivider = { pointerId: event.pointerId };
        guide.setPointerCapture?.(event.pointerId);
        return;
      }
      const target = event.target.closest?.('[data-region-kind="pip"]');
      if (!target) return;
      persistSpliceRegions();
      const region = state.spliceRegions.find((item) => item.id === target.dataset.regionId);
      if (!region) return;
      event.preventDefault();
      event.stopPropagation();
      state.spliceSelectedRegionId = region.id;
      const frameBounds = $("frame").getBoundingClientRect();
      const content = activeVisualInRegion(region.id);
      if (content) {
        window.syncPreviewTimelineSelection?.(content.type, content.id, true);
        const settings = content.target.settings;
        const moveFrame = edgeDistance(region, event.clientX, event.clientY, frameBounds) <= 12;
        snapshot();
        if (moveFrame) draggedPip = { pointerId: event.pointerId, region, startX: event.clientX, startY: event.clientY, x: Number(region.x || 0), y: Number(region.y || 0) };
        else draggedContent = { pointerId: event.pointerId, settings, startX: event.clientX, startY: event.clientY, x: Number(settings.x || 0), y: Number(settings.y || 0), type: content.type };
      } else {
        draggedPip = { pointerId: event.pointerId, region, startX: event.clientX, startY: event.clientY, x: Number(region.x || 0), y: Number(region.y || 0) };
      }
      guide.setPointerCapture?.(event.pointerId);
      syncSplicePanel();
      renderSpliceGuide();
    });
    guide?.addEventListener("pointermove", (event) => {
      if (draggedDivider?.pointerId === event.pointerId) {
        const bounds = $("frame").getBoundingClientRect();
        if (!bounds.height) return;
        state.spliceRatio = clamp((event.clientY - bounds.top) / bounds.height, .2, .8);
        persistSpliceRegions();
        const ratio = $("spliceRatio");
        if (ratio) ratio.value = String(Math.round(state.spliceRatio * 100));
        const value = $("spliceRatioValue");
        if (value) value.textContent = `${Math.round(state.spliceRatio * 100)} / ${100 - Math.round(state.spliceRatio * 100)}`;
        renderSpliceGuide();
        refreshSplicePreview();
        return;
      }
      if (draggedContent?.pointerId === event.pointerId) {
        const bounds = $("frame").getBoundingClientRect();
        draggedContent.settings.x = draggedContent.x + (event.clientX - draggedContent.startX) / Math.max(1, bounds.width) * Number(state.width || 1080);
        draggedContent.settings.y = draggedContent.y + (event.clientY - draggedContent.startY) / Math.max(1, bounds.height) * Number(state.height || 1920);
        window.syncPositionControlValue?.("X", draggedContent.settings.x);
        window.syncPositionControlValue?.("Y", draggedContent.settings.y);
        updatePreviewTransformOnly();
        return;
      }
      if (!draggedPip || draggedPip.pointerId !== event.pointerId) return;
      const bounds = $("frame").getBoundingClientRect();
      draggedPip.region.x = clamp(draggedPip.x + (event.clientX - draggedPip.startX) / Math.max(1, bounds.width), 0, 1 - Number(draggedPip.region.w || .3));
      draggedPip.region.y = clamp(draggedPip.y + (event.clientY - draggedPip.startY) / Math.max(1, bounds.height), 0, 1 - Number(draggedPip.region.h || .3));
      persistSpliceRegions();
      renderSpliceGuide();
      refreshSplicePreview();
    });
    const finishPipMove = (event) => {
      if (draggedDivider?.pointerId === event.pointerId) {
        draggedDivider = null;
        try { guide.releasePointerCapture?.(event.pointerId); } catch {}
        queueAutosave();
        return;
      }
      if (draggedPip?.pointerId !== event.pointerId && draggedContent?.pointerId !== event.pointerId) return;
      draggedPip = null;
      draggedContent = null;
      try { guide.releasePointerCapture?.(event.pointerId); } catch {}
      queueAutosave();
    };
    guide?.addEventListener("pointerup", finishPipMove);
    guide?.addEventListener("pointercancel", finishPipMove);
    document.querySelectorAll("[data-splice-layout]").forEach((button) => button.addEventListener("click", () => applySpliceLayout(button.dataset.spliceLayout)));
    $("spliceRatio")?.addEventListener("input", (event) => { state.spliceRatio = Number(event.target.value) / 100; persistSpliceRegions(); syncSplicePanel(); renderSpliceGuide(); refreshSplicePreview(); queueAutosave(); });
    const updateSpliceAngle = (event, commit = false) => {
      const raw = String(event.target.value || "");
      if (raw === "" || raw === "-") return;
      const angle = clamp(Number(raw), -80, 80);
      state.spliceAngle = angle;
      $("spliceAngle").value = String(angle);
      $("spliceAngleRange").value = String(angle);
      $("spliceAngleValue").textContent = `${angle}°`;
      if (Number(raw) !== angle) event.target.value = String(angle);
      persistSpliceRegions();
      renderSpliceGuide();
        refreshSplicePreview();
      queueAutosave();
      if (commit) renderAll();
    };
    $("spliceAngle")?.addEventListener("input", (event) => updateSpliceAngle(event));
    $("spliceAngle")?.addEventListener("change", (event) => updateSpliceAngle(event, true));
    $("spliceAngleRange")?.addEventListener("input", (event) => {
      $("spliceAngle").value = event.target.value;
      updateSpliceAngle(event);
    });
    $("spliceRegionSelect")?.addEventListener("change", (event) => { state.spliceSelectedRegionId = event.target.value; syncSplicePanel(); renderSpliceGuide(); });
    $("spliceRegionName")?.addEventListener("change", (event) => { persistSpliceRegions(); const region = state.spliceRegions.find((item) => item.id === state.spliceSelectedRegionId); if (region) { region.name = event.target.value.trim() || region.name; persistSpliceRegions(); renderAll(); } });
    $("spliceShape")?.addEventListener("change", (event) => { persistSpliceRegions(); const region = state.spliceRegions.find((item) => item.id === state.spliceSelectedRegionId); if (region) { region.shape = event.target.value; persistSpliceRegions(); renderSpliceGuide(); renderPreviewObjects(); queueAutosave(); } });
    $("spliceBorderColor")?.addEventListener("input", (event) => {
      persistSpliceRegions();
      const region = state.spliceRegions.find((item) => item.id === state.spliceSelectedRegionId);
      if (!region || region.kind !== "pip") return;
      region.borderColor = event.target.value;
      if (Number(region.borderWidth || 0) <= 0) region.borderWidth = 10;
      $("spliceBorderWidth").value = String(region.borderWidth);
      $("spliceBorderWidthRange").value = String(region.borderWidth);
      $("spliceBorderWidthValue").textContent = `${region.borderWidth} px`;
      persistSpliceRegions();
      renderSpliceGuide();
      queueAutosave();
    });
    const updateSpliceBorderWidth = (value) => {
      persistSpliceRegions();
      const region = state.spliceRegions.find((item) => item.id === state.spliceSelectedRegionId);
      if (!region) return;
      const requestedWidth = clamp(Number(value || 0), 0, 32);
      region.borderWidth = requestedWidth === 0 ? 0 : Math.max(10, requestedWidth);
      $("spliceBorderWidth").value = String(region.borderWidth);
      $("spliceBorderWidthRange").value = String(region.borderWidth);
      $("spliceBorderWidthValue").textContent = `${region.borderWidth} px`;
      persistSpliceRegions();
      renderSpliceGuide();
      queueAutosave();
    };
    $("spliceBorderWidth")?.addEventListener("input", (event) => updateSpliceBorderWidth(event.target.value));
    $("spliceBorderWidth")?.addEventListener("change", (event) => updateSpliceBorderWidth(event.target.value));
    $("spliceBorderWidthRange")?.addEventListener("input", (event) => updateSpliceBorderWidth(event.target.value));
    $("spliceVideoRegion")?.addEventListener("change", (event) => updateSelectedSpliceTarget({ spliceRegionId: event.target.value }));
    $("spliceAddPip")?.addEventListener("click", addSplicePip);
    $("spliceApplyLayout")?.addEventListener("click", () => { persistSpliceRegions(); renderAll(); toast("布局、时间轴预览与工程设置已同步。"); });
    const setSelectedPlaybackMode = (mode) => {
      const target = selectedVideoTarget(); if (!target) return;
      const update = { splicePlaybackMode: mode };
      if (mode.startsWith("freeze-")) {
        update.spliceFreezeFrame = Number(target.settings.spliceFreezeFrame ?? target.clip.sourceStart ?? 0);
        update.spliceFreezeUntil = Number(target.settings.spliceFreezeUntil ?? (target.clip.start + Math.min(2, target.clip.end - target.clip.start)));
      }
      updateSelectedSpliceTarget(update);
    };
    $("splicePlaybackMode")?.addEventListener("change", (event) => setSelectedPlaybackMode(event.target.value));
    document.querySelectorAll("[data-splice-quick-mode]").forEach((button) => button.addEventListener("click", () => setSelectedPlaybackMode(button.dataset.spliceQuickMode)));
    $("spliceCaptureStill")?.addEventListener("click", async () => {
      const target = selectedVideoTarget();
      if (!target) { toast("先在时间线上点选一个视频片段，再截取它的首帧。"); return; }
      const region = autoSpliceRegion(target);
      const sourcePath = target.media?.path || target.clip?.path;
      if (!sourcePath) { toast("找不到所选视频的源文件。"); return; }
      const sourceTime = Math.max(0, Number(target.clip?.sourceStart ?? target.settings?.sourceStart ?? 0));
      try {
        const still = await nativeCall("extractStill", { projectId: state.projectId, path: sourcePath, time: sourceTime });
        const asset = addLibraryAsset(still, "image");
        if (!asset) return;
        const transform = {};
        for (const key of ["x", "y", "scale", "rotation", "cropTop", "cropBottom", "cropLeft", "cropRight", "opacity", "blendMode"])
          if (target.settings[key] != null) transform[key] = target.settings[key];
        asset.spliceCaptureSettings = {
          ...transform,
          ...(region ? { spliceRegionId: region.id } : {}),
        };
        const trackId = target.type === "main"
          ? state.mainVideoTrackMap?.[target.clip.id] || "video"
          : String(target.clip.trackId || "video");
        const clipStart = Math.max(0, Number(target.clip.start || 0));
        const gap = typeof findTimelineGap === "function" && typeof timelineGapItems === "function"
          ? findTimelineGap(timelineGapItems(trackId), Math.max(0, clipStart - Math.max(0.01, frameDuration())))
          : null;
        if (gap && gap.duration >= frameDuration() - 0.001) {
          const placed = await importImage(asset, "gap", gap.start, trackId, region?.id || "", "overwrite", gap.duration);
          if (!placed) {
            renderAll();
            toast("首帧已存入素材区；前方空档未能自动填入，请检查该轨道是否锁定。");
            return;
          }
          toast(`已截取所选片段首帧，并填满前方 ${gap.duration.toFixed(2)} 秒空档。`);
        } else {
          renderAll();
          toast("首帧已存入素材区；所选片段前方没有空档。未覆盖其他片段。");
        }
        queueAutosave();
      } catch (error) { toast(error.message || "截取静帧失败。"); }
    });
    $("spliceFreezeFrame")?.addEventListener("input", (event) => { $("spliceFreezeFrameRange").value = event.target.value; $("spliceFreezeFrameValue").textContent = `${Number(event.target.value || 0).toFixed(3)} 秒`; freezeRequest = ""; });
    $("spliceFreezeFrame")?.addEventListener("change", (event) => setFreezeParameter("spliceFreezeFrame", event.target.value));
    $("spliceFreezeFrameRange")?.addEventListener("input", (event) => { freezeRequest = ""; setFreezeParameter("spliceFreezeFrame", event.target.value); });
    $("spliceFreezeUntil")?.addEventListener("input", (event) => { $("spliceFreezeUntilRange").value = event.target.value; $("spliceFreezeUntilValue").textContent = `${Number(event.target.value || 0).toFixed(3)} 秒`; });
    $("spliceFreezeUntil")?.addEventListener("change", (event) => setFreezeParameter("spliceFreezeUntil", event.target.value));
    $("spliceFreezeUntilRange")?.addEventListener("input", (event) => setFreezeParameter("spliceFreezeUntil", event.target.value));
    $("spliceCaptureFreezeFrame")?.addEventListener("click", () => {
      const target = selectedVideoTarget(); if (!target) return;
      const time = state.currentTime;
      const source = target.type === "main"
        ? Math.max(0, Number(getActiveVideo()?.currentTime ?? (Number(target.clip.sourceStart || 0) + Math.max(0, time - target.clip.start) * Number(state.audio.speed || 1))))
        : Math.max(0, Number(target.clip.sourceStart || 0) + Math.max(0, time - target.clip.start) * editRate(target.clip, Number(state.audio.speed || 1)));
      $("spliceFreezeFrame").value = source.toFixed(3);
      updateSelectedSpliceTarget({ spliceFreezeFrame: source });
    });
    document.querySelectorAll(".tab[data-inspect]").forEach((button) => button.addEventListener("click", () => setTimeout(syncSplicePanel, 0)));
    document.addEventListener("click", (event) => {
      const video = event.target.closest?.('.videoobject[data-type="video"],.layer-video-decoder[data-type="videolayer"]');
      if (!video) return;
      setTimeout(() => {
        const target = selectedVideoTarget();
        const region = target && autoSpliceRegion(target);
        if (region) state.spliceSelectedRegionId = region.id;
        syncSplicePanel();
        renderSpliceGuide();
        if (typeof updateSelectionBox === "function") updateSelectionBox();
      }, 0);
    });
  }

  window.spliceShouldFreeze = spliceShouldFreeze;
  window.spliceShouldMute = spliceShouldMute;
  window.spliceLayerSourceTime = spliceLayerSourceTime;
  window.splicePreviewStyle = splicePreviewStyle;
  window.spliceRegionAtPoint = spliceRegionAtPoint;
  window.spliceRegionName = (id) => spliceRegions().find((region) => region.id === id)?.name || "分区";
  window.spliceSelectionBounds = spliceSelectionBounds;
  window.spliceRegionForExport = (target) => {
    const region = autoSpliceRegion(target);
    return region ? { ...region, points: Array.isArray(region.points) ? region.points.map((point) => [...point]) : null } : null;
  };
  window.updateSpliceMainFreezePreview = updateFreezeCanvas;
  window.syncSplicePanel = syncSplicePanel;
  window.spliceMutedForVideoLayer = function (videoId, linkGroupId, time = state.currentTime) {
    const owner = state.videoLayers.find((item) => item.id === videoId || (linkGroupId && item.linkGroupId === linkGroupId));
    return owner ? spliceShouldMute(owner, time) : false;
  };
  installSpliceEvents();
  syncSplicePanel();
})();

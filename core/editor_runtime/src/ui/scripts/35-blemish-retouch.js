(() => {
  const canvas = $("blemishPreviewCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: false });
  const scratch = document.createElement("canvas");
  const scratchCtx = scratch.getContext("2d");
  const sourceCanvas = document.createElement("canvas");
  const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const analysisCanvas = document.createElement("canvas");
  const analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });
  let brushing = false;
  let deleting = false;
  let selectingFace = false;
  let faceDrag = null;
  let paintRequest = 0;
  let lastPaint = 0;
  let selectedMarkId = "";
  let tracking = null;
  const marks = () => Array.isArray(state.blemishMarks) ? state.blemishMarks : (state.blemishMarks = []);
  const faceRegion = () => state.blemishFaceRegion || null;
  const currentVideo = () => typeof getActiveVideo === "function" ? getActiveVideo() : $("video");
  const sortedKeys = (mark) => (Array.isArray(mark.keyframes) ? mark.keyframes : [])
    .filter((key) => Number.isFinite(Number(key.time)) && Number.isFinite(Number(key.x)) && Number.isFinite(Number(key.y)))
    .sort((a, b) => Number(a.time) - Number(b.time));
  function markAt(mark, time = Number(state.currentTime || 0)) {
    const keys = sortedKeys(mark);
    if (!keys.length) return { x: Number(mark.x || 0), y: Number(mark.y || 0) };
    if (time <= Number(keys[0].time)) return keys[0];
    if (time >= Number(keys.at(-1).time)) return keys.at(-1);
    const rightIndex = keys.findIndex((key) => Number(key.time) >= time);
    const left = keys[rightIndex - 1], right = keys[rightIndex];
    const ratio = (time - Number(left.time)) / Math.max(0.001, Number(right.time) - Number(left.time));
    return { x: Number(left.x) + (Number(right.x) - Number(left.x)) * ratio, y: Number(left.y) + (Number(right.y) - Number(left.y)) * ratio };
  }
  function saveMarks(label = "瑕疵修复") {
    queueAutosave();
    renderBlemishStatus();
    requestPaint();
    if (typeof toast === "function") toast(label + "已更新");
  }
  function renderBlemishStatus() {
    const count = marks().length;
    const status = $("blemishStatus");
    const region = faceRegion();
    const weakCount = tracking?.items.filter((item) => item.weakFrames >= 5).length || 0;
    if (status) status.textContent = tracking ? `正在跟踪修复${weakCount ? ` · ${weakCount} 处需要校正` : ""}` : selectingFace ? "拖动画出人脸选区" : deleting ? "点选要删除的修复点" : brushing ? "点击瑕疵添加修复点" : count ? `${count} 处待修复` : "就绪";
    const oneClick = $("blemishOneClick");
    if (oneClick) oneClick.textContent = "一键人像修图";
    const button = $("blemishBrush");
    if (button) {
      button.textContent = brushing ? "结束点选" : "开始点选";
      button.classList.toggle("primary", brushing);
    }
    $("blemishTrack").textContent = tracking ? "停止跟踪" : "跟踪全部修复点";
    $("blemishDeleteMode").textContent = deleting ? "结束删除" : "删除多余点";
    $("blemishFaceSelect").textContent = selectingFace ? "结束框选" : "框选人脸";
    canvas.classList.toggle("brushing", brushing || deleting || selectingFace);
    canvas.classList.toggle("active", brushing || deleting || selectingFace || count > 0);
    canvas.setAttribute("aria-label", brushing ? "瑕疵修复笔刷，点击新增瑕疵或校正所选标记" : "瑕疵修复预览");
  }
  function pointerPoint(event) {
    const video = currentVideo();
    if (!video || video.readyState < 2) return null;
    const rect = canvas.getBoundingClientRect();
    const contain = Math.min(rect.width / Math.max(1, video.videoWidth), rect.height / Math.max(1, video.videoHeight));
    const imageWidth = canvas.width * contain, imageHeight = canvas.height * contain;
    const imageLeft = rect.left + (rect.width - imageWidth) / 2, imageTop = rect.top + (rect.height - imageHeight) / 2;
    if (event.clientX < imageLeft || event.clientX > imageLeft + imageWidth || event.clientY < imageTop || event.clientY > imageTop + imageHeight) return null;
    return { x: Math.max(0, Math.min(1, (event.clientX - imageLeft) / imageWidth)), y: Math.max(0, Math.min(1, (event.clientY - imageTop) / imageHeight)) };
  }
  async function smartSelect({ automaticRegion = false, quiet = false } = {}) {
    const video = currentVideo();
    let region = faceRegion();
    if (!region && automaticRegion && video?.videoWidth && video?.videoHeight) {
      // Talking head footage is usually composed around the center. Keep this
      // first pass conservative; users can refine the region under More.
      region = { x: 0.07, y: 0.015, width: 0.86, height: 0.90 };
      state.blemishFaceRegion = region;
    }
    if (!region) { if (!quiet) toast("请先框选脸部，再智能选点"); return 0; }
    if (!video || video.readyState < 2 || state.playing) { if (!quiet) toast("请暂停在清晰的人脸画面后再智能选点"); return 0; }
    const scanScale = Math.min(1, 720 / Math.max(video.videoWidth || 1, video.videoHeight || 1));
    const width = Math.max(2, Math.round((video.videoWidth || canvas.width) * scanScale));
    const height = Math.max(2, Math.round((video.videoHeight || canvas.height) * scanScale));
    const faceMask = window.__portraitFaceTools
      ? await window.__portraitFaceTools.skinMask(video, width, height).catch(() => null)
      : null;
    analysisCanvas.width = width; analysisCanvas.height = height;
    analysisCtx.drawImage(video, 0, 0, width, height);
    const left = Math.max(0, Math.floor(region.x * width)), top = Math.max(0, Math.floor(region.y * height));
    const right = Math.min(width, Math.ceil((region.x + region.width) * width)), bottom = Math.min(height, Math.ceil((region.y + region.height) * height));
    if (right - left < 12 || bottom - top < 12) { if (!quiet) toast("人脸选区太小，请重新框选"); return 0; }
    const pixels = analysisCtx.getImageData(0, 0, width, height).data;
    const candidates = [];
    const sensitivity = Math.max(70, Math.min(150, Number($("blemishSensitivity")?.value || 100))) / 100;
    const step = Math.max(1, Math.floor(Math.max(width, height) / 900));
    for (let y = top + 4; y < bottom - 4; y += step) for (let x = left + 4; x < right - 4; x += step) {
      const relativeX = (x - left) / (right - left), relativeY = (y - top) / (bottom - top);
      // Only avoid the narrow bridge of the nose. The wider exclusion used
      // before also skipped the under-eye area and mouth corners users asked
      // the automatic repair to cover.
      if (relativeX > 0.47 && relativeX < 0.53 && relativeY > 0.30 && relativeY < 0.54) continue;
      if (faceMask && faceMask[(y * width + x) * 4 + 3] < 112) continue;
      const i = (y * width + x) * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (r < 45 || g < 25 || b < 15 || r < g * 0.96 || g < b * 0.72 || r > 250) continue;
      let ring = 0, ringRed = 0, samples = 0;
      for (const [dx, dy] of [[-7,0],[7,0],[0,-7],[0,7],[-5,-5],[5,-5],[-5,5],[5,5]]) {
        const j = ((y + dy) * width + x + dx) * 4;
        ring += ((pixels[j] * 77 + pixels[j + 1] * 150 + pixels[j + 2] * 29) / 256);
        ringRed += pixels[j] - pixels[j + 1]; samples++;
      }
      const center = (r * 77 + g * 150 + b * 29) / 256, mean = ring / samples;
      const redContrast = (r - g) - ringRed / samples;
      const darkContrast = mean - center;
      const score = Math.max(redContrast / (13 / sensitivity), darkContrast / (17 / sensitivity));
      if (score > 0.9 && (redContrast > 3 / sensitivity || darkContrast > 13 / sensitivity)) candidates.push({ x: x / width, y: y / height, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const selected = [];
    const remaining = Math.max(0, 48 - marks().length);
    if (!remaining) { if (!quiet) toast("最多可保留 48 个自动修复点；请先删除误选点"); return 0; }
    for (const candidate of candidates) {
      const minDistance = Math.max(8, Math.max(width, height) * 0.012);
      const separatedFromSelected = selected.every((other) => Math.hypot((other.x - candidate.x) * width, (other.y - candidate.y) * height) > minDistance);
      const separatedFromExisting = marks().every((mark) => {
        const point = markAt(mark, Number(state.currentTime || 0));
        return Math.hypot((point.x - candidate.x) * width, (point.y - candidate.y) * height) > minDistance;
      });
      if (separatedFromSelected && separatedFromExisting) selected.push(candidate);
      if (selected.length >= remaining) break;
    }
    if (!selected.length) { if (!quiet) toast("这个画面没找到明显候选点；可在更多调节中手动补点"); return 0; }
    snapshot();
    const time = Math.max(0, Number(state.currentTime || 0));
    const strength = Number($("blemishStrength")?.value || 72);
    const added = selected.map((point) => ({ id: crypto.randomUUID(), radius: 0.0075, strength, source: "smart", keyframes: [{ time, x: point.x, y: point.y }] }));
    marks().push(...added); selectedMarkId = added[0].id; syncSelectedControls();
    saveMarks(`智能选出 ${added.length} 个候选点`);
    if (!quiet) toast(`找到并添加 ${added.length} 个候选点；可在更多调节中检查修复区域`);
    return added.length;
  }
  $("blemishSmartSelect").onclick = smartSelect;
  function applyPortraitBeauty(value, persist = true) {
    const strength = Math.max(0, Math.min(100, Number(value) || 0));
    state.beauty = {
      ...(state.beauty || {}),
      smoothing: Math.round(strength * 0.82),
      blemish: Math.round(strength),
      whitening: Math.round(strength * 0.56),
      texture: Math.round(strength * 0.38),
    };
    state.beautyBypass = false;
    if (typeof applyVideoCss === "function") applyVideoCss();
    if (persist) queueAutosave();
  }
  async function runOneClickRetouch() {
    if (tracking) {
      tracking = null;
      renderBlemishStatus();
      queueAutosave();
      toast("已停止瑕疵位置跟踪；磨皮和美白仍会生效");
      return;
    }
    const video = currentVideo();
    if (!video || video.readyState < 2) { toast("请先把要修复的视频放入时间线"); return; }
    const wasPlaying = !!state.playing;
    if (state.playing) {
      $("play")?.click();
      video.pause();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      state.playing = false;
    }
    snapshot();
    applyPortraitBeauty($("blemishStrength").value, false);
    const added = await smartSelect({ automaticRegion: true, quiet: true });
    queueAutosave();
    if (!marks().length) {
      if (wasPlaying) $("play")?.click();
      toast("磨皮、美白已开启；当前画面未识别到独立瑕疵点");
      renderBlemishStatus();
      return;
    }
    beginTracking({ quiet: true });
    toast(added ? `磨皮、美白已开启；已选中 ${added} 处瑕疵并开始跟踪` : "磨皮、美白已开启；继续跟踪现有瑕疵点");
  }
  $("blemishOneClick").onclick = runOneClickRetouch;
  $("blemishSensitivity").oninput = (event) => { $("blemishSensitivityOut").textContent = `${event.target.value}%`; };
  $("blemishSensitivity").onchange = () => queueAutosave();
  $("blemishFaceSelect").onclick = () => {
    if (selectingFace) { selectingFace = false; faceDrag = null; renderBlemishStatus(); requestPaint(); return; }
    if (state.playing) $("play")?.click();
    selectingFace = true; brushing = false; deleting = false; faceDrag = null;
    renderBlemishStatus(); requestPaint();
  };
  $("blemishDeleteMode").onclick = () => {
    deleting = !deleting; brushing = false; selectingFace = false;
    renderBlemishStatus(); requestPaint();
  };
  function syncSelectedControls() {
    const mark = marks().find((item) => item.id === selectedMarkId);
    if (!mark) return;
    const radius = Math.max(6, Math.min(48, Math.round(Number(mark.radius || 0.009) * Math.max(1, Number(state.width || 1080)) * 2)));
    const strength = Math.max(20, Math.min(100, Math.round(Number(mark.strength || 72))));
    $("blemishRadius").value = radius; $("blemishRadiusOut").textContent = `${radius} px`;
    $("blemishStrength").value = strength; $("blemishStrengthOut").textContent = `${strength}%`;
  }
  function requestPaint() {
    if (!paintRequest) paintRequest = requestAnimationFrame(paint);
  }
  function grayFrame(image) {
    const rgba = image.data, gray = new Uint8Array(image.width * image.height);
    for (let source = 0, target = 0; target < gray.length; source += 4, target += 1)
      gray[target] = Math.round((rgba[source] * 77 + rgba[source + 1] * 150 + rgba[source + 2] * 29) / 256);
    return gray;
  }
  function chooseRepairSource(point, radius, width, height, pixels, markId, otherPoints) {
    const cx = point.x * width, cy = point.y * height, region = faceRegion();
    const ringAt = (x, y) => {
      const values = [];
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
        const px = Math.round(x + Math.cos(angle) * radius * 1.25), py = Math.round(y + Math.sin(angle) * radius * 1.25);
        if (px < 0 || py < 0 || px >= width || py >= height) return null;
        const i = (py * width + px) * 4;
        values.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
      }
      return values;
    };
    const targetRing = ringAt(cx, cy);
    if (!targetRing) return null;
    const vectors = [[-1,0],[1,0],[0,-1],[0,1],[-0.707,-0.707],[0.707,-0.707],[-0.707,0.707],[0.707,0.707]];
    let best = null, bestScore = Infinity;
    for (const distance of [2.5, 3.25, 4]) for (const [vx, vy] of vectors) {
      const x = cx + vx * radius * distance, y = cy + vy * radius * distance;
      const left = Math.round(x - radius), top = Math.round(y - radius), size = Math.ceil(radius * 2);
      if (left < 0 || top < 0 || left + size >= width || top + size >= height) continue;
      if (region && (x / width < region.x || x / width > region.x + region.width || y / height < region.y || y / height > region.y + region.height)) continue;
      if (otherPoints.some((other) => other.id !== markId && Math.hypot((other.point.x - x / width) * width, (other.point.y - y / height) * height) < radius * 1.8)) continue;
      const candidateRing = ringAt(x, y); if (!candidateRing) continue;
      let score = 0;
      for (let i = 0; i < targetRing.length; i += 1) {
        for (let channel = 0; channel < 3; channel += 1) score += Math.abs(targetRing[i][channel] - candidateRing[i][channel]);
      }
      const center = (Math.round(y) * width + Math.round(x)) * 4;
      const centerLuma = pixels[center] * 0.299 + pixels[center + 1] * 0.587 + pixels[center + 2] * 0.114;
      const ringLuma = candidateRing.reduce((sum, color) => sum + color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114, 0) / candidateRing.length;
      // Avoid cloning another dark pore/spot; prefer a source whose center agrees with its surrounding skin.
      score += Math.max(0, ringLuma - centerLuma - 10) * 6;
      if (score < bestScore) { bestScore = score; best = { x: left, y: top }; }
    }
    return best;
  }
  function trackPoint(frame, width, height, time) {
    if (!tracking) return;
    const gray = grayFrame(frame);
    const elapsed = Math.abs(time - tracking.time);
    if (tracking.previous && elapsed > 0.001 && elapsed < 0.5) {
      for (const item of tracking.items) {
        const mark = marks().find((candidate) => candidate.id === item.id);
        if (!mark) { item.lost = true; continue; }
        const radius = 5, centerX = Math.round(item.point.x * width), centerY = Math.round(item.point.y * height);
        if (centerX - radius < 0 || centerY - radius < 0 || centerX + radius >= width || centerY + radius >= height) { item.weakFrames = (item.weakFrames || 0) + 1; continue; }
        const search = Math.min(20, Math.max(5, Math.ceil(4 + elapsed * Math.max(width, height) * 0.3)));
        const template = [];
        for (let py = -radius; py <= radius; py += 2) for (let px = -radius; px <= radius; px += 2) template.push(tracking.previous[(centerY + py) * width + centerX + px]);
        const templateMean = template.reduce((sum, value) => sum + value, 0) / template.length;
        const templateVariance = template.reduce((sum, value) => sum + (value - templateMean) ** 2, 0);
        const templateEnergy = template.reduce((sum, value) => sum + value * value, 0);
        let best = { score: Infinity, x: centerX, y: centerY, confidence: 0 }, secondScore = Infinity;
        for (let dy = -search; dy <= search; dy += 1) for (let dx = -search; dx <= search; dx += 1) {
          const x = centerX + dx, y = centerY + dy;
          if (x - radius < 0 || y - radius < 0 || x + radius >= width || y + radius >= height) continue;
          let sampleSum = 0, sampleEnergy = 0, dot = 0, absolute = 0;
          for (let py = -radius; py <= radius; py += 2) for (let px = -radius; px <= radius; px += 2) {
            const i = (y + py) * width + x + px, index = ((py + radius) / 2) * 6 + (px + radius) / 2;
            const value = gray[i]; sampleSum += value; sampleEnergy += value * value; dot += template[index] * value; absolute += Math.abs(template[index] - value);
          }
          const sampleVariance = sampleEnergy - sampleSum * sampleSum / template.length;
          const covariance = dot - templateMean * sampleSum;
          const correlation = templateVariance > 16 && sampleVariance > 16
            ? covariance / Math.sqrt(templateVariance * sampleVariance)
            : 1 - absolute / (template.length * 64);
          const score = 1 - correlation + Math.hypot(dx, dy) * 0.0015;
          if (score < best.score) { secondScore = best.score; best = { score, x, y, confidence: correlation }; }
          else if (score < secondScore) secondScore = score;
        }
        const unambiguous = secondScore === Infinity || secondScore - best.score > 0.003;
        if (best.confidence < 0.30 || (!unambiguous && best.confidence < 0.62)) {
          item.weakFrames = (item.weakFrames || 0) + 1;
          item.confidence = best.confidence;
          continue;
        }
        item.weakFrames = 0;
        item.confidence = best.confidence;
        item.point = { x: best.x / width, y: best.y / height };
        const moved = Math.hypot((item.point.x - item.lastSavedPoint.x) * width, (item.point.y - item.lastSavedPoint.y) * height);
        if (time - item.lastKeyTime >= 0.12 || moved >= 1.25) {
          insertKey(mark, item.point.x, item.point.y, time, false);
          item.lastSavedPoint = { ...item.point };
          item.lastKeyTime = time;
        }
      }
      const weak = tracking.items.filter((item) => item.weakFrames >= 5).length;
      if (weak && time - tracking.lastWarningTime > 3) { tracking.lastWarningTime = time; toast(`${weak} 个点暂时跟踪不稳，已冻结位置；暂停后可手动校正`); }
      if (time - tracking.lastStatusTime > 0.5) { tracking.lastStatusTime = time; renderBlemishStatus(); }
      if (tracking.items.length && time - tracking.lastSaveTime >= 1) { tracking.lastSaveTime = time; queueAutosave(); }
      if (!tracking.items.length) { tracking = null; renderBlemishStatus(); }
    } else if (tracking.previous && elapsed >= 0.5) {
      for (const item of tracking.items) {
        const mark = marks().find((candidate) => candidate.id === item.id);
        if (!mark) continue;
        item.point = markAt(mark, time); item.lastSavedPoint = { ...item.point }; item.lastKeyTime = time; item.weakFrames = 0;
      }
    }
    tracking.previous = gray;
    tracking.time = time;
  }
  function paint(now = performance.now()) {
    paintRequest = 0;
    const hasRetouch = brushing || deleting || selectingFace || marks().length > 0 || !!tracking;
    if (!hasRetouch) {
      canvas.classList.remove("active");
      return;
    }
    // Do not copy a decoder's retained last frame after its main timeline clip
    // ends, is hidden, or is replaced by a higher identical-media layer.
    if (canvas.dataset.previewTargetVisible !== "true" || canvas.style.visibility === "hidden") {
      canvas.classList.remove("active");
      if (state.playing) paintRequest = requestAnimationFrame(paint);
      return;
    }
    const video = currentVideo();
    if (!video || video.readyState < 2 || !state.video) {
      canvas.classList.remove("active");
      if (state.playing || brushing || deleting || selectingFace || marks().length || tracking)
        paintRequest = requestAnimationFrame(paint);
      return;
    }
    if (now - lastPaint < 30) { paintRequest = requestAnimationFrame(paint); return; }
    lastPaint = now;
    const maxSide = 720;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth || 1, video.videoHeight || 1));
    const width = Math.max(2, Math.round((video.videoWidth || state.width) * scale));
    const height = Math.max(2, Math.round((video.videoHeight || state.height) * scale));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    if (sourceCanvas.width !== width || sourceCanvas.height !== height) { sourceCanvas.width = width; sourceCanvas.height = height; }
    try {
      const beautyCanvas = $("beautyPreviewCanvas");
      const fallbackCanvas = $("beautyPreviewFallbackCanvas");
      const baseFrame = beautyCanvas?.classList.contains("ready") ? beautyCanvas
        : fallbackCanvas?.classList.contains("ready") ? fallbackCanvas : video;
      sourceCtx.drawImage(baseFrame, 0, 0, width, height);
      ctx.drawImage(sourceCanvas, 0, 0, width, height);
      if (tracking && state.playing && video.currentTime !== tracking.videoTime) {
        trackPoint(ctx.getImageData(0, 0, width, height), width, height, Number(state.currentTime || 0));
        if (tracking) tracking.videoTime = video.currentTime;
      }
      const displayMarks = marks().map((mark) => ({ mark, point: tracking?.items.find((item) => item.id === mark.id)?.point || markAt(mark) }));
      const donorPoints = displayMarks.map(({ mark, point }) => ({ id: mark.id, point }));
      const sourcePixels = displayMarks.length ? sourceCtx.getImageData(0, 0, width, height).data : null;
      ctx.save(); ctx.beginPath();
      for (const { mark, point } of displayMarks) {
        const radius = Math.max(3, Number(mark.radius || 0.009) * width);
        ctx.moveTo(point.x * width + radius, point.y * height);
        ctx.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
      }
      ctx.clip();
      for (const { mark, point } of displayMarks) {
        const radius = Math.max(3, Number(mark.radius || 0.009) * width);
        const cx = point.x * width, cy = point.y * height, diameter = Math.ceil(radius * 2);
        const sx = Math.max(0, Math.min(width - diameter, Math.round(cx - radius)));
        const sy = Math.max(0, Math.min(height - diameter, Math.round(cy - radius)));
        if (diameter < 6 || sx < 0 || sy < 0) continue;
        scratch.width = diameter; scratch.height = diameter;
        const donor = chooseRepairSource(point, radius, width, height, sourcePixels, mark.id, donorPoints);
        if (!donor) continue;
        scratchCtx.clearRect(0, 0, diameter, diameter);
        scratchCtx.drawImage(sourceCanvas, donor.x, donor.y, diameter, diameter, 0, 0, diameter, diameter);
        const feather = scratchCtx.createRadialGradient(diameter / 2, diameter / 2, diameter * 0.16, diameter / 2, diameter / 2, diameter * 0.5);
        feather.addColorStop(0, `rgba(0,0,0,${Math.max(0, Math.min(1, Number(mark.strength || 72) / 100))})`);
        feather.addColorStop(0.72, `rgba(0,0,0,${Math.max(0, Math.min(1, Number(mark.strength || 72) / 100))})`);
        feather.addColorStop(1, "rgba(0,0,0,0)");
        scratchCtx.globalCompositeOperation = "destination-in";
        scratchCtx.fillStyle = feather; scratchCtx.fillRect(0, 0, diameter, diameter);
        scratchCtx.globalCompositeOperation = "source-over";
        ctx.drawImage(scratch, sx, sy);
      }
      ctx.restore();
      if (brushing || deleting || selectingFace) {
        for (const { mark, point } of displayMarks) {
          const radius = Math.max(3, Number(mark.radius || 0.009) * width);
          ctx.beginPath(); ctx.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
          ctx.lineWidth = Math.max(1, width / 360); ctx.strokeStyle = mark.id === selectedMarkId ? "#63e6be" : "rgba(255,255,255,.85)"; ctx.stroke();
        }
      }
      const region = faceDrag?.preview || faceRegion();
      if (region && (selectingFace || deleting)) {
        ctx.save(); ctx.setLineDash([Math.max(3, width / 100), Math.max(3, width / 100)]);
        ctx.lineWidth = Math.max(1, width / 300); ctx.strokeStyle = "#63e6be";
        ctx.strokeRect(region.x * width, region.y * height, region.width * width, region.height * height);
        ctx.restore();
      }
    } catch {
      canvas.classList.remove("active");
    }
    if (hasRetouch && (state.playing || brushing || deleting || selectingFace || marks().length || tracking))
      paintRequest = requestAnimationFrame(paint);
  }
  function insertKey(mark, x, y, time, manual = true) {
    const keys = sortedKeys(mark);
    const existing = keys.find((key) => Math.abs(Number(key.time) - time) < 1 / 60);
    if (existing) { existing.x = x; existing.y = y; existing.manual = existing.manual || manual; }
    else keys.push({ time, x, y, manual });
    keys.sort((a, b) => Number(a.time) - Number(b.time));
    mark.keyframes = keys;
  }
  $("blemishBrush").onclick = () => { brushing = !brushing; deleting = false; selectingFace = false; renderBlemishStatus(); requestPaint(); };
  function beginTracking({ quiet = false } = {}) {
    if (tracking) {
      tracking = null;
      renderBlemishStatus();
      queueAutosave();
      if (!quiet) toast("已停止瑕疵跟踪");
      return false;
    }
    const video = currentVideo();
    if (!marks().length || !video || video.readyState < 2) { if (!quiet) toast("请先添加或智能选取至少一个修复点"); return false; }
    if (!state.playing) $("play")?.click();
    const time = Number(state.currentTime || 0);
    snapshot();
    tracking = { items: marks().map((mark) => ({ id: mark.id, point: markAt(mark, time), lastSavedPoint: markAt(mark, time), lastKeyTime: time, weakFrames: 0, confidence: 1 })), previous: null, time, videoTime: video.currentTime, lastSaveTime: time, lastWarningTime: -Infinity, lastStatusTime: -Infinity };
    renderBlemishStatus();
    requestPaint();
    if (!quiet) toast(`正在跟踪全部 ${tracking.items.length} 个修复点；移动或遮挡时可暂停并手动校正`);
    return true;
  }
  $("blemishTrack").onclick = () => beginTracking();
  function updateSelectedValue(property, value, toStored) {
    const mark = marks().find((item) => item.id === selectedMarkId);
    if (!mark) return;
    mark[property] = toStored(value);
    requestPaint();
  }
  $("blemishRadius").onpointerdown = () => { if (marks().some((item) => item.id === selectedMarkId)) snapshot(); };
  $("blemishRadius").oninput = (event) => {
    $("blemishRadiusOut").textContent = `${event.target.value} px`;
    updateSelectedValue("radius", (Number(event.target.value) / 2) / Math.max(1, Number(state.width || 1080)), (value) => value);
  };
  $("blemishRadius").onchange = () => queueAutosave();
  $("blemishStrength").onpointerdown = () => snapshot();
  $("blemishStrength").oninput = (event) => {
    $("blemishStrengthOut").textContent = `${event.target.value}%`;
    for (const mark of marks()) mark.strength = Number(event.target.value);
    applyPortraitBeauty(event.target.value, false);
    requestPaint();
  };
  $("blemishStrength").onchange = () => queueAutosave();
  $("blemishUndo").onclick = () => {
    if (!marks().length) return;
    snapshot();
    const selected = marks().find((item) => item.id === selectedMarkId);
    if (selected && sortedKeys(selected).length > 1) {
      const time = Number(state.currentTime || 0), keys = sortedKeys(selected);
      const removeAt = keys.reduce((best, key, index) => Math.abs(Number(key.time) - time) < Math.abs(Number(keys[best].time) - time) ? index : best, 0);
      keys.splice(removeAt, 1); selected.keyframes = keys;
      saveMarks("已撤销位置校正");
    } else {
      const removeAt = marks().findIndex((item) => item.id === selectedMarkId);
      const removed = marks().splice(removeAt >= 0 ? removeAt : marks().length - 1, 1)[0];
      if (removed?.id === selectedMarkId) selectedMarkId = marks().at(-1)?.id || "";
      saveMarks("已撤销修复点");
    }
  };
  $("blemishClear").onclick = () => {
    if (!marks().length) return;
    snapshot(); state.blemishMarks = []; selectedMarkId = ""; tracking = null; saveMarks("已清除全部修复点");
  };
  canvas.addEventListener("pointerdown", (event) => {
    const video = currentVideo();
    if (!video || video.readyState < 2 || state.playing) return;
    const point = pointerPoint(event); if (!point) return;
    const { x, y } = point;
    if (selectingFace) { faceDrag = { x, y, preview: { x, y, width: 0, height: 0 } }; canvas.setPointerCapture(event.pointerId); requestPaint(); return; }
    if (!brushing && !deleting) return;
    const time = Math.max(0, Number(state.currentTime || 0));
    if (deleting) {
      const nearest = marks().map((mark) => ({ mark, point: markAt(mark, time) })).map((entry) => ({ ...entry, distance: Math.hypot((entry.point.x - x) * canvas.width, (entry.point.y - y) * canvas.height) })).sort((a, b) => a.distance - b.distance)[0];
      if (!nearest || nearest.distance > Math.max(18, canvas.width * 0.045)) { toast("请点在要删除的候选圈附近"); return; }
      event.stopPropagation(); snapshot(); marks().splice(marks().findIndex((mark) => mark.id === nearest.mark.id), 1); if (tracking) tracking.items = tracking.items.filter((item) => item.id !== nearest.mark.id); if (selectedMarkId === nearest.mark.id) selectedMarkId = marks().at(-1)?.id || ""; saveMarks("已删除多余候选点"); return;
    }
    const radiusPx = Number($("blemishRadius").value || 18);
    const near = marks().map((mark) => ({ mark, point: markAt(mark, time) }))
      .find(({ mark, point }) => Math.hypot((point.x - x) * canvas.width, (point.y - y) * canvas.height) <= Math.max(13, Number(mark.radius || 0.009) * canvas.width * 1.7));
    snapshot();
    if (near) {
      selectedMarkId = near.mark.id;
      insertKey(near.mark, x, y, time);
      const tracked = tracking?.items.find((item) => item.id === near.mark.id);
      if (tracked) { tracked.point = { x, y }; tracked.lastSavedPoint = { x, y }; tracked.lastKeyTime = time; tracked.weakFrames = 0; tracking.previous = null; }
    } else {
      const mark = { id: crypto.randomUUID(), radius: (radiusPx / 2) / Math.max(1, Number(state.width || video.videoWidth || 1080)), strength: Number($("blemishStrength").value || 72), keyframes: [{ time, x, y }] };
      marks().push(mark); selectedMarkId = mark.id;
    }
    syncSelectedControls();
    saveMarks(near ? "已添加位置校正" : "已添加修复点");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!selectingFace || !faceDrag) return;
    const p = pointerPoint(event); if (!p) return;
    const left = Math.min(faceDrag.x, p.x), top = Math.min(faceDrag.y, p.y);
    faceDrag.preview = { x: left, y: top, width: Math.abs(p.x - faceDrag.x), height: Math.abs(p.y - faceDrag.y) };
    requestPaint();
  });
  const finishFace = () => {
    if (!selectingFace || !faceDrag) return;
    const region = faceDrag.preview; faceDrag = null;
    if (region.width < 0.04 || region.height < 0.04) { toast("选区太小，请重新拖动画出完整脸部"); requestPaint(); return; }
    snapshot(); state.blemishFaceRegion = region; state.blemishMarks = []; selectedMarkId = ""; tracking = null;
    selectingFace = false; queueAutosave(); renderBlemishStatus(); requestPaint(); toast("人脸选区已保存，可以智能选点或手动添加");
  };
  canvas.addEventListener("pointerup", finishFace);
  canvas.addEventListener("pointercancel", finishFace);
  document.addEventListener("timeupdate", requestPaint, true);
  document.addEventListener("seeking", (event) => {
    if (!tracking || event.target !== currentVideo()) return;
    const time = Number(currentVideo().currentTime || 0);
    tracking.previous = null; tracking.time = time;
    tracking.items.forEach((item) => {
      const mark = marks().find((candidate) => candidate.id === item.id);
      if (!mark) return;
      item.point = markAt(mark, time); item.lastSavedPoint = { ...item.point }; item.lastKeyTime = time; item.weakFrames = 0;
    });
  }, true);
  renderBlemishStatus();
  requestPaint();
})();

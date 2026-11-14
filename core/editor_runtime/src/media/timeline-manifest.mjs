const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function compileTimelineManifest(config = {}, info = {}) {
  const fps = Math.max(1, Math.min(240, finite(config.fps, 30)));
  const frameDuration = 1 / fps;
  const sourceFps=Math.max(1,Number(info.frameRate||fps));
  const speed = Math.max(0.05, finite(config.audio?.speed, 1));
  const issues = [];

  const compileTrack = (items = [], kind = "video") => [...items]
    .sort((a, b) => finite(a.start) - finite(b.start))
    .map((item) => ({ ...item, settings: item.settings ? { ...item.settings } : item.settings }))
    .reduce((compiled, item, index) => {
      const rawStart = Number(item.start);
      const rawEnd = Number(item.end);
      const rawSourceStart = Number(item.sourceStart ?? 0);
      const rawSourceEnd = Number(item.sourceEnd);
      if (![rawStart, rawEnd, rawSourceStart, rawSourceEnd].every(Number.isFinite)) {
        issues.push({ severity: "error", code: "NON_FINITE_TIME", kind, index });
        return compiled;
      }
      if (rawEnd <= rawStart || rawSourceEnd <= rawSourceStart) {
        issues.push({ severity: "error", code: "INVALID_RANGE", kind, index });
        return compiled;
      }
      let startFrame = Math.round(rawStart * fps);
      const originalStartFrame = startFrame;
      const endFrame = Math.max(startFrame + 1, Math.round(rawEnd * fps));
      const previous = compiled.findLast(clip => (clip.trackId || kind) === (item.trackId || kind));
      if (previous) {
        const boundaryDelta = startFrame - previous.endFrame;
        if (Math.abs(rawStart-previous.end)<1e-7) startFrame = previous.endFrame;
        else if (boundaryDelta < 0) issues.push({ severity: "error", code: "UNEXPECTED_OVERLAP", kind, index, frames: -boundaryDelta });
      }
      const durationFrames = Math.max(1, endFrame - originalStartFrame);
      const normalizedEndFrame = startFrame + durationFrames;
      const sourceStartFrame = Math.max(0, Math.round(rawSourceStart * sourceFps));
      const sourceEndFrame = Math.max(sourceStartFrame + 1, Math.round(rawSourceEnd * sourceFps));
      const playbackRate = Math.max(.05, finite(item.playbackRate, speed));
      const requiredSourceFrames = durationFrames / fps * sourceFps * playbackRate;
      const sourceShortageFrames = requiredSourceFrames - (sourceEndFrame - sourceStartFrame);
      if (sourceShortageFrames > 1.01) {
        issues.push({ severity: "error", code: "SOURCE_TOO_SHORT", kind, index, frames: sourceShortageFrames });
      }
      compiled.push({
        ...item,
        playbackRate,
        startFrame,
        endFrame: normalizedEndFrame,
        durationFrames,
        sourceStartFrame,
        sourceEndFrame,
        start: startFrame / fps,
        end: normalizedEndFrame / fps,
        sourceStart: rawSourceStart,
        sourceEnd: rawSourceEnd,
      });
      return compiled;
    }, []);

  const video = compileTrack(config.mainVideoClips || [], "video");
  const audio = compileTrack(config.mainAudioClips || config.mainVideoClips || [], "audio");
  const requestedFrames = Math.max(1, Math.round(finite(config.outputDuration, finite(info.duration, frameDuration)) * fps));
  const videoEndFrame = Math.max(0,...video.map(clip=>clip.endFrame));
  const audioEndFrame = Math.max(0,...audio.map(clip=>clip.endFrame));
  let targetFrameCount = requestedFrames;
  const coverageEndFrame = Math.max(videoEndFrame, audioEndFrame);
  if (Math.abs(requestedFrames - coverageEndFrame) <= 1) targetFrameCount = Math.max(1, coverageEndFrame);
  if (config.requireLinkedEndpoints && Math.abs(videoEndFrame - audioEndFrame) > 1) {
    issues.push({ severity: "error", code: "AV_DURATION_MISMATCH", frames: Math.abs(videoEndFrame - audioEndFrame) });
  }
  const errors = issues.filter((issue) => issue.severity === "error");
  return {
    fps,
    frameDuration,
    speed,
    video,
    audio,
    targetFrameCount,
    duration: targetFrameCount / fps,
    videoEndFrame,
    audioEndFrame,
    issues,
    errors,
  };
}

export function assertValidTimelineManifest(manifest) {
  if (!manifest?.errors?.length) return manifest;
  const first = manifest.errors[0];
  const messages = {
    NON_FINITE_TIME: "时间线包含 NaN 或 Infinity。",
    INVALID_RANGE: "时间线包含零长度或反向片段。",
    UNEXPECTED_OVERLAP: `时间线存在 ${first.frames} 帧的异常重叠。`,
    SOURCE_TOO_SHORT: `第 ${Number(first.index) + 1} 个${first.kind === "audio" ? "音频" : "视频"}片段的源范围比时间线短 ${Math.ceil(first.frames)} 帧。`,
    AV_DURATION_MISMATCH: `主视频和主音频终点相差 ${first.frames} 帧。`,
  };
  throw new Error(`导出前时间线校验失败：${messages[first.code] || first.code} 请检查最后一个切口或重新执行整体变速。`);
}

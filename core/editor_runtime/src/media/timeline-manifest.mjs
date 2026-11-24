const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function gcd(left, right) {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b) [a, b] = [b, a % b];
  return Math.max(1, a);
}

function frameRate(value, numerator, denominator, fallback = 30) {
  const explicitNumerator = Math.trunc(finite(numerator, 0));
  const explicitDenominator = Math.trunc(finite(denominator, 0));
  if (explicitNumerator > 0 && explicitDenominator > 0) {
    const divisor = gcd(explicitNumerator, explicitDenominator);
    return { numerator: explicitNumerator / divisor, denominator: explicitDenominator / divisor };
  }

  const rate = Math.max(1, Math.min(240, finite(value, fallback)));
  for (const [commonNumerator, commonDenominator] of [
    [24000, 1001], [30000, 1001], [60000, 1001], [120000, 1001],
  ]) {
    if (Math.abs(rate - commonNumerator / commonDenominator) < 0.001) {
      return { numerator: commonNumerator, denominator: commonDenominator };
    }
  }

  const scale = 1_000_000;
  const rawNumerator = Math.round(rate * scale);
  const divisor = gcd(rawNumerator, scale);
  return { numerator: rawNumerator / divisor, denominator: scale / divisor };
}

export function compileTimelineManifest(config = {}, info = {}) {
  const outputRate = frameRate(config.fps, config.frameRateNumerator, config.frameRateDenominator, 30);
  const fpsNumerator = outputRate.numerator;
  const fpsDenominator = outputRate.denominator;
  const fps = fpsNumerator / fpsDenominator;
  const frameDuration = fpsDenominator / fpsNumerator;
  const sourceRate = frameRate(
    info.frameRate || fps,
    info.frameRateNumerator,
    info.frameRateDenominator,
    fps,
  );
  const sourceFpsNumerator = sourceRate.numerator;
  const sourceFpsDenominator = sourceRate.denominator;
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
      let startFrame = Math.round(rawStart * fpsNumerator / fpsDenominator);
      const originalStartFrame = startFrame;
      const endFrame = Math.max(startFrame + 1, Math.round(rawEnd * fpsNumerator / fpsDenominator));
      const previous = compiled.findLast(clip => (clip.trackId || kind) === (item.trackId || kind));
      if (previous) {
        const boundaryDelta = startFrame - previous.endFrame;
        if (Math.abs(rawStart-previous.end)<1e-7) startFrame = previous.endFrame;
        else if (boundaryDelta < 0) issues.push({ severity: "error", code: "UNEXPECTED_OVERLAP", kind, index, frames: -boundaryDelta });
      }
      const durationFrames = Math.max(1, endFrame - originalStartFrame);
      const normalizedEndFrame = startFrame + durationFrames;
      const sourceStartFrame = Math.max(0, Math.round(rawSourceStart * sourceFpsNumerator / sourceFpsDenominator));
      const sourceEndFrame = Math.max(sourceStartFrame + 1, Math.round(rawSourceEnd * sourceFpsNumerator / sourceFpsDenominator));
      const playbackRate = Math.max(.05, finite(item.playbackRate, speed));
      const requiredSourceFrames = durationFrames * sourceFpsNumerator * fpsDenominator /
        (fpsNumerator * sourceFpsDenominator) * playbackRate;
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
        start: startFrame * frameDuration,
        end: normalizedEndFrame * frameDuration,
        sourceStart: rawSourceStart,
        sourceEnd: rawSourceEnd,
      });
      return compiled;
    }, []);

  const video = compileTrack(config.mainVideoClips || [], "video");
  const audio = compileTrack(config.mainAudioClips || config.mainVideoClips || [], "audio");
  const requestedFrames = Math.max(1, Math.round(finite(config.outputDuration, finite(info.duration, frameDuration)) / frameDuration));
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
    duration: targetFrameCount * frameDuration,
    fpsNumerator,
    fpsDenominator,
    sourceFpsNumerator,
    sourceFpsDenominator,
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

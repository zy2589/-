export function exportSpeed(config = {}) {
  const rate = Number(config.exportSpeed ?? 1);
  if (!Number.isFinite(rate) || (rate !== 1 && (rate < 1.1 || rate > 2)))
    throw new Error('导出倍速须为原速，或 1.1～2.0 之间的数值。');
  return rate;
}

// Retime the completed composition so captions, overlays and the mixed audio
// share one clock. Timeline/source coordinates remain unchanged.
export function applyExportSpeed(built, config) {
  const rate = exportSpeed(config);
  if (rate === 1) return built;
  const filters = [built.graph];
  const result = {...built, duration: built.duration / rate};
  if (built.videoLabel) {
    result.frameCount = Math.max(1, Math.ceil(result.duration * built.fps - 1e-6));
    filters.push(`${built.videoLabel}setpts=(PTS-STARTPTS)/${rate},fps=${built.fps},trim=end_frame=${result.frameCount}[speedv]`);
    result.videoLabel = '[speedv]';
  }
  if (built.audioLabel) {
    filters.push(`${built.audioLabel}atempo=${rate},apad,atrim=duration=${result.duration},asetpts=PTS-STARTPTS[speeda]`);
    result.audioLabel = '[speeda]';
  }
  result.graph = filters.join(';');
  return result;
}

const qualityFactors = Object.freeze({
  balanced: 0.78,
  fast: 0.66,
  maximum: 0.9,
  // RF is a quality target with a bitrate ceiling. Keep that ceiling low
  // enough to produce a meaningful size reduction for vertical social video.
  rf: 0.24,
});

function baseBitrate(width, height, fps) {
  const pixels = Number(width || 0) * Number(height || 0);
  const highFrameRate = Number(fps || 30) > 30;
  return pixels >= 7_000_000
    ? highFrameRate ? 50 : 38
    : pixels >= 3_000_000
      ? highFrameRate ? 32 : 24
      : pixels >= 1_500_000
        ? highFrameRate ? 18 : 14
        : highFrameRate ? 10 : 8;
}

/**
 * Return an encoder target that stays below the source video bitrate. This
 * keeps automatic exports useful as compression even when the source is a
 * high-bitrate camera file. Explicit bitrate choices remain untouched.
 */
export function recommendedExportBitrate({
  width,
  height,
  fps = 30,
  sourceSize = 0,
  sourceDuration = 0,
  sourceAudioBitrate = 0,
  hasAudio = true,
  codec = "h264",
  qualityMode = "balanced",
} = {}) {
  const pixelBudget = baseBitrate(width, height, fps);
  const size = Number(sourceSize || 0);
  const duration = Number(sourceDuration || 0);
  const sourceTotalMbps = size > 0 && duration > 0 ? size * 8 / duration / 1_000_000 : 0;
  if (!sourceTotalMbps) return qualityMode === "rf" ? "2.30M" : `${pixelBudget.toFixed(1)}M`;

  const measuredAudioMbps = Number(sourceAudioBitrate || 0) / 1_000_000;
  const audioMbps = hasAudio ? (measuredAudioMbps > 0 ? measuredAudioMbps : 0.192) : 0;
  const sourceVideoMbps = Math.max(0.01, sourceTotalMbps - audioMbps);
  const presetFactor = qualityFactors[qualityMode] || qualityFactors.balanced;
  // HEVC reaches a similar visual quality at a lower rate than H.264.
  const codecFactor = String(codec).toLowerCase() === "hevc" ? 0.9 : 1;
  const targetMbps = Math.min(pixelBudget, sourceVideoMbps * presetFactor * codecFactor);
  return `${Math.max(0.01, targetMbps).toFixed(2)}M`;
}

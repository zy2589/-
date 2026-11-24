(() => {
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const escapeXml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const gcd = (left, right) => {
    let a = Math.abs(Math.trunc(left)), b = Math.abs(Math.trunc(right));
    while (b) [a, b] = [b, a % b];
    return Math.max(1, a);
  };

  function frameRate(config) {
    let numerator = Math.trunc(finite(config.fpsNumerator, 0));
    let denominator = Math.trunc(finite(config.fpsDenominator, 0));
    if (numerator > 0 && denominator > 0) {
      const divisor = gcd(numerator, denominator);
      return { numerator: numerator / divisor, denominator: denominator / divisor };
    }
    const rate = Math.max(1, Math.min(240, finite(config.fps, 30)));
    for (const [n, d] of [[24000, 1001], [30000, 1001], [60000, 1001], [120000, 1001]]) {
      if (Math.abs(rate - n / d) < 0.001) return { numerator: n, denominator: d };
    }
    numerator = Math.round(rate * 1000000);
    denominator = 1000000;
    const divisor = gcd(numerator, denominator);
    return { numerator: numerator / divisor, denominator: denominator / divisor };
  }

  function hasActiveNumbers(value) {
    if (Array.isArray(value)) return value.some(hasActiveNumbers);
    if (!value || typeof value !== "object") return typeof value === "number" && Math.abs(value) > 0.000001;
    return Object.values(value).some(hasActiveNumbers);
  }

  function unsupported(config) {
    if (Math.abs(finite(config.exportSpeed, 1) - 1) > .0001 || Math.abs(finite(config.audio?.speed, 1) - 1) > .0001)
      return "变速时间线还没有迁移到 MLT。";
    if (String(config.colorSpace || "bt709") !== "bt709") return "BT.2020、HLG 和 P3 色彩输出尚未迁移到 MLT。";
    if (Math.abs(finite(config.mainTimelineOffset, 0)) > .0001)
      return "嵌套时间线偏移还没有迁移到 MLT。";
    for (const group of config.compoundClips || []) {
      const transform = group.transform || {};
      if (Math.abs(finite(transform.x, 0)) > .001 || Math.abs(finite(transform.y, 0)) > .001 ||
          Math.abs(finite(transform.scale, 1) - 1) > .001 || Math.abs(finite(transform.rotation, 0)) > .001 ||
          Math.abs(finite(transform.opacity, 1) - 1) > .001 ||
          [transform.cropTop, transform.cropBottom, transform.cropLeft, transform.cropRight].some(value => Math.abs(finite(value, 0)) > .001))
        return "复合片段外层变换还没有迁移到 MLT。";
    }
    if ((config.removals || []).length || (config.audioMutes || []).length || config.audioProcessingEnabled)
      return "自动删词、静音区间或音频总线处理还没有迁移到 MLT。";
    if (config.encoderDevice && !["cpu", "software"].includes(String(config.encoderDevice).toLowerCase()))
      return "MLT 目前使用 CPU 编码；所选硬件编码器尚未迁移。";
    if (["rf", "lossless"].includes(String(config.qualityMode || "balanced")))
      return "固定画质和无损编码参数还没有迁移到 MLT。";
    if ((config.titles || []).length) return "标题图层还没有迁移到 MLT。";
    if ((config.captions || []).length && !config.captionRasterized) return "字幕图层尚未生成 MLT 可用的图像素材。";
    if (hasActiveNumbers(config.beauty) || (config.blemishMarks || []).length) return "美容和瑕疵修复效果还没有迁移到 MLT。";
    if (finite(config.denoise?.strength, 0) > 0) return "降噪效果还没有迁移到 MLT。";
    if ((config.audioFxRack || []).some(effect => effect.enabled !== false) || (config.mainAudioFxPreRendered || []).length)
      return "音频效果链还没有迁移到 MLT。";
    if ((config.spliceRegions || []).length || config.spliceLayout && config.spliceLayout !== "free")
      return "拼接蒙版和分屏布局还没有迁移到 MLT。";

    const clips = [
      ...(config.mainVideoClips || []).map(clip => ({ ...clip, _kind: "main" })),
      ...(config.videoLayers || []).map(clip => ({ ...clip, _kind: "layer" })),
      ...(config.images || []).map(clip => ({ ...clip, _kind: "image" })),
    ];
    const captionImages = (config.images || []).filter(image => image._clipAssistantCaptionRaster);
    if ((config.images || []).some(image => !image._clipAssistantCaptionRaster))
      return "普通图片素材的持续显示和变换还没有迁移到 MLT。";
    if (captionImages.some(image => !image.fullFrame || !image.pixelExact ||
        Math.abs(finite(image.x, 0)) > .001 || Math.abs(finite(image.y, 0)) > .001))
      return "字幕图像不是逐帧对齐的全画布素材，暂不能交给 MLT。";
    for (const clip of clips) {
      if (clip.spliceRegion || clip.splicePlaybackMode && !["normal-audio", "normal-muted"].includes(clip.splicePlaybackMode))
        return "特殊拼接片段还没有迁移到 MLT。";
      if (hasActiveNumbers(clip.settings?.color || clip.color)) return "片段调色效果还没有迁移到 MLT。";
      if (Math.abs(finite(clip.playbackRate, 1) - 1) > .0001 || Math.abs(finite(clip.volume, 1) - 1) > .0001 ||
          Math.abs(finite(clip.pan, 0)) > .0001 || Math.abs(finite(clip.fadeIn, 0)) > .0001 || Math.abs(finite(clip.fadeOut, 0)) > .0001)
        return "片段变速、音量、声像或淡化效果还没有迁移到 MLT。";
      if (clip._kind !== "main" && (
        Math.abs(finite(clip.x, 0)) > .001 || Math.abs(finite(clip.y, 0)) > .001 ||
        Math.abs(finite(clip.scale, 1) - 1) > .001 || Math.abs(finite(clip.rotation, 0)) > .001 ||
        Math.abs(finite(clip.opacity, 1) - 1) > .001 ||
        [clip.cropTop, clip.cropBottom, clip.cropLeft, clip.cropRight].some(value => Math.abs(finite(value, 0)) > .001)
      )) return "叠加素材的位置、缩放或裁切还没有迁移到 MLT。";
    }
    for (const clip of [...(config.mainAudioClips || []), ...(config.audioAssets || [])]) {
      if (Math.abs(finite(clip.playbackRate, 1) - 1) > .0001 || Math.abs(finite(clip.volume, 1) - 1) > .0001 ||
          Math.abs(finite(clip.pan, 0)) > .0001 || Math.abs(finite(clip.fadeIn, 0)) > .0001 || Math.abs(finite(clip.fadeOut, 0)) > .0001 ||
          Math.abs(finite(clip.spliceMuteStart, 0)) > .0001 || Math.abs(finite(clip.spliceMuteUntil, 0)) > .0001 ||
          (clip.fxRack || []).some(effect => effect.enabled !== false))
        return "音轨变速、音量、声像、淡化或剪辑静音还没有迁移到 MLT。";
    }
    if (hasActiveNumbers(config.color)) return "全局调色效果还没有迁移到 MLT。";
    return "";
  }

  function packTracks(items, prefix, fps, fpsDenominator) {
    const byTrack = new Map();
    for (const item of items) {
      const trackId = String(item.trackId || prefix);
      if (!byTrack.has(trackId)) byTrack.set(trackId, []);
      byTrack.get(trackId).push(item);
    }
    const packed = [];
    for (const [trackId, group] of byTrack) {
      const lanes = [];
      group.sort((left, right) => finite(left.start) - finite(right.start) ||
        finite(left.compoundStackOrder, 0) - finite(right.compoundStackOrder, 0));
      for (const item of group) {
        const startFrame = Math.max(0, Math.round(finite(item.start) * fps / fpsDenominator));
        const endFrame = Math.max(startFrame + 1, Math.round(finite(item.end) * fps / fpsDenominator));
        const lane = lanes.find(candidate => candidate.endFrame <= startFrame) || { items: [], endFrame: 0 };
        lane.items.push({ ...item, startFrame, endFrame, durationFrames: endFrame - startFrame });
        lane.endFrame = endFrame;
        if (!packed.includes(lane)) packed.push(Object.assign(lane, { trackId, laneIndex: lanes.length }));
        if (!lanes.includes(lane)) lanes.push(lane);
      }
    }
    return packed;
  }

  function colorFilterXml(chainId, item, fps) {
    const color = item.settings?.color || item.color || {};
    const filters = [];
    const brightness = finite(color.exposure, 0) + finite(color.lift, 0) * .24 + finite(color.gain, 0) * .3 +
      finite(color.gamma, 0) * .35 + finite(color.shadows, 0) * .13 + finite(color.highlights, 0) * .11 +
      finite(color.blacks, 0) * .08 + finite(color.whites, 0) * .1 + finite(color.pivot, 0) * -.08;
    if (Math.abs(brightness) > .001) filters.push(`<filter id="${chainId}_brightness"><property name="mlt_service">brightness</property><property name="level">${(1 + brightness / 78).toFixed(5)}</property></filter>`);
    const gamma = finite(color.gamma, 0);
    if (Math.abs(gamma) > .001) filters.push(`<filter id="${chainId}_gamma"><property name="mlt_service">gamma</property><property name="gamma">${Math.max(.1, Math.min(4, 1 - gamma / 100)).toFixed(5)}</property></filter>`);
    if (Math.abs(finite(color.saturation, 0)) > .001) {
      filters.push(`<filter id="${chainId}_saturation"><property name="mlt_service">avfilter.eq</property><property name="av.saturation">${Math.max(0, 1 + finite(color.saturation, 0) / 70).toFixed(5)}</property><property name="position">frame</property></filter>`);
    }
    return filters.join("");
  }

  function compile(config = {}) {
    const normalizedPath = value => String(value || "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
    const outputPath = normalizedPath(config.outputPath);
    const sourcePaths = [
      config.inputPath,
      ...(config.mainVideoClips || []).map(item => item.path || item.sourcePath),
      ...(config.mainAudioClips || []).map(item => item.path || item.sourcePath),
      ...(config.videoLayers || []).map(item => item.path || item.sourcePath),
      ...(config.audioAssets || []).map(item => item.path || item.sourcePath),
      ...(config.images || []).map(item => item.path || item.sourcePath),
    ].map(normalizedPath).filter(Boolean);
    if (outputPath && sourcePaths.includes(outputPath))
      return { supported: false, fatal: true, reason: "导出路径与时间线中的源素材相同。请另选文件名，避免覆盖原素材。" };
    const unsupportedReason = unsupported(config);
    if (unsupportedReason) return { supported: false, reason: unsupportedReason };

    const rate = frameRate(config);
    const fps = rate.numerator / rate.denominator;
    const width = Math.max(16, Math.round(finite(config.width, 1920)));
    const height = Math.max(16, Math.round(finite(config.height, 1080)));
    const durationFrames = Math.max(1, Math.round(finite(config.outputDuration, .04) * rate.numerator / rate.denominator));
    const media = [];
    const usedSourcePaths = new Set();
    let mediaIndex = 0;
    let invalidSourceDuration = false;
    const makeMedia = (item, kind, defaultPath) => {
      const sourcePath = String(item.path || item.sourcePath || defaultPath || "");
      if (!sourcePath) return null;
      usedSourcePaths.add(sourcePath);
      const startFrame = Math.max(0, Math.round(finite(item.start, 0) * rate.numerator / rate.denominator));
      const endFrame = Math.max(startFrame + 1, Math.round(finite(item.end, finite(config.outputDuration, .04)) * rate.numerator / rate.denominator));
      const sourceStartFrame = kind === "image" ? 0 : Math.max(0, Math.round(finite(item.sourceStart, 0) * rate.numerator / rate.denominator));
      const requestedSourceFrames = kind === "image" ? endFrame - startFrame : Math.max(1, Math.round(
        (finite(item.sourceEnd, finite(item.sourceStart, 0) + (endFrame - startFrame) * rate.denominator / rate.numerator) -
          finite(item.sourceStart, 0)) * rate.numerator / rate.denominator,
      ));
      if (kind !== "image" && Math.abs(requestedSourceFrames - (endFrame - startFrame)) > 1)
        invalidSourceDuration = true;
      const sourceFrames = endFrame - startFrame;
      const id = `media${mediaIndex++}`;
      const stillLoop = kind === "image" ? "<property name=\"eof\">loop</property>" : "";
      const chain = `<chain id="${id}"><property name="resource">${escapeXml(sourcePath)}</property><property name="mlt_service">avformat</property>${stillLoop}${colorFilterXml(id, item, fps)}</chain>`;
      media.push(chain);
      return { ...item, _producer: id, startFrame, endFrame, durationFrames: endFrame - startFrame, sourceStartFrame, sourceFrames, kind };
    };

    const visible = (item, fallbackTrack) => config.trackVisibility?.[item.trackId || fallbackTrack] !== false;
    const mainVideo = (config.includeVideo === false ? [] : (config.mainVideoClips || []).filter(item => visible(item, "video")))
      .map(item => makeMedia(item, "video", config.inputPath)).filter(Boolean);
    const videoLayers = (config.includeVideo === false ? [] : (config.videoLayers || []).filter(item => visible(item, "video")))
      .map(item => makeMedia(item, "video", config.inputPath)).filter(Boolean);
    const images = (config.images || []).map(item => makeMedia(item, "image", "")).filter(Boolean);
    const mainAudio = (config.includeAudio === false ? [] : (config.mainAudioClips || []).filter(item => !item.muted && visible(item, "audio")))
      .map(item => makeMedia(item, "audio", config.mainAudioPath || config.inputPath)).filter(Boolean);
    const extraAudio = (config.includeAudio === false ? [] : (config.audioAssets || []).filter(item => !item.muted && visible(item, "audio")))
      .map(item => makeMedia(item, "audio", "")).filter(Boolean);

    if (invalidSourceDuration) return { supported: false, reason: "片段的源范围和时间线长度不一致，MLT 变速映射尚未迁移。" };

    if (!mainVideo.length && !videoLayers.length && !images.length && config.includeVideo !== false)
      return { supported: false, reason: "时间线没有可供 MLT 渲染的视频素材。" };
    const videoItems = [...mainVideo, ...videoLayers, ...images];
    const audioItems = [...mainAudio, ...extraAudio];
    const videoTracks = packTracks(videoItems, "video", rate.numerator, rate.denominator);
    const audioTracks = packTracks(audioItems, "audio", rate.numerator, rate.denominator);
    if (!videoTracks.length && !audioTracks.length)
      return { supported: false, reason: "时间线没有可供 MLT 渲染的视频或音频素材。" };
    if (["mp3", "wav"].includes(String(config.format || "").toLowerCase()) && !audioTracks.length)
      return { supported: false, reason: "音频导出没有可供 MLT 渲染的音轨。" };
    const trackRank = new Map((config.trackOrder || []).map((id, index) => [String(id), index]));
    const sortTracks = tracks => tracks.sort((left, right) =>
      (trackRank.get(right.trackId) ?? 10000) - (trackRank.get(left.trackId) ?? 10000) || left.laneIndex - right.laneIndex);
    sortTracks(videoTracks); sortTracks(audioTracks);

    let playlistIndex = 0;
    const playlistXml = (track, type) => {
      const playlistId = `playlist${playlistIndex++}`;
      track.playlistId = playlistId;
      let cursor = 0;
      const entries = [];
      for (const item of track.items) {
        if (item.startFrame > cursor) entries.push(`<blank length="${item.startFrame - cursor}"/>`);
        const sourceFrames = item.sourceFrames;
        const out = item.sourceStartFrame + Math.max(1, sourceFrames) - 1;
        entries.push(`<entry producer="${item._producer}" in="${item.sourceStartFrame}" out="${out}"/>`);
        cursor = item.endFrame;
      }
      if (cursor < durationFrames) entries.push(`<blank length="${durationFrames - cursor}"/>`);
      return `<playlist id="${playlistId}"><property name="clipassistant:track">${escapeXml(track.trackId)}</property>${entries.join("")}</playlist>`;
    };

    const playlists = [];
    for (const track of videoTracks) playlists.push(playlistXml(track, "video"));
    for (const track of audioTracks) playlists.push(playlistXml(track, "audio"));
    const backgroundId = "background";
    const background = `<producer id="${backgroundId}" in="0" out="${durationFrames - 1}"><property name="resource">0xff000000</property><property name="mlt_service">color</property><property name="eof">pause</property></producer>`;
    const trackRefs = [`<track producer="${backgroundId}" hide="audio"/>`];
    for (const track of videoTracks) trackRefs.push(`<track producer="${track.playlistId}" hide="audio"/>`);
    for (const track of audioTracks) trackRefs.push(`<track producer="${track.playlistId}" hide="video"/>`);

    let transitionIndex = 0;
    const transitions = [];
    if (config.includeVideo !== false) {
      videoTracks.forEach((track, index) => {
        const bTrack = index + 1;
        transitions.push(`<transition id="video_mix${transitionIndex++}" in="0" out="${durationFrames - 1}"><property name="a_track">0</property><property name="b_track">${bTrack}</property><property name="mlt_service">affine</property><property name="transition.rect">0%/0%:100%x100%:100%</property><property name="transition.distort">0</property></transition>`);
      });
    }
    const audioOffset = 1 + videoTracks.length;
    if (audioTracks.length > 1) {
      for (let index = 1; index < audioTracks.length; index++) {
        transitions.push(`<transition id="audio_mix${transitionIndex++}" in="0" out="${durationFrames - 1}"><property name="a_track">${audioOffset}</property><property name="b_track">${audioOffset + index}</property><property name="mlt_service">mix</property><property name="always_active">1</property><property name="sum">1</property><property name="start">1.0</property><property name="end">1.0</property></transition>`);
      }
    }

    const profile = `<profile description="ClipAssistant" width="${width}" height="${height}" frame_rate_num="${rate.numerator}" frame_rate_den="${rate.denominator}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${width / gcd(width, height)}" display_aspect_den="${height / gcd(width, height)}" colorspace="709"/>`;
    const tractor = `<tractor id="tractor0" in="0" out="${durationFrames - 1}"><multitrack>${trackRefs.join("")}</multitrack>${transitions.join("")}</tractor>`;
    const projectXml = `<?xml version="1.0" encoding="UTF-8"?><mlt LC_NUMERIC="C" version="7.42.0" producer="tractor0">${profile}${background}${media.join("")}${playlists.join("")}${tractor}</mlt>`;
    return {
      supported: true,
      projectXml,
      sourcePaths: [...usedSourcePaths],
      outputPath: config.outputPath,
      format: config.format,
      codec: config.codec,
      sourceCodec: config.sourceCodec || "",
      bitrate: config.bitrate,
      audioBitrate: config.audioBitrate || "192k",
      qualityMode: config.qualityMode || "balanced",
      width,
      height,
      fpsNumerator: rate.numerator,
      fpsDenominator: rate.denominator,
      totalFrames: durationFrames,
      includeVideo: config.includeVideo !== false,
      includeAudio: config.includeAudio !== false,
    };
  }

  window.ClipAssistantMlt = Object.freeze({ compile });
})();

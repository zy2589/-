import { renderSlotLimit, freeGpuMemoryMiB } from './render-budget.mjs';
import { exportSpeed, applyExportSpeed } from './export-speed.mjs';
import { appendBeautyGraph } from './beauty.mjs';
import { colorRecipeFilters } from "../color-recipe.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { prepareExportDestination, commitExportDestination } from './export-destination.mjs';
import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mediaBinary,
  supportRoot,
  forceKillProcess,
  videoEncodeArgs,
  preferredVideoEncoder,
  preferredExportDecodeKind,
  normalizeExportDevice,
  encoderDisplayName,
  isHardwareEncoder,
  listBusyGpuApps,
  shouldSkipHardwareForBusyGpu,
  exportStallLimit,
  encoderStallMessage,
  exportIsStalled,
  isSpawnTooLongError,
  compactFfmpegFilterArgs,
  WINDOWS_SPAWN_SAFE_CHARS,
  shouldWriteFilterComplexScript,
  probeMedia,
  probeMediaAsync,
  sourceGeometry,
  sourceOrientationFilters,
  detectExportHardware,
  resetExportHardwareProbe,
  captionRasterItems,
  captionRastersUseMovieFilter,
  collectExportExtraInputs,
  composeCaptionRasterConcat,
  escapeFilterPath,
  escapeDrawtext,
  run,
  hasAudioFilter,
  decodeAccelArgs,
} from "./core.mjs";
import { buildProfessionalDenoiseChain, audioMasterFilter } from "./denoise.mjs";
import { writeAssSubtitleFile, animatedPosition } from "./ass.mjs";
import { buildAudioExportGraph, appendMainClipAudioFilters, appendExternalAudio, buildMainAudioClipsGraph, keptSegments } from "./audio-fx.mjs";
import { normalizeAudioFxRack } from "../audio-fx.mjs";
import { isDarwin, isWindows } from "../platform.mjs";
import { compileTimelineManifest, assertValidTimelineManifest } from "./timeline-manifest.mjs";

const execFileAsync = promisify(execFile);

const jobs = new Map();

function spliceRegionShapePoints(region = {}) {
  if (Array.isArray(region.points) && region.points.length >= 3) {
    const rx = Number(region.x || 0), ry = Number(region.y || 0);
    const rw = Math.max(.0001, Number(region.w || 1)), rh = Math.max(.0001, Number(region.h || 1));
    return region.points.map(([x, y]) => [Math.max(0, Math.min(1, (Number(x) - rx) / rw)), Math.max(0, Math.min(1, (Number(y) - ry) / rh))]);
  }
  const shape = String(region.shape || "rect");
  if (shape === "circle" || shape === "ellipse") return [];
  const count = shape === "pentagon" ? 5 : shape === "hexagon" ? 6 : shape === "star" ? 10 : 4;
  if (shape === "diamond") return [[.5,0],[1,.5],[.5,1],[0,.5]];
  if (shape === "triangle") return [[.5,0],[1,1],[0,1]];
  if (shape === "trapezoid") return [[.2,0],[.8,0],[1,1],[0,1]];
  if (shape === "rounded") {
    const radius = .15, points = [];
    for (const [cx, cy, start] of [[1-radius,radius,-Math.PI/2],[1-radius,1-radius,0],[radius,1-radius,Math.PI/2],[radius,radius,Math.PI]])
      for (let step=0; step<=8; step++) { const angle=start+step/8*Math.PI/2; points.push([cx+Math.cos(angle)*radius,cy+Math.sin(angle)*radius]); }
    return points;
  }
  if (["pentagon", "hexagon", "star"].includes(shape)) return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index / count * Math.PI * 2;
    const radius = shape === "star" && index % 2 ? .22 : .5;
    return [.5 + Math.cos(angle) * radius, .5 + Math.sin(angle) * radius];
  });
  return [[0,0],[1,0],[1,1],[0,1]];
}

function spliceShapeMaskExpression(region = {}, inset = 0, width = 1000, height = 1000) {
  const shape = String(region.shape || "rect");
  let mask = "";
  if (shape === "circle") {
    const radius = Math.max(1, Math.min(width, height) / 2 - Math.max(0, Math.min(Number(inset || 0), Math.min(width, height) / 2 - 1)));
    const inverseRadiusSquared = (1 / (radius * radius)).toFixed(12);
    const dx = `(X-${(width / 2).toFixed(3)})`, dy = `(Y-${(height / 2).toFixed(3)})`;
    mask = `lt(${dx}*${dx}*${inverseRadiusSquared}+${dy}*${dy}*${inverseRadiusSquared},1)`;
  } else if (shape === "ellipse") {
    const insetPx = Math.max(0, Math.min(Number(inset || 0), Math.min(width,height)/2-1));
    const radiusX = Math.max(1, width / 2 - insetPx), radiusY = Math.max(1, height / 2 - insetPx);
    const inverseRadiusXSquared = (1 / (radiusX * radiusX)).toFixed(12);
    const inverseRadiusYSquared = (1 / (radiusY * radiusY)).toFixed(12);
    const dx = `(X-${(width / 2).toFixed(3)})`, dy = `(Y-${(height / 2).toFixed(3)})`;
    mask = `lt(${dx}*${dx}*${inverseRadiusXSquared}+${dy}*${dy}*${inverseRadiusYSquared},1)`;
  } else if (shape === "square") {
    const half = `(min(W,H)/2-${Math.max(0, Math.min(Number(inset || 0), Math.min(width,height)/2-1)).toFixed(3)})`;
    mask = `lt(abs(X-W/2),${half})*lt(abs(Y-H/2),${half})`;
  } else {
    const scale = Math.max(.002, 1 - 2 * Math.max(0, Number(inset || 0)) / Math.max(1, Math.min(width, height)));
    const points = spliceRegionShapePoints(region).map(([x,y]) => [.5+(x-.5)*scale,.5+(y-.5)*scale]);
    if (points.length < 3) return "";
    const edges = points.map(([x1,y1], index) => {
      const [x2,y2] = points[(index + 1) % points.length];
      if (Math.abs(y2-y1) < 1e-7) return "0";
      const crosses = `(lt(${y1.toFixed(6)},Y/H)*gte(${y2.toFixed(6)},Y/H)+gte(${y1.toFixed(6)},Y/H)*lt(${y2.toFixed(6)},Y/H))`;
      const intersection = `(${x1.toFixed(6)}+(Y/H-${y1.toFixed(6)})*${(x2-x1).toFixed(6)}/${(y2-y1).toFixed(6)})`;
      return `(${crosses}*lt(X/W,${intersection}))`;
    });
    mask = `mod(${edges.join("+")},2)`;
  }
  return mask;
}

function spliceShapeAlphaFilter(region = {}, width = 1000, height = 1000) {
  if (String(region.shape || "rect") === "rect") return "";
  const mask = spliceShapeMaskExpression(region, 0, width, height);
  return `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(${mask},alpha(X,Y),0)'`;
}

function spliceBorderColorFilter(region = {}, width = 0, height = 0) {
  const borderWidth = Math.max(0, Number(region.borderWidth || 0));
  if (region.kind !== "pip" || borderWidth <= 0 || width < 2 || height < 2) return "";
  const match = String(region.borderColor || "").match(/^#?([0-9a-f]{6})$/i);
  const hex = match?.[1] || "68A9A2";
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const outer = spliceShapeMaskExpression(region, 0, width, height);
  const inner = spliceShapeMaskExpression(region, borderWidth, width, height);
  const edge = `(${outer})*not(${inner})`;
  return `geq=r='if(${edge},${red},r(X,Y))':g='if(${edge},${green},g(X,Y))':b='if(${edge},${blue},b(X,Y))':a='if(${outer},alpha(X,Y),0)'`;
}

function appendLoopedSpliceMask(graph, region, width, height, fps, duration, label) {
  const mask = spliceShapeMaskExpression(region, 0, width, height);
  graph.push(
    `color=c=black:s=${width}x${height}:r=1:d=0.04,format=gray,geq=lum='if(${mask},255,0)',loop=loop=-1:size=1:start=0,fps=${fps},trim=duration=${Math.max(0.04, Number(duration || 0.04)).toFixed(5)}${label}`,
  );
}

function appendLoopedSpliceBorder(graph, region, width, height, fps, duration, label) {
  const borderWidth = Math.max(0, Number(region.borderWidth || 0));
  const match = String(region.borderColor || "").match(/^#?([0-9a-f]{6})$/i);
  const hex = match?.[1] || "68A9A2";
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const outer = spliceShapeMaskExpression(region, 0, width, height);
  const inner = spliceShapeMaskExpression(region, borderWidth, width, height);
  const edge = `(${outer})*not(${inner})`;
  graph.push(
    `color=c=black:s=${width}x${height}:r=1:d=0.04,format=rgba,geq=r='${red}':g='${green}':b='${blue}':a='if(${edge},255,0)',loop=loop=-1:size=1:start=0,fps=${fps},trim=duration=${Math.max(0.04, Number(duration || 0.04)).toFixed(5)}${label}`,
  );
}

function appendLoopedSpliceAlpha(graph, inputLabel, region, width, height, fps, duration, namespace) {
  const maskLabel = `[${namespace}mask]`;
  const sourceColorLabel = `[${namespace}color]`;
  const sourceAlphaLabel = `[${namespace}sourcealpha]`;
  const sourceAlphaMaskedLabel = `[${namespace}maskedalpha]`;
  const rgbLabel = `[${namespace}rgb]`;
  const outputLabel = `[${namespace}shaped]`;
  appendLoopedSpliceMask(graph, region, width, height, fps, duration, maskLabel);
  graph.push(`${inputLabel}split=2${sourceColorLabel}${sourceAlphaLabel}`);
  graph.push(`${sourceAlphaLabel}alphaextract${`[${namespace}alpha]`}`);
  graph.push(`[${namespace}alpha]${maskLabel}blend=all_mode=multiply:shortest=1${sourceAlphaMaskedLabel}`);
  graph.push(`${sourceColorLabel}format=rgb24${rgbLabel}`);
  graph.push(`${rgbLabel}${sourceAlphaMaskedLabel}alphamerge${outputLabel}`);
  return outputLabel;
}

function appendLoopedSpliceBorderOverlay(graph, inputLabel, region, width, height, fps, duration, namespace) {
  const borderWidth = Math.max(0, Number(region.borderWidth || 0));
  if (region.kind !== "pip" || borderWidth <= 0 || width < 2 || height < 2) return inputLabel;
  const borderLabel = `[${namespace}border]`;
  const outputLabel = `[${namespace}bordered]`;
  appendLoopedSpliceBorder(graph, region, width, height, fps, duration, borderLabel);
  graph.push(`${inputLabel}${borderLabel}overlay=shortest=1:format=auto${outputLabel}`);
  return outputLabel;
}

function hasMatchingGlobalSpliceBorder(regions = [], region = {}, outputWidth = 1080) {
  const close = (left, right) => Math.abs(Number(left || 0) - Number(right || 0)) < 1e-6;
  const color = String(region.borderColor || "#68A9A2").toLowerCase();
  return (regions || []).some((candidate) =>
    Number(candidate.borderWidth || 0) > 0 &&
    close(candidate.x, region.x) && close(candidate.y, region.y) &&
    close(candidate.w, region.w) && close(candidate.h, region.h) &&
    String(candidate.shape || "rect") === String(region.shape || "rect") &&
    close(Math.round(Number(candidate.borderWidth || 0) * Number(outputWidth || 1080) / 1080), Number(region.borderWidth || 0)) &&
    String(candidate.borderColor || "#68A9A2").toLowerCase() === color,
  );
}

const colorSliceMap = Object.freeze({
  red: { colors: "r", strength: 1 },
  skin: { colors: "r+y", strength: 0.42 },
  yellow: { colors: "y", strength: 1 },
  green: { colors: "g", strength: 1 },
  cyan: { colors: "c", strength: 1 },
  blue: { colors: "b", strength: 1 },
  magenta: { colors: "m", strength: 1 },
});

const blemishClamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
function blemishCoordinateExpression(mark, axis, size, radius) {
  let keys = (Array.isArray(mark?.keyframes) ? mark.keyframes : [])
    .filter((key) => Number.isFinite(Number(key.time)) && Number.isFinite(Number(key[axis])))
    .sort((a, b) => Number(a.time) - Number(b.time));
  // Dense tracking keys make every FFmpeg expression enormous. Keep a bounded
  // set of samples so interpolation remains smooth without multiplying export
  // graph size by every point on long clips.
  if (keys.length > 96) {
    const manual = keys.filter((key) => key.manual !== false);
    const automatic = keys.filter((key) => key.manual === false);
    const keepManual = manual.length > 24
      ? Array.from({ length: 24 }, (_, index) => manual[Math.round(index * (manual.length - 1) / 23)])
      : manual;
    const remaining = 96 - keepManual.length;
    const keepAutomatic = remaining > 0 && automatic.length
      ? Array.from({ length: Math.min(remaining, automatic.length) }, (_, index) => automatic[Math.round(index * (automatic.length - 1) / Math.max(1, Math.min(remaining, automatic.length) - 1))])
      : [];
    keys = [...keepManual, ...keepAutomatic].sort((a, b) => Number(a.time) - Number(b.time));
  }
  const points = (keys.length ? keys : [{ time: 0, [axis]: Number(mark?.[axis] || 0) }])
    .map((key) => ({
      time: Math.max(0, Number(key.time) || 0),
      value: blemishClamp(Number(key[axis]) * size - radius, 0, size - radius * 2),
    }));
  const fmt = (value) => Number(value).toFixed(4);
  if (points.length === 1) return fmt(points[0].value);
  const terms = [`${fmt(points[0].value)}*lte(t,${fmt(points[0].time)})`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index], right = points[index + 1];
    const span = Math.max(0.001, right.time - left.time);
    const interpolation = `${fmt(left.value)}+(${fmt(right.value - left.value)})*(t-${fmt(left.time)})/${fmt(span)}`;
    terms.push(`(${interpolation})*gt(t,${fmt(left.time)})*lte(t,${fmt(right.time)})`);
  }
  terms.push(`${fmt(points.at(-1).value)}*gt(t,${fmt(points.at(-1).time)})`);
  return terms.join("+");
}
function appendBlemishRetouch(graph, input, marks, width, height, fps, duration) {
  let current = input;
  if (!Array.isArray(marks) || !marks.length || width < 2 || height < 2) return current;
  const repairs = marks.slice(0, 48).map((mark) => {
    const radius = Math.max(3, Math.min(Math.round(width * 0.025), Math.round(Number(mark.radius || 0.017) * width)));
    const x = blemishCoordinateExpression(mark, "x", width, radius);
    const y = blemishCoordinateExpression(mark, "y", height, radius);
    const strength = blemishClamp(Number(mark.strength || 72) / 100, 0.2, 1);
    return { radius, x, y, strength };
  });
  if (!repairs.length) return current;
  // Previously each point ran delogo plus a full-frame mask and merge. That
  // repeated work 48 times per frame and made long exports crawl. Build one
  // feathered union mask, blur the source once, then merge once.
  const maxRadius = Math.max(...repairs.map((repair) => repair.radius));
  const patchBlur = Math.max(1.6, Math.min(7, maxRadius * 0.34));
  const feather = Math.max(1, Math.min(6, maxRadius * 0.28));
  const drawBoxes = repairs.map(({ radius, x, y, strength }) =>
    `drawbox=x='${x}':y='${y}':w=${radius * 2}:h=${radius * 2}:color=white@${strength.toFixed(3)}:t=fill`,
  ).join(",");
  graph.push(`${current}format=gbrp,split=2[blemishOriginal][blemishSoftInput]`);
  graph.push(`[blemishSoftInput]gblur=sigma=${patchBlur.toFixed(2)},format=gbrp[blemishSoft]`);
  graph.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${duration.toFixed(5)},format=gray,${drawBoxes},gblur=sigma=${feather.toFixed(2)},format=gbrp[blemishMask]`);
  graph.push(`[blemishOriginal][blemishSoft][blemishMask]maskedmerge[blemishRetouched]`);
  return "[blemishRetouched]";
}

export function colorSliceFilters(color = {}) {
  const slices = color?.slices || {};
  return Object.entries(colorSliceMap).flatMap(([key, options]) => {
    const value = slices[key] || {};
    const hue = Math.max(-180, Math.min(180, Number(value.hue || 0) * 1.8));
    const saturation = Math.max(-1, Math.min(1, Number(value.saturation || 0) / 100));
    const intensity = Math.max(-1, Math.min(1, Number(value.intensity || 0) / 100));
    if (Math.abs(hue) < 0.001 && Math.abs(saturation) < 0.001 && Math.abs(intensity) < 0.001)
      return [];
    return [`huesaturation=hue=${hue.toFixed(3)}:saturation=${saturation.toFixed(3)}:intensity=${intensity.toFixed(3)}:colors=${options.colors}:strength=${options.strength}:lightness=1`];
  });
}

export function colorAdjustmentsAreDefault(color = {}) {
  return Object.entries(color || {}).every(([key, value]) => {
    if (key !== "slices") return Math.abs(Number(value || 0)) < 0.001;
    return Object.values(value || {}).every((slice) =>
      ["hue", "saturation", "intensity"].every(
        (property) => Math.abs(Number(slice?.[property] || 0)) < 0.001,
      ),
    );
  });
}

export function buildExportGraph(config, info) {
  const width = Math.max(320, Math.round(config.width || 1080));
  const height = Math.max(320, Math.round(config.height || 1920));
  let fps = Math.max(1, Math.min(240, Number(config.fps || 30)));
  const segments = keptSegments(info.duration, config.removals || []);
  if (!segments.length && !(config.videoLayers||[]).length && !(config.images||[]).length) throw new Error("所有视频内容都被删除了，无法导出。");
  const graph = [];
  const speed = Math.max(0.05, Math.min(100, Number(config.audio?.speed || 1)));
  const legacyOffset = Math.max(0, Number(config.mainTimelineOffset || 0));
  let legacyCursor = legacyOffset;
  const fallbackMainClips = segments.map((segment) => {
    const duration = (segment.end - segment.start) / speed;
    const clip = {
      sourceStart: segment.start,
      sourceEnd: segment.end,
      start: legacyCursor,
      end: legacyCursor + duration,
      trackId: "video",
    };
    legacyCursor += duration;
    return clip;
  });
  const hasExplicitMainClips = Array.isArray(config.mainVideoClips);
  const rawMainVideoClips = hasExplicitMainClips ? config.mainVideoClips : fallbackMainClips;
  // Keep adjacent edit boundaries on the output frame grid. Tiny sub-frame gaps
  // caused by speed conversion / floating-point rounding must never expose the
  // black composition canvas between two clips. Preserve deliberate gaps.
  let frameDuration = 1 / fps;
  // Normalize all edit points on one integer frame grid. Pause-cut can create a
  // very large number of adjacent clips; speed conversion then leaves tiny
  // floating-point gaps unless every boundary is derived from frame numbers.
  // Snap only near-adjacent edits so deliberate timeline gaps are preserved.
  const manifest = assertValidTimelineManifest(compileTimelineManifest({
    ...config,
    mainVideoClips: rawMainVideoClips,
    mainAudioClips: Array.isArray(config.mainAudioClips)
      ? config.mainAudioClips
      : rawMainVideoClips,
  }, info));
  fps = manifest.fps;
  frameDuration = manifest.frameDuration;
  const mainVideoClips = manifest.video;
  // The muxer, video graph and audio graph must stop on the same output-frame
  // boundary. A fractional -t that falls between frames can otherwise request
  // one more encoded frame after the visible main layer has ended.
  const outputDuration = manifest.duration;
  const targetFrameCount = manifest.targetFrameCount;
  const lastVideoEnd = Number(mainVideoClips[mainVideoClips.length - 1]?.end || 0);
  const tailDelta = outputDuration - lastVideoEnd;
  // A/V encoders and speed conversion can leave the requested mux duration a
  // few frames beyond the last decoded video frame. Treat only this small tail
  // as a rounding artifact; a longer user-created tail remains a real gap.
  const tailRepairLimit = frameDuration * 1.01;
  const repairGeneratedTail = tailDelta > 0.001 && tailDelta <= tailRepairLimit;
  const finalFrameHold = frameDuration * 1.25 + (repairGeneratedTail ? tailDelta : 0);
  const oriented = sourceOrientationFilters(info, { width, height });
  const uniformSpeed = mainVideoClips.every(clip=>Math.abs(Number(clip.playbackRate||speed)-speed)<1e-7);
  const linearCutMode = mainClipsUseConcat(mainVideoClips);
  const continuousLinearMode = linearCutMode
    && uniformSpeed
    && targetFrameCount - manifest.videoEndFrame <= 1
    && mainVideoClips.every((clip, index) =>
      index === 0 || clip.startFrame === mainVideoClips[index - 1].endFrame,
    );
  const firstClipColor = JSON.stringify(mainVideoClips[0]?.settings?.color || {});
  const uniformClipColor = mainVideoClips.every((clip) => JSON.stringify(clip.settings?.color || {}) === firstClipColor);
  const spliceVisualActive = mainVideoClips.some((clip) => clip.settings?.spliceRegion || ["freeze-resume", "freeze-hold"].includes(clip.settings?.splicePlaybackMode));
  const sharedSpliceConcatMode = uniformClipColor && uniformSpeed && !linearCutMode && mainClipsUseSharedSpliceConcat(
    mainVideoClips,
    repairGeneratedTail ? lastVideoEnd : outputDuration,
    speed,
  );
  const sharedVisualConcatMode = !spliceVisualActive && uniformClipColor && uniformSpeed && !linearCutMode && mainClipsUseSharedVisualConcat(
    mainVideoClips,
    repairGeneratedTail ? lastVideoEnd : outputDuration,
  );
  if (continuousLinearMode) {
    const labels = mainVideoClips.map((clip, index) => {
      const label = `[linearsource${index}]`;
      const gradeFilters = colorRecipeFilters(clip.settings?.color || {});
      graph.push(
        `[0:v]trim=start=${Number(clip.sourceStart).toFixed(5)}:end=${Number(clip.sourceEnd).toFixed(5)},setpts=PTS-STARTPTS,${gradeFilters.join(",")},format=yuv420p${label}`,
      );
      return label;
    });
    if (labels.length === 1) graph.push(`${labels[0]}null[linearsource]`);
    else graph.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[linearsource]`);
    graph.push(
      `[linearsource]setpts=(PTS-STARTPTS)/${speed.toFixed(6)},trim=duration=${outputDuration.toFixed(5)},setpts=PTS-STARTPTS,${oriented.filters.join(",")},format=yuv420p,tpad=stop_mode=clone:stop_duration=${finalFrameHold.toFixed(5)},trim=duration=${outputDuration.toFixed(5)}[joinedv]`,
    );
  } else if (linearCutMode) {
    const labels = [];
    const size = `${oriented.displayWidth}x${oriented.displayHeight}`;
    let cursor = 0;
    let gapIndex = 0;
    const pushGap = (duration) => {
      const label = `[vgap${gapIndex}]`;
      graph.push(
        `color=c=black:s=${size}:r=${fps}:d=${Math.max(0.02, duration).toFixed(5)},format=yuv420p${label}`,
      );
      labels.push(label);
      gapIndex += 1;
    };
    [...mainVideoClips]
      .sort((left, right) => Number(left.start || 0) - Number(right.start || 0))
      .forEach((clip, index) => {
        const clipSpeed = Number(clip.playbackRate || speed);
        const start = Math.max(0, Number(clip.start || 0));
        const end = Math.max(start + 0.002, Number(clip.end || start));
        const sourceStart = Math.max(0, Number(clip.sourceStart || 0));
        const sourceEnd = Math.max(
          sourceStart + 0.002,
          Number(clip.sourceEnd || sourceStart + (end - start) * speed),
        );
        if (start > cursor + 0.005) pushGap(start - cursor);
        const timelineDuration = Math.max(frameDuration, end - start);
        const gradeFilters = colorRecipeFilters(clip.settings?.color || {});
        graph.push(
          `[0:v]trim=start=${sourceStart.toFixed(5)}:end=${sourceEnd.toFixed(5)},setpts=(PTS-STARTPTS)/${clipSpeed.toFixed(7)},fps=${fps},tpad=stop_mode=clone:stop_duration=${(1/fps).toFixed(7)},trim=end_frame=${Math.round(timelineDuration*fps)},setpts=N/(${fps}*TB),${oriented.filters.join(",")},${gradeFilters.join(",")},format=yuv420p[vcut${index}]`,
        );
        labels.push(`[vcut${index}]`);
        cursor = Math.max(cursor, end);
      });
    if (outputDuration > cursor + 0.005 && !repairGeneratedTail) pushGap(outputDuration - cursor);
    if (labels.length === 1) {
      graph.push(`${labels[0]}tpad=stop_mode=clone:stop_duration=${finalFrameHold.toFixed(5)},trim=duration=${outputDuration.toFixed(5)},setpts=PTS-STARTPTS[joinedv]`);
    } else {
      graph.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[joinedv0]`);
      graph.push(
        `[joinedv0]setpts=N/(${fps}*TB),tpad=stop_mode=clone:stop_duration=${Math.max(0.08, finalFrameHold).toFixed(5)},trim=end_frame=${targetFrameCount},setpts=PTS-STARTPTS[joinedv]`,
      );
    }
  } else if (sharedSpliceConcatMode) {
    // Pause-cut can leave many adjacent clips carrying the same PIP layout.
    // Joining those source ranges first avoids repeating scale, shape-mask,
    // border and full-canvas overlay filters for every fragment.
    const labels = [];
    [...mainVideoClips]
      .sort((left, right) => Number(left.start || 0) - Number(right.start || 0))
      .forEach((clip, index) => {
        const sourceStart = Math.max(0, Number(clip.sourceStart || 0));
        const sourceEnd = Math.max(sourceStart + 0.002, Number(clip.sourceEnd || sourceStart));
        const clipSpeed = Number(clip.playbackRate || speed);
        const timelineDuration = Math.max(frameDuration, Number(clip.end || 0) - Number(clip.start || 0));
        graph.push(
          `[0:v]trim=start=${sourceStart.toFixed(5)}:end=${sourceEnd.toFixed(5)},setpts=(PTS-STARTPTS)/${clipSpeed.toFixed(7)},fps=${fps},tpad=stop_mode=clone:stop_duration=${frameDuration.toFixed(7)},trim=end_frame=${Math.round(timelineDuration * fps)},setpts=N/(${fps}*TB),format=yuv420p[sharedsplicecut${index}]`,
        );
        labels.push(`[sharedsplicecut${index}]`);
      });
    if (labels.length === 1) graph.push(`${labels[0]}null[sharedsplicesource]`);
    else graph.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[sharedsplicesource]`);

    const settings = mainVideoClips[0]?.settings || {};
    const region = settings.spliceRegion;
    const targetW = Math.max(8, Math.round(width * Number(region.w)));
    const targetH = Math.max(8, Math.round(height * Number(region.h)));
    const clipScale = Math.max(0.05, Number(settings.scale || 1));
    const cropTop = Math.max(0, Math.min(95, Number(settings.cropTop || 0)));
    const cropBottom = Math.max(0, Math.min(95, Number(settings.cropBottom || 0)));
    const cropLeft = Math.max(0, Math.min(95, Number(settings.cropLeft || 0)));
    const cropRight = Math.max(0, Math.min(95, Number(settings.cropRight || 0)));
    const cropW = Math.max(0.01, 1 - (cropLeft + cropRight) / 100);
    const cropH = Math.max(0.01, 1 - (cropTop + cropBottom) / 100);
    const transformFilters = [...oriented.filters, ...colorRecipeFilters(settings.color || {})];
    if (cropTop > 0 || cropBottom > 0 || cropLeft > 0 || cropRight > 0)
      transformFilters.push(`crop=w=iw*${cropW.toFixed(4)}:h=ih*${cropH.toFixed(4)}:x=iw*${(cropLeft / 100).toFixed(4)}:y=ih*${(cropTop / 100).toFixed(4)}`);
    const rotation = Math.max(-360, Math.min(360, Number(settings.rotation || 0)));
    if (Math.abs(rotation) > 0.001)
      transformFilters.push(`rotate=${rotation.toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`);
    transformFilters.push(
      `scale=w=${Math.max(8, Math.round(targetW * clipScale))}:h=${Math.max(8, Math.round(targetH * clipScale))}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd`,
      `crop=w=${targetW}:h=${targetH}:x='max(0,min(iw-ow,(iw-ow)/2-${Number(settings.x || 0).toFixed(3)}))':y='max(0,min(ih-oh,(ih-oh)/2-${Number(settings.y || 0).toFixed(3)}))'`,
    );
    const shapeMask = spliceShapeAlphaFilter(region, targetW, targetH);
    if (shapeMask) transformFilters.push("format=rgba", shapeMask);
    const borderFilter = spliceBorderColorFilter(region, targetW, targetH);
    if (borderFilter) transformFilters.push("format=rgba", borderFilter);
    const opacity = Math.max(0, Math.min(1, Number(settings.opacity ?? 1)));
    if (opacity < 0.999)
      transformFilters.push("format=rgba", `colorchannelmixer=aa=${opacity.toFixed(4)}`);

    graph.push(
      `[sharedsplicesource]setpts=PTS-STARTPTS,${transformFilters.join(",")},tpad=stop_mode=clone:stop_duration=${finalFrameHold.toFixed(5)},trim=duration=${outputDuration.toFixed(5)}[sharedsplicevisual]`,
    );
    graph.push(`color=c=black:s=${oriented.displayWidth}x${oriented.displayHeight}:r=${fps}:d=${outputDuration.toFixed(5)}[sharedsplicecanvas]`);
    graph.push(
      `[sharedsplicecanvas][sharedsplicevisual]overlay=x=${Math.round(Number(region.x || 0) * width)}:y=${Math.round(Number(region.y || 0) * height)}:eof_action=pass:shortest=0[joinedv]`,
    );
  } else if (sharedVisualConcatMode) {
    // Pause-cut commonly creates dozens of fragments with exactly the same
    // canvas transform. Concatenate the source cuts first and apply scale/crop/
    // rotation only once. This avoids N expensive scale+overlay pipelines while
    // preserving the already proven no-black-frame boundary behavior.
    const labels = [];
    [...mainVideoClips]
      .sort((left, right) => Number(left.start || 0) - Number(right.start || 0))
      .forEach((clip, index) => {
        const sourceStart = Math.max(0, Number(clip.sourceStart || 0));
        const sourceEnd = Math.max(sourceStart + 0.002, Number(clip.sourceEnd || sourceStart));
        graph.push(
          `[0:v]trim=start=${sourceStart.toFixed(5)}:end=${sourceEnd.toFixed(5)},setpts=PTS-STARTPTS,format=yuv420p[sharedcut${index}]`,
        );
        labels.push(`[sharedcut${index}]`);
      });
    if (labels.length === 1) graph.push(`${labels[0]}null[sharedsource]`);
    else graph.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[sharedsource]`);
    graph.push(`[sharedsource]setpts=(PTS-STARTPTS)/${speed.toFixed(6)},trim=duration=${outputDuration.toFixed(5)},setpts=PTS-STARTPTS[sharedjoined0]`);
    const settings = mainVideoClips[0]?.settings || {};
    const cropTop = Math.max(0, Math.min(95, Number(settings.cropTop || 0)));
    const cropBottom = Math.max(0, Math.min(95, Number(settings.cropBottom || 0)));
    const cropLeft = Math.max(0, Math.min(95, Number(settings.cropLeft || 0)));
    const cropRight = Math.max(0, Math.min(95, Number(settings.cropRight || 0)));
    const clipScale = Math.max(0.05, Number(settings.scale || 1));
    const rotation = Math.max(-360, Math.min(360, Number(settings.rotation || 0)));
    const opacity = Math.max(0, Math.min(1, Number(settings.opacity ?? 1)));
    const cropW = Math.max(0.01, 1 - (cropLeft + cropRight) / 100);
    const cropH = Math.max(0.01, 1 - (cropTop + cropBottom) / 100);
    const transformFilters = [...oriented.filters, ...colorRecipeFilters(settings.color || {}), `scale=iw*${clipScale.toFixed(5)}:ih*${clipScale.toFixed(5)}:flags=lanczos+accurate_rnd`];
    if (cropTop > 0 || cropBottom > 0 || cropLeft > 0 || cropRight > 0)
      transformFilters.push(`crop=w=iw*${cropW.toFixed(4)}:h=ih*${cropH.toFixed(4)}:x=iw*${(cropLeft / 100).toFixed(4)}:y=ih*${(cropTop / 100).toFixed(4)}`);
    if (Math.abs(rotation) > 0.001)
      transformFilters.push(`rotate=${rotation.toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`);
    if (opacity < 0.999) transformFilters.push(`format=rgba,colorchannelmixer=aa=${opacity.toFixed(4)}`);
    graph.push(`[sharedjoined0]${transformFilters.join(",")},tpad=stop_mode=clone:stop_duration=${finalFrameHold.toFixed(5)},trim=duration=${outputDuration.toFixed(5)}[sharedvisual]`);
    graph.push(`color=c=black:s=${oriented.displayWidth}x${oriented.displayHeight}:r=${fps}:d=${outputDuration.toFixed(5)}[sharedcanvas]`);
    const clipX = (cropLeft > 0 || cropRight > 0)
      ? `(W-w/${cropW.toFixed(5)})/2+${Math.round(Number(settings.x || 0))}+${(cropLeft / 100).toFixed(5)}*w/${cropW.toFixed(5)}`
      : `(W-w)/2+${Math.round(Number(settings.x || 0))}`;
    const clipY = (cropTop > 0 || cropBottom > 0)
      ? `(H-h/${cropH.toFixed(5)})/2+${Math.round(Number(settings.y || 0))}+${(cropTop / 100).toFixed(5)}*h/${cropH.toFixed(5)}`
      : `(H-h)/2+${Math.round(Number(settings.y || 0))}`;
    graph.push(`[sharedcanvas][sharedvisual]overlay=x='${clipX}':y='${clipY}':eof_action=pass:shortest=0[joinedv]`);
  } else {
    graph.push(
      `color=c=black:s=${oriented.displayWidth}x${oriented.displayHeight}:r=${fps}:d=${outputDuration.toFixed(5)}[maincanvas0]`,
    );
    mainVideoClips.forEach((clip, index) => {
    const clipSpeed = Number(clip.playbackRate || speed);
    const start = Math.max(0, Number(clip.start || 0));
    const end = Math.max(start + 0.002, Number(clip.end || start));
    const sourceStart = Math.max(0, Number(clip.sourceStart || 0));
    const sourceEnd = Math.max(
      sourceStart + 0.002,
      Number(clip.sourceEnd || sourceStart + (end - start) * speed),
    );
    const settings = clip.settings || {},
      cropTop = Math.max(0, Math.min(95, Number(settings.cropTop || 0))),
      cropBottom = Math.max(0, Math.min(95, Number(settings.cropBottom || 0))),
      cropLeft = Math.max(0, Math.min(95, Number(settings.cropLeft || 0))),
      cropRight = Math.max(0, Math.min(95, Number(settings.cropRight || 0))),
      clipScale = Math.max(0.05, Number(settings.scale || 1)),
      rotation = Math.max(-360, Math.min(360, Number(settings.rotation || 0))),
      opacity = Math.max(0, Math.min(1, Number(settings.opacity ?? 1))),
      transformFilters = [
        ...oriented.filters,
        ...colorRecipeFilters(settings.color || {}),
      ];
    const cropW = Math.max(0.01, 1 - (cropLeft + cropRight) / 100);
    const cropH = Math.max(0.01, 1 - (cropTop + cropBottom) / 100);
    const spliceRegion = settings.spliceRegion;
    if (spliceRegion && Number(spliceRegion.w) > 0 && Number(spliceRegion.h) > 0) {
      if (cropTop > 0 || cropBottom > 0 || cropLeft > 0 || cropRight > 0)
        transformFilters.push(`crop=w=iw*${cropW.toFixed(4)}:h=ih*${cropH.toFixed(4)}:x=iw*${(cropLeft / 100).toFixed(4)}:y=ih*${(cropTop / 100).toFixed(4)}`);
      if (Math.abs(rotation) > 0.001)
        transformFilters.push(`rotate=${rotation.toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`);
      const targetW = Math.max(8, Math.round(width * Number(spliceRegion.w)));
      const targetH = Math.max(8, Math.round(height * Number(spliceRegion.h)));
      transformFilters.push(`scale=w=${Math.max(8, Math.round(targetW * clipScale))}:h=${Math.max(8, Math.round(targetH * clipScale))}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd`);
      const panX = Number(settings.x || 0), panY = Number(settings.y || 0);
      transformFilters.push(`crop=w=${targetW}:h=${targetH}:x='max(0,min(iw-ow,(iw-ow)/2-${panX.toFixed(3)}))':y='max(0,min(ih-oh,(ih-oh)/2-${panY.toFixed(3)}))'`);
      const shapeMask = spliceShapeAlphaFilter(spliceRegion, targetW, targetH);
      if (shapeMask) transformFilters.push("format=rgba", shapeMask);
      const borderFilter = spliceBorderColorFilter(spliceRegion, targetW, targetH);
      if (borderFilter) transformFilters.push("format=rgba", borderFilter);
    } else {
      transformFilters.push(`scale=iw*${clipScale.toFixed(5)}:ih*${clipScale.toFixed(5)}:flags=lanczos+accurate_rnd`);
      if (cropTop > 0 || cropBottom > 0 || cropLeft > 0 || cropRight > 0) {
        transformFilters.push(`crop=w=iw*${cropW.toFixed(4)}:h=ih*${cropH.toFixed(4)}:x=iw*${(cropLeft / 100).toFixed(4)}:y=ih*${(cropTop / 100).toFixed(4)}`);
      }
      if (Math.abs(rotation) > 0.001)
        transformFilters.push(`rotate=${rotation.toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`);
    }
    if (opacity < 0.999)
      transformFilters.push(
        `format=rgba,colorchannelmixer=aa=${opacity.toFixed(4)}`,
      );
    // Put the decoded clip directly on its timeline timestamp. Do not prepend
    // synthetic black/transparent frames with tpad: those can become opaque
    // after pixel-format negotiation and leak as a one-frame flash at cuts.
    // Keep the last valid frame alive slightly beyond the nominal cut. With a
    // rebuilt canvas every clip is overlaid on a base layer; without this guard
    // a one-frame decoder/PTS delay at a pause-cut boundary reveals that base as
    // a full black flash. The following clip is stacked above the previous one,
    // so this overlap is invisible when the next frame arrives normally.
    const boundaryHold = index === mainVideoClips.length - 1 ? finalFrameHold : frameDuration * 1.25;
    const timelineDuration = Math.max(frameDuration, end - start);
    const playbackMode = settings.splicePlaybackMode || "normal-audio";
    const freezeDuration = playbackMode === "freeze-hold"
      ? timelineDuration
      : playbackMode === "freeze-resume"
        ? Math.max(0, Math.min(timelineDuration, Number(settings.spliceFreezeUntil || start) - start))
        : 0;
    if (freezeDuration > 0.001) {
      const frameDuration = 1 / Math.max(1, Number(fps || 30));
      const freezeSource = Math.max(0, Number(settings.spliceFreezeFrame ?? sourceStart));
      const holdDuration = Math.max(frameDuration, freezeDuration);
      const cloneDuration = Math.max(0, holdDuration - frameDuration);
      const holdLabel = `[mainhold${index}]`;
      graph.push(`[0:v]trim=start=${freezeSource.toFixed(7)}:duration=${frameDuration.toFixed(7)},setpts=PTS-STARTPTS,fps=${fps},tpad=stop_mode=clone:stop_duration=${cloneDuration.toFixed(7)},trim=duration=${holdDuration.toFixed(7)}${holdLabel}`);
      let sourceLabel = holdLabel;
      if (playbackMode === "freeze-resume" && timelineDuration - freezeDuration > frameDuration) {
        const resumeDuration = timelineDuration - freezeDuration;
        const resumeSource = Math.max(0, sourceStart + freezeDuration * clipSpeed);
        const resumeLabel = `[mainresume${index}]`;
        graph.push(`[0:v]trim=start=${resumeSource.toFixed(7)}:end=${sourceEnd.toFixed(7)},setpts=(PTS-STARTPTS)/${clipSpeed.toFixed(7)},fps=${fps},tpad=stop_mode=clone:stop_duration=${frameDuration.toFixed(7)},trim=duration=${resumeDuration.toFixed(7)}${resumeLabel}`);
        graph.push(`${holdLabel}${resumeLabel}concat=n=2:v=1:a=0[mainsplice${index}]`);
        sourceLabel = `[mainsplice${index}]`;
      }
      graph.push(`${sourceLabel}setpts=PTS-STARTPTS+${start.toFixed(5)}/TB,${transformFilters.join(",")},tpad=stop_mode=clone:stop_duration=${boundaryHold.toFixed(5)}[mainraw${index}]`);
    } else {
      const padded = `setpts=(PTS-STARTPTS)/${clipSpeed.toFixed(7)},trim=duration=${timelineDuration.toFixed(5)},setpts=PTS-STARTPTS+${start.toFixed(5)}/TB,${transformFilters.join(",")},tpad=stop_mode=clone:stop_duration=${boundaryHold.toFixed(5)}`;
      graph.push(
        `[0:v]trim=start=${sourceStart.toFixed(5)}:end=${sourceEnd.toFixed(5)},${padded}[mainraw${index}]`,
      );
    }
    const clipX = spliceRegion
      ? `${Math.round(Number(spliceRegion.x || 0) * width)}`
      : (cropLeft > 0 || cropRight > 0)
      ? `(W-w/${cropW.toFixed(5)})/2+${Math.round(Number(settings.x || 0))}+${(cropLeft / 100).toFixed(5)}*w/${cropW.toFixed(5)}`
      : `(W-w)/2+${Math.round(Number(settings.x || 0))}`;
    const clipY = spliceRegion
      ? `${Math.round(Number(spliceRegion.y || 0) * height)}`
      : (cropTop > 0 || cropBottom > 0)
      ? `(H-h/${cropH.toFixed(5)})/2+${Math.round(Number(settings.y || 0))}+${(cropTop / 100).toFixed(5)}*h/${cropH.toFixed(5)}`
      : `(H-h)/2+${Math.round(Number(settings.y || 0))}`;
    graph.push(
      `[maincanvas${index}][mainraw${index}]overlay=x='${clipX}':y='${clipY}':enable='gte(t,${(start-1e-7).toFixed(7)})*lt(t,${(end-1e-7).toFixed(7)})':eof_action=pass:shortest=0[maincanvas${index + 1}]`,
    );
    });
    graph.push(`[maincanvas${mainVideoClips.length}]null[joinedv]`);
  }
  const hasDenoisedMainAudio = !!(config.mainAudioPath && fs.existsSync(config.mainAudioPath));
  const hasMainAudio = !config.noMainVideoSource && !!(info.audioCodec || hasDenoisedMainAudio);
  const mainAudioInputIndex = hasDenoisedMainAudio ? 1 : 0;
  if (hasMainAudio) {
    const audioClips = manifest.audio;
    buildMainAudioClipsGraph(graph, audioClips, speed, outputDuration, "maina", mainAudioInputIndex);
  }
  const mainOffset = 0;
  let sourceVideoLabel = "[joinedv]";
  const color = config.color || {};
  const filters = colorRecipeFilters(color);
  // Normalize the already frame-aligned continuous stream once. Doing this
  // after concat avoids independent per-fragment cadence decisions that show
  // up as a repeated or dropped frame during rapid pause-cut sequences.
  filters.unshift(`fps=${fps}:round=near:start_time=0`);
  const transform = config.videoTransform || {};
  const scale = Math.max(0.05, Number(transform.scale || 1));
  const rotation = Math.max(-360, Math.min(360, Number(transform.rotation || 0)));
  filters.push(
    `scale=w=${Math.round(width * scale)}:h=${Math.round(height * scale)}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos+accurate_rnd`,
    "setsar=1",
  );
  if (Math.abs(rotation) > 0.001)
    filters.push(`rotate=${rotation.toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`);
  sourceVideoLabel = appendBlemishRetouch(graph, sourceVideoLabel, config.blemishMarks, oriented.displayWidth, oriented.displayHeight, fps, outputDuration);
  const gradedInput = appendBeautyGraph(graph,sourceVideoLabel,config.beauty || {});
  const lutPath = String(config.lut?.path || "");
  const lutStrength = Math.max(
    0,
    Math.min(1, Number(config.lut?.intensity ?? 1)),
  );
  if (lutPath && fs.existsSync(lutPath) && lutStrength > 0.001) {
    graph.push(`${gradedInput}${filters.join(",")}[gradedbase]`);
    if (lutStrength >= 0.999)
      graph.push(
        `[gradedbase]lut3d=file='${escapeFilterPath(lutPath)}':interp=tetrahedral[main]`,
      );
    else {
      graph.push(`[gradedbase]split=2[lutoriginal][lutinput]`);
      graph.push(
        `[lutinput]lut3d=file='${escapeFilterPath(lutPath)}':interp=tetrahedral[lutresult]`,
      );
      graph.push(
        `[lutoriginal][lutresult]blend=all_expr='A*${(1 - lutStrength).toFixed(4)}+B*${lutStrength.toFixed(4)}'[main]`,
      );
    }
  } else graph.push(`${gradedInput}${filters.join(",")}[main]`);
  graph.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${outputDuration.toFixed(5)}[base]`);
  const x = `(W-w)/2+${Math.round(Number(transform.x || 0))}`;
  const y = `(H-h)/2+${Math.round(Number(transform.y || 0))}`;
  let layer = 0;
  let inputIndex = hasDenoisedMainAudio ? 2 : 1;
  const mainTrackIds = [...new Set(mainVideoClips.map((clip) => clip.trackId || "video"))];
  const mainTrackLabels = new Map();
  if (mainTrackIds.length > 1) {
    const labels = mainTrackIds.map((_, index) => `[maintrack${index}]`);
    graph.push(`[main]split=${mainTrackIds.length}${labels.join("")}`);
    mainTrackIds.forEach((trackId, index) =>
      mainTrackLabels.set(trackId, labels[index]),
    );
  } else mainTrackLabels.set(mainTrackIds[0] || "video", "[main]");
  const consumedMainTracks = new Set();
  const preparedVideos = (config.videoLayers || []).map((video, index) => {
    const cropTop = Math.max(0, Math.min(95, Number(video.cropTop || 0)));
    const cropBottom = Math.max(0, Math.min(95, Number(video.cropBottom || 0)));
    const cropLeft = Math.max(0, Math.min(95, Number(video.cropLeft || 0)));
    const cropRight = Math.max(0, Math.min(95, Number(video.cropRight || 0)));
    const videoScale = Math.max(0.03, Number(video.scale || 1));
    const clipDuration = Math.max(
      0.04,
      Number(video.end || 0) - Number(video.start || 0),
    );
    const clipSpeed=Number(video.sourceEnd)>Number(video.sourceStart||0)?(Number(video.sourceEnd)-Number(video.sourceStart||0))/(video.end-video.start):speed;
    const sourceDuration = clipDuration * clipSpeed;
    const videoFilters = [...colorRecipeFilters(video.color || {})];
    const cropW = Math.max(0.01, 1 - (cropLeft + cropRight) / 100);
    const cropH = Math.max(0.01, 1 - (cropTop + cropBottom) / 100);
    const spliceRegion = video.spliceRegion;
    let spliceVideoOutput = null;
    if (spliceRegion && Number(spliceRegion.w) > 0 && Number(spliceRegion.h) > 0) {
      if (cropTop > 0 || cropBottom > 0 || cropLeft > 0 || cropRight > 0)
        videoFilters.push(`crop=w=iw*${cropW.toFixed(4)}:h=ih*${cropH.toFixed(4)}:x=iw*${(cropLeft / 100).toFixed(4)}:y=ih*${(cropTop / 100).toFixed(4)}`);
      if (Math.abs(Number(video.rotation || 0)) > 0.001)
        videoFilters.push(`rotate=${Number(video.rotation).toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`);
      const targetW = Math.max(8, Math.round(width * Number(spliceRegion.w)));
      const targetH = Math.max(8, Math.round(height * Number(spliceRegion.h)));
      videoFilters.push(`scale=w=${Math.max(8, Math.round(targetW * videoScale))}:h=${Math.max(8, Math.round(targetH * videoScale))}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd`);
      videoFilters.push(`crop=w=${targetW}:h=${targetH}:x='max(0,min(iw-ow,(iw-ow)/2-${Number(video.x || 0).toFixed(3)}))':y='max(0,min(ih-oh,(ih-oh)/2-${Number(video.y || 0).toFixed(3)}))'`);
      spliceVideoOutput = { region: spliceRegion, width: targetW, height: targetH };
    } else {
      videoFilters.push(
        `scale=w=${Math.max(8, Math.round(width * videoScale))}:h=${Math.max(8, Math.round(height * videoScale))}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd`,
      );
      if (cropTop > 0 || cropBottom > 0 || cropLeft > 0 || cropRight > 0)
        videoFilters.push(`crop=w=iw*${cropW.toFixed(4)}:h=ih*${cropH.toFixed(4)}:x=iw*${(cropLeft / 100).toFixed(4)}:y=ih*${(cropTop / 100).toFixed(4)}`);
    }
    if (Math.abs(Number(video.rotation || 0)) > 0.001)
      if (!spliceRegion) videoFilters.push(`rotate=${Number(video.rotation).toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`);
    videoFilters.push("format=rgba");
    const videoOpacity = Math.max(0, Math.min(1, Number(video.opacity ?? 1)));
    if (!spliceVideoOutput) videoFilters.push(`colorchannelmixer=aa=${videoOpacity.toFixed(3)}`);
    const emitOverlay = (sourcePrefix) => {
      const timelineLabel = `[overlayv${index}]`;
      const separator = sourcePrefix.endsWith("]") ? "" : ",";
      if (!spliceVideoOutput) {
        graph.push(`${sourcePrefix}${separator}${videoFilters.join(",")},tpad=stop_mode=clone:stop_duration=${(1/fps).toFixed(7)},setpts=PTS-STARTPTS+${overlayStart.toFixed(7)}/TB${timelineLabel}`);
        return;
      }
      const preShapeLabel = `[overlaypre${index}]`;
      graph.push(`${sourcePrefix}${separator}${videoFilters.join(",")}${preShapeLabel}`);
      let currentLabel = preShapeLabel;
      if (String(spliceVideoOutput.region.shape || "rect") !== "rect")
        currentLabel = appendLoopedSpliceAlpha(
          graph, currentLabel, spliceVideoOutput.region, spliceVideoOutput.width,
          spliceVideoOutput.height, fps, clipDuration, `videolayer${index}`,
        );
      if (!hasMatchingGlobalSpliceBorder(config.spliceRegions, spliceVideoOutput.region, width))
        currentLabel = appendLoopedSpliceBorderOverlay(
          graph, currentLabel, spliceVideoOutput.region, spliceVideoOutput.width,
          spliceVideoOutput.height, fps, clipDuration, `videolayer${index}`,
        );
      if (videoOpacity < 0.999) {
        const opacityLabel = `[overlayopacity${index}]`;
        graph.push(`${currentLabel}colorchannelmixer=aa=${videoOpacity.toFixed(3)}${opacityLabel}`);
        currentLabel = opacityLabel;
      }
      graph.push(`${currentLabel}tpad=stop_mode=clone:stop_duration=${(1/fps).toFixed(7)},setpts=PTS-STARTPTS+${overlayStart.toFixed(7)}/TB${timelineLabel}`);
    };
    const overlayStart = Math.max(0, Number(video.start || 0));
    const playbackMode = video.splicePlaybackMode || "normal-audio";
    const freezeDuration = playbackMode === "freeze-hold"
      ? clipDuration
      : playbackMode === "freeze-resume"
        ? Math.max(0, Math.min(clipDuration, Number(video.spliceFreezeUntil || overlayStart) - overlayStart))
        : 0;
    if (freezeDuration > 0.001) {
      const frameDuration = 1 / Math.max(1, Number(fps || 30));
      const freezeSource = Math.max(0, Number(video.spliceFreezeFrame ?? video.sourceStart ?? 0));
      const holdDuration = Math.max(frameDuration, freezeDuration);
      const cloneDuration = Math.max(0, holdDuration - frameDuration);
      const holdLabel = `[overlayhold${index}]`;
      graph.push(`[${inputIndex}:v]trim=start=${freezeSource.toFixed(7)}:duration=${frameDuration.toFixed(7)},setpts=PTS-STARTPTS,fps=${fps},tpad=stop_mode=clone:stop_duration=${cloneDuration.toFixed(7)},trim=duration=${holdDuration.toFixed(7)}${holdLabel}`);
      if (playbackMode === "freeze-resume" && clipDuration - freezeDuration > frameDuration) {
        const resumeDuration = clipDuration - freezeDuration;
        const resumeSource = Math.max(0, Number(video.sourceStart || 0) + freezeDuration * clipSpeed);
        const resumeLabel = `[overlayresume${index}]`;
        graph.push(`[${inputIndex}:v]trim=start=${resumeSource.toFixed(7)}:duration=${(resumeDuration * clipSpeed).toFixed(7)},setpts=(PTS-STARTPTS)/${clipSpeed.toFixed(7)},fps=${fps},tpad=stop_mode=clone:stop_duration=${frameDuration.toFixed(7)},trim=duration=${resumeDuration.toFixed(7)}${resumeLabel}`);
        graph.push(`${holdLabel}${resumeLabel}concat=n=2:v=1:a=0[overlaysplice${index}]`);
        emitOverlay(`[overlaysplice${index}]`);
      } else {
        emitOverlay(holdLabel);
      }
    } else {
      emitOverlay(`[${inputIndex}:v]trim=start=${Math.max(0,Number(video.sourceStart||0)).toFixed(7)}:duration=${sourceDuration.toFixed(7)},setpts=(PTS-STARTPTS)/${clipSpeed.toFixed(7)}`);
    }
    inputIndex += 1;
    return { video, label: `[overlayv${index}]` };
  });
  const preparedImages = (config.images || []).map((image, index) => {
    const cropTop = Math.max(0, Math.min(95, Number(image.cropTop || 0)));
    const cropBottom = Math.max(0, Math.min(95, Number(image.cropBottom || 0)));
    const cropLeft = Math.max(0, Math.min(95, Number(image.cropLeft || 0)));
    const cropRight = Math.max(0, Math.min(95, Number(image.cropRight || 0)));
    const imageScale = Math.max(0.03, Number(image.scale ?? 1));
    const imageFilters = ["setpts=PTS-STARTPTS", "format=rgba"];
    const cropW = Math.max(0.01, 1 - (cropLeft + cropRight) / 100);
    const cropH = Math.max(0.01, 1 - (cropTop + cropBottom) / 100);
    const spliceRegion = image.spliceRegion;
    if (spliceRegion && Number(spliceRegion.w) > 0 && Number(spliceRegion.h) > 0 && !image.pixelExact) {
      if (cropTop > 0 || cropBottom > 0 || cropLeft > 0 || cropRight > 0)
        imageFilters.push(`crop=w=iw*${cropW.toFixed(4)}:h=ih*${cropH.toFixed(4)}:x=iw*${(cropLeft / 100).toFixed(4)}:y=ih*${(cropTop / 100).toFixed(4)}`);
      if (Math.abs(Number(image.rotation || 0)) > 0.001)
        imageFilters.push(`rotate=${Number(image.rotation).toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`);
      const targetW = Math.max(8, Math.round(width * Number(spliceRegion.w)));
      const targetH = Math.max(8, Math.round(height * Number(spliceRegion.h)));
      imageFilters.push(`scale=w=${Math.max(8, Math.round(targetW * imageScale))}:h=${Math.max(8, Math.round(targetH * imageScale))}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd`);
      imageFilters.push(`crop=w=${targetW}:h=${targetH}:x='max(0,min(iw-ow,(iw-ow)/2-${Number(image.x || 0).toFixed(3)}))':y='max(0,min(ih-oh,(ih-oh)/2-${Number(image.y || 0).toFixed(3)}))'`);
      const shapeMask = spliceShapeAlphaFilter(spliceRegion, targetW, targetH);
      if (shapeMask) imageFilters.push("format=rgba", shapeMask);
      const borderFilter = spliceBorderColorFilter(spliceRegion, targetW, targetH);
      if (borderFilter) imageFilters.push("format=rgba", borderFilter);
    } else if (!image.pixelExact) {
      if (image.sourceWidth && image.sourceHeight) {
        const targetW = Math.max(8, Math.round(Number(image.sourceWidth) * imageScale));
        const targetH = Math.max(8, Math.round(Number(image.sourceHeight) * imageScale));
        imageFilters.push(`scale=${targetW}:${targetH}:flags=lanczos+accurate_rnd`);
      } else if (Math.abs(imageScale - 1) > 0.001) {
        imageFilters.push(`scale=trunc(iw*${imageScale.toFixed(4)}/2)*2:trunc(ih*${imageScale.toFixed(4)}/2)*2:flags=lanczos+accurate_rnd`);
      }
    }
    if (!spliceRegion && (cropTop > 0 || cropBottom > 0 || cropLeft > 0 || cropRight > 0)) {
      imageFilters.push(`crop=w=iw*${cropW.toFixed(4)}:h=ih*${cropH.toFixed(4)}:x=iw*${(cropLeft / 100).toFixed(4)}:y=ih*${(cropTop / 100).toFixed(4)}`);
    }
    if (!spliceRegion && Math.abs(Number(image.rotation || 0)) > 0.001)
      imageFilters.push(
        `rotate=${Number(image.rotation).toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`,
      );
    imageFilters.push(
      "format=rgba",
      `colorchannelmixer=aa=${Math.max(0, Math.min(1, Number(image.opacity ?? 1))).toFixed(3)}`,
    );
    if (image.enterAnimation || image.exitAnimation)
      imageFilters.push(`fps=${Math.max(1, Number(config.fps || info.frameRate || 30)).toFixed(3)}`);
    if (image.enterAnimation) {
      const duration = Math.max(0.15, Number(image.enterDuration || 0.45));
      imageFilters.push(
        `fade=t=in:st=${Math.max(0, Number(image.start || 0)).toFixed(4)}:d=${duration.toFixed(4)}:alpha=1`,
      );
    }
    if (image.exitAnimation) {
      const duration = Math.max(0.15, Number(image.exitDuration || 0.45));
      imageFilters.push(
        `fade=t=out:st=${Math.max(Number(image.start || 0), Number(image.end || 0) - duration).toFixed(4)}:d=${duration.toFixed(4)}:alpha=1`,
      );
    }
    if (config.captionRastersViaMovie && image._clipAssistantCaptionRaster) {
      graph.push(
        `movie='${escapeFilterPath(image.path)}':loop=1,${imageFilters.join(",")}[img${index}]`,
      );
      return { image, label: `[img${index}]` };
    }
    graph.push(
      `[${inputIndex}:v]${imageFilters.join(",")}[img${index}]`,
    );
    inputIndex += 1;
    return { image, label: `[img${index}]` };
  });
  graph.push("[base]null[layer0]");
  const addTextItems = (items, inputLabel = null, namespace = "layer") => {
    let currentLabel = inputLabel || `[layer${layer}]`;
    let itemIndex = 0;
    for (const text of items || []) {
      if (!inputLabel) layer += 1;
      const style = text.style || {};
      const resolvedFont = resolveFontFile(style);
      if (!resolvedFont)
        throw new Error("找不到可用于导出的字体文件，请先在字体面板载入字体。");
      const fontFile = `:fontfile='${escapeDrawtext(resolvedFont)}'`;
      const textScale = Math.max(0.05, Math.min(8, Number(text.scale || 1)));
      const backgroundPadding = Math.max(
        Number(style.backgroundWidth ?? style.padding ?? 14),
        Number(style.backgroundHeight ?? style.padding ?? 14),
      );
      const background = style.backgroundEnabled
        ? `:box=1:boxcolor=${style.background || "black"}@${Math.max(0, Math.min(1, Number(style.backgroundOpacity ?? 0.7))).toFixed(2)}:boxborderw=${Math.round(backgroundPadding * textScale)}`
        : "";
      const shadowDistance = Number(style.shadowDistance ?? style.shadow ?? 0),
        shadowAngle = (Number(style.shadowAngle ?? 45) * Math.PI) / 180,
        shadowX = Math.round(Math.cos(shadowAngle) * shadowDistance * textScale),
        shadowY = Math.round(Math.sin(shadowAngle) * shadowDistance * textScale);
      const shadow =
        Number(style.shadowOpacity ?? 0.8) > 0 &&
        Number(style.shadowBlur ?? style.shadow ?? 0) > 0
          ? `:shadowx=${shadowX}:shadowy=${shadowY}:shadowcolor=${style.shadowColor || "black"}@${Math.max(0, Math.min(1, Number(style.shadowOpacity ?? 0.8))).toFixed(2)}`
          : "";
      const border =
        Number(style.stroke || 0) > 0
          ? `:borderw=${Math.round(Number(style.stroke || 2) * textScale)}:bordercolor=${style.strokeColor || "black"}`
          : "";
      const lineSpacing = Math.round(
        (Number(style.lineHeight || 1.15) - 1) *
          Number(style.fontSize || 54) *
          textScale,
      );
      const baseX = `(w-text_w)/2+${Math.round(Number(text.x || 0))}`,
        baseY = `(h-text_h)/2+${Math.round(Number(text.y || 0))}`,
        animatedX = animatedPosition(text, "x", baseX, 130),
        animatedY = animatedPosition(text, "y", baseY, 130),
        alpha = animatedAlpha(text, 1),
        content = spacedText(casedText(text.text, style.textCase), style.wordSpacing);
      const enable = `between(t,${Number(text.start || 0).toFixed(3)},${Number(text.end || info.duration).toFixed(3)})`,
        backgroundX = animatedPosition(
          text,
          "x",
          `(w-text_w)/2+${Math.round(Number(text.x || 0) + Number(style.backgroundX || 0))}`,
          130,
        ),
        backgroundY = animatedPosition(
          text,
          "y",
          `(h-text_h)/2+${Math.round(Number(text.y || 0) + Number(style.backgroundY || 0))}`,
          130,
        ),
        backgroundDraw = style.backgroundEnabled
          ? `drawtext=text='${escapeDrawtext(content)}'${fontFile}:fontsize=${Math.round(Number(style.fontSize || 54) * textScale)}:line_spacing=${lineSpacing}:fontcolor=white@0:x='${backgroundX}':y='${backgroundY}'${background}:enable='${enable}',`
          : "";
      const draw = `${backgroundDraw}drawtext=text='${escapeDrawtext(content)}'${fontFile}:fontsize=${Math.round(Number(style.fontSize || 54) * textScale)}:line_spacing=${lineSpacing}:fontcolor=${style.color || "white"}:alpha='${alpha}':x='${animatedX}':y='${animatedY}'${shadow}${border}:enable='${enable}'`;
      const outputLabel = inputLabel ? `[compoundtext${namespace}_${itemIndex++}]` : `[layer${layer}]`;
      graph.push(`${currentLabel}${draw}${outputLabel}`);
      currentLabel = outputLabel;
    }
    return currentLabel;
  };
  const overlayImagesOnTrack = (trackId) => {
    for (const { image, label } of preparedImages.filter(
      (item) =>
        !item.image?._clipAssistantCaptionRaster &&
        !item.image?.compoundId &&
        (item.image.trackId === trackId || (!item.image.trackId && trackId === "image")),
    )) {
      layer += 1;
      const iCropTop = Math.max(0, Math.min(95, Number(image.cropTop || 0)));
      const iCropBottom = Math.max(0, Math.min(95, Number(image.cropBottom || 0)));
      const iCropLeft = Math.max(0, Math.min(95, Number(image.cropLeft || 0)));
      const iCropRight = Math.max(0, Math.min(95, Number(image.cropRight || 0)));
      const iCropW = Math.max(0.01, 1 - (iCropLeft + iCropRight) / 100);
      const iCropH = Math.max(0.01, 1 - (iCropTop + iCropBottom) / 100);
      const iBaseX = image.spliceRegion
        ? `${Math.round(Number(image.spliceRegion.x || 0) * width)}`
        : (iCropLeft > 0 || iCropRight > 0)
        ? `(W-w/${iCropW.toFixed(5)})/2+${Math.round(Number(image.x || 0))}+${(iCropLeft / 100).toFixed(5)}*w/${iCropW.toFixed(5)}`
        : `(W-w)/2+${Math.round(Number(image.x || 0))}`;
      const iBaseY = image.spliceRegion
        ? `${Math.round(Number(image.spliceRegion.y || 0) * height)}`
        : (iCropTop > 0 || iCropBottom > 0)
        ? `(H-h/${iCropH.toFixed(5)})/2+${Math.round(Number(image.y || 0))}+${(iCropTop / 100).toFixed(5)}*h/${iCropH.toFixed(5)}`
        : `(H-h)/2+${Math.round(Number(image.y || 0))}`;
      const imageX = animatedPosition(image, "x", iBaseX, 220);
      const imageY = animatedPosition(image, "y", iBaseY, 220);
      graph.push(
        `[layer${layer - 1}]${label}overlay=x='${imageX}':y='${imageY}':enable='gte(t,${Number(image.start || 0).toFixed(6)})*lt(t,${Number(image.end ?? info.duration).toFixed(6)})':eof_action=pass:shortest=0[layer${layer}]`,
      );
    }
  };
  let compoundRenderIndex = 0;
  const overlayCompoundGroupsOnTrack = (trackId) => {
    for (const group of config.compoundClips || []) {
      if ((group.videoTrackId || "video") !== trackId) continue;
      const videos = preparedVideos.filter((item) => item.video.compoundId === group.id);
      const images = preparedImages.filter((item) => item.image.compoundId === group.id);
      const titles = (config.titles || []).filter((item) => item.compoundId === group.id);
      const children = [
        ...videos.map((item) => ({ kind: "video", value: item.video, label: item.label })),
        ...images.map((item) => ({ kind: "image", value: item.image, label: item.label })),
        ...titles.map((item) => ({ kind: "text", value: item, label: "" })),
      ].sort((a, b) => Number(a.value.compoundStackOrder || 0) - Number(b.value.compoundStackOrder || 0));
      if (!children.length) continue;
      const index = compoundRenderIndex++;
      let currentLabel = `[compoundbase${index}]`;
      graph.push(`color=c=black@0.0:s=${width}x${height}:r=${fps}:d=${outputDuration.toFixed(5)},format=rgba${currentLabel}`);
      let textIndex = 0;
      for (const child of children) {
        if (child.kind === "text") {
          currentLabel = addTextItems([child.value], currentLabel, `${index}_${textIndex++}`);
          continue;
        }
        const item = child.value;
        const cropTop = Math.max(0, Math.min(95, Number(item.cropTop || 0)));
        const cropBottom = Math.max(0, Math.min(95, Number(item.cropBottom || 0)));
        const cropLeft = Math.max(0, Math.min(95, Number(item.cropLeft || 0)));
        const cropRight = Math.max(0, Math.min(95, Number(item.cropRight || 0)));
        const cropW = Math.max(0.01, 1 - (cropLeft + cropRight) / 100);
        const cropH = Math.max(0.01, 1 - (cropTop + cropBottom) / 100);
        const baseX = item.spliceRegion
          ? `${Math.round(Number(item.spliceRegion.x || 0) * width)}`
          : (cropLeft > 0 || cropRight > 0)
            ? `(W-w/${cropW.toFixed(5)})/2+${Math.round(Number(item.x || 0))}+${(cropLeft / 100).toFixed(5)}*w/${cropW.toFixed(5)}`
            : `(W-w)/2+${Math.round(Number(item.x || 0))}`;
        const baseY = item.spliceRegion
          ? `${Math.round(Number(item.spliceRegion.y || 0) * height)}`
          : (cropTop > 0 || cropBottom > 0)
            ? `(H-h/${cropH.toFixed(5)})/2+${Math.round(Number(item.y || 0))}+${(cropTop / 100).toFixed(5)}*h/${cropH.toFixed(5)}`
            : `(H-h)/2+${Math.round(Number(item.y || 0))}`;
        const outputLabel = `[compoundchild${index}_${children.indexOf(child)}]`;
        graph.push(`${currentLabel}${child.label}overlay=x='${baseX}':y='${baseY}':enable='gte(t,${(Number(item.start || 0) - 1e-7).toFixed(7)})*lt(t,${(Number(item.end || info.duration) - 1e-7).toFixed(7)})':eof_action=pass:shortest=0${outputLabel}`);
        currentLabel = outputLabel;
      }
      const transform = group.transform || {};
      const scale = Math.max(0.03, Math.min(8, Number(transform.scale || 1)));
      const rotation = Math.max(-360, Math.min(360, Number(transform.rotation || 0)));
      const opacity = Math.max(0, Math.min(1, Number(transform.opacity ?? 1)));
      const left = Math.max(0, Math.min(95, Number(transform.cropLeft || 0)));
      const right = Math.max(0, Math.min(95 - left, Number(transform.cropRight || 0)));
      const top = Math.max(0, Math.min(95, Number(transform.cropTop || 0)));
      const bottom = Math.max(0, Math.min(95 - top, Number(transform.cropBottom || 0)));
      const cropWidth = Math.max(2, Math.floor(width * (1 - (left + right) / 100) / 2) * 2);
      const cropHeight = Math.max(2, Math.floor(height * (1 - (top + bottom) / 100) / 2) * 2);
      const cropX = Math.min(width - cropWidth, Math.round(width * left / 100));
      const cropY = Math.min(height - cropHeight, Math.round(height * top / 100));
      const groupFilters = [];
      // Match the preview wrapper: crop the compound in its local canvas,
      // preserve the canvas dimensions with transparent padding, then apply
      // the outer scale/rotation around the group anchor.
      if (left || right || top || bottom) {
        groupFilters.push(`crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`);
        groupFilters.push(`pad=${width}:${height}:${cropX}:${cropY}:color=black@0`);
      }
      groupFilters.push(`scale=w=${Math.max(2, Math.floor(width * scale / 2) * 2)}:h=${Math.max(2, Math.floor(height * scale / 2) * 2)}:flags=lanczos+accurate_rnd`);
      if (Math.abs(rotation) > 0.001)
        groupFilters.push(`rotate=${rotation.toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0`);
      groupFilters.push(`crop=w='min(iw,${width})':h='min(ih,${height})':x='(iw-ow)/2':y='(ih-oh)/2'`);
      groupFilters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
      if (opacity < 0.999) groupFilters.push(`colorchannelmixer=aa=${opacity.toFixed(4)}`);
      const finalGroupLabel = `[compoundout${index}]`;
      graph.push(`${currentLabel}${groupFilters.join(",")}${finalGroupLabel}`);
      layer += 1;
      graph.push(`[layer${layer - 1}]${finalGroupLabel}overlay=x='(W-w)/2+${Math.round(Number(transform.x || 0))}':y='(H-h)/2+${Math.round(Number(transform.y || 0))}':eof_action=pass:shortest=0[layer${layer}]`);
    }
  };
  const order =
    Array.isArray(config.trackOrder) && config.trackOrder.length
      ? [...config.trackOrder].reverse()
      : ["video", "image", "text", "caption"];
  let captionRendered = false;
  for (const key of order) {
    const kind = config.trackDefinitions?.[key]?.kind || key;
    if (config.trackVisibility?.[key] === false) continue;
    if (kind === "video") {
      const mainLabel = mainTrackLabels.get(key);
      if (mainLabel && config.includeVideo !== false) {
        const ranges = mainVideoClips.filter(
          (clip) => (clip.trackId || "video") === key,
        );
        const enable = ranges
          .map(
            (clip) => {
              const clipEnd = repairGeneratedTail && clip === mainVideoClips[mainVideoClips.length - 1]
                ? outputDuration
                : Math.max(Number(clip.start || 0), Number(clip.end || 0));
              return `between(t,${Math.max(0, Number(clip.start || 0)).toFixed(3)},${clipEnd.toFixed(3)})`;
            },
          )
          .join("+");
        layer += 1;
        graph.push(
          // The joined main stream already has a bounded, frame-sized tail
          // guard. Never repeat it indefinitely here: a seconds-long upstream
          // duration mismatch would otherwise become a frozen final picture.
          `[layer${layer - 1}]${mainLabel}overlay=x='${x}':y='${y}':enable='${enable || "1"}':eof_action=pass:repeatlast=0:shortest=0[layer${layer}]`,
        );
        consumedMainTracks.add(key);
      }
      for (const { video, label } of preparedVideos.filter(
        (item) =>
          !item.video.compoundId &&
          (item.video.trackId === key || (!item.video.trackId && key === "video-overlay")),
      )) {
        layer += 1;
        const vCropTop = Math.max(0, Math.min(95, Number(video.cropTop || 0)));
        const vCropBottom = Math.max(0, Math.min(95, Number(video.cropBottom || 0)));
        const vCropLeft = Math.max(0, Math.min(95, Number(video.cropLeft || 0)));
        const vCropRight = Math.max(0, Math.min(95, Number(video.cropRight || 0)));
        const vCropW = Math.max(0.01, 1 - (vCropLeft + vCropRight) / 100);
        const vCropH = Math.max(0.01, 1 - (vCropTop + vCropBottom) / 100);
        const vBaseX = video.spliceRegion
          ? `${Math.round(Number(video.spliceRegion.x || 0) * width)}`
          : (vCropLeft > 0 || vCropRight > 0)
          ? `(W-w/${vCropW.toFixed(5)})/2+${Math.round(Number(video.x || 0))}+${(vCropLeft / 100).toFixed(5)}*w/${vCropW.toFixed(5)}`
          : `(W-w)/2+${Math.round(Number(video.x || 0))}`;
        const vBaseY = video.spliceRegion
          ? `${Math.round(Number(video.spliceRegion.y || 0) * height)}`
          : (vCropTop > 0 || vCropBottom > 0)
          ? `(H-h/${vCropH.toFixed(5)})/2+${Math.round(Number(video.y || 0))}+${(vCropTop / 100).toFixed(5)}*h/${vCropH.toFixed(5)}`
          : `(H-h)/2+${Math.round(Number(video.y || 0))}`;
        graph.push(
          `[layer${layer - 1}]${label}overlay=x='${vBaseX}':y='${vBaseY}':enable='gte(t,${(Number(video.start||0)-1e-7).toFixed(7)})*lt(t,${(Number(video.end||info.duration)-1e-7).toFixed(7)})':eof_action=pass:shortest=0[layer${layer}]`,
        );
      }
      // Images share DaVinci-style video tracks. Composite them at that
      // track's place in the stack so a dedicated top track stays on top of
      // every splice pane during export as well as in the preview.
      overlayImagesOnTrack(key);
    } else if (kind === "image") {
      overlayImagesOnTrack(key);
    } else if (kind === "text")
      addTextItems(
        (config.titles || []).filter(
          (item) => !item.compoundId && (item.trackId === key || (!item.trackId && key === "text")),
        ),
      );
    else if (kind === "caption" && !captionRendered) {
      const rasters = preparedImages.filter((item) => item.image?._clipAssistantCaptionRaster && !item.image?.compoundId);
      for (const { image, label } of rasters) {
        layer += 1;
        graph.push(
          `[layer${layer - 1}]${label}overlay=x='(W-w)/2+${Number(image.x || 0)}':y='(H-h)/2+${Number(image.y || 0)}':enable='between(t,${Number(image.start || 0).toFixed(3)},${Number(image.end || info.duration).toFixed(3)})':eof_action=pass:shortest=0[layer${layer}]`,
        );
      }
      if (rasters.length || config.captionRasterized) {
        captionRendered = true;
      } else if (config.captionAssPath) {
        layer += 1;
        const fontFile = resolveFontFile(config.captions?.[0]?.style || {});
        const fontsDir = fontFile
          ? path.dirname(fontFile)
          : path.join(supportRoot(), "fonts");
        graph.push(
          `[layer${layer - 1}]ass=filename='${escapeFilterPath(config.captionAssPath)}':original_size=${Math.round(width)}x${Math.round(height)}:fontsdir='${escapeFilterPath(fontsDir)}'[layer${layer}]`,
        );
        captionRendered = true;
      } else {
        addTextItems(config.captions || []);
        captionRendered = true;
      }
    }
    overlayCompoundGroupsOnTrack(key);
  }
  for (const [trackId, label] of mainTrackLabels)
    if (!consumedMainTracks.has(trackId)) graph.push(`${label}nullsink`);
  let audioLabel =
    hasMainAudio && config.includeAudio !== false ? "[joineda]" : null;
  if (hasMainAudio && config.includeAudio === false)
    graph.push("[joineda]anullsink");
  if (audioLabel && mainOffset > 0.001) {
    graph.push(
      `${audioLabel}adelay=${Math.round(mainOffset * 1000)}:all=1[mainoffseta]`,
    );
    audioLabel = "[mainoffseta]";
  }
  const effectiveAudioConfig = hasDenoisedMainAudio
    ? { ...config, denoise: { ...(config.denoise || {}), strength: 0 } }
    : config;
  const master = audioLabel
    ? audioMasterFilter(
        { ...effectiveAudioConfig, audio: { ...(config.audio || {}), speed: 1, offset: 0 } },
        info,
      )
    : "";
  if (audioLabel && master) {
    graph.push(`${audioLabel}${master}[denoiseda]`);
    audioLabel = "[denoiseda]";
  }
  audioLabel = appendMainClipAudioFilters(graph, config, audioLabel);
  if (audioLabel && (config.audioMutes || []).length) {
    const muteFilters = config.audioMutes.map(
      (range) =>
        `volume=enable='between(t,${Number(range.start).toFixed(3)},${Number(range.end).toFixed(3)})':volume=0`,
    );
    graph.push(`${audioLabel}${muteFilters.join(",")}[outa]`);
    audioLabel = "[outa]";
  }
  audioLabel =
    config.includeAudio === false
      ? null
      : appendExternalAudio(graph, config, inputIndex, audioLabel);
  const borderRegions = (config.spliceRegions || []).filter((region) => Number(region.borderWidth || 0) > 0 && Number(region.w) > 0 && Number(region.h) > 0);
  borderRegions.forEach((region, index) => {
    const regionWidth = Math.max(8, Math.round(width * Number(region.w)));
    const regionHeight = Math.max(8, Math.round(height * Number(region.h)));
    const borderWidth = Math.max(1, Math.round(Number(region.borderWidth || 1) * width / 1080));
    const color = /^#[0-9a-f]{6}$/i.test(String(region.borderColor || "")) ? String(region.borderColor) : "#68A9A2";
    const label = `[spliceBorder${index}]`;
    appendLoopedSpliceBorder(
      graph,
      { ...region, borderWidth, borderColor: color },
      regionWidth,
      regionHeight,
      fps,
      outputDuration,
      label,
    );
    layer += 1;
    graph.push(`[layer${layer - 1}]${label}overlay=x=${Math.round(Number(region.x || 0) * width)}:y=${Math.round(Number(region.y || 0) * height)}:shortest=0[layer${layer}]`);
  });
  // End by frame count, not a floating-point timestamp. The upstream main
  // stream may hold only its bounded few-frame rounding guard; this final trim
  // must not manufacture seconds of duplicate tail frames.
  graph.push(`[layer${layer}]trim=end_frame=${targetFrameCount},setpts=PTS-STARTPTS[finalv]`);
  const videoLabel = "[finalv]";
  return applyExportSpeed({ graph: graph.join(";"), videoLabel, audioLabel, width, height, fps, duration: outputDuration, frameCount: targetFrameCount }, config);
}

function visualTransformIsDefault(value = {}) {
  return Math.abs(Number(value.x || 0)) < 0.001 &&
    Math.abs(Number(value.y || 0)) < 0.001 &&
    Math.abs(Number(value.scale || 1) - 1) < 0.001 &&
    Math.abs(Number(value.rotation || 0)) < 0.001 &&
    Math.abs(Number(value.opacity ?? 1) - 1) < 0.001 &&
    (value.blendMode || "normal") === "normal";
}

export function clipHasCustomVisual(settings = {}) {
  if (settings.spliceRegion) return true;
  if (["freeze-resume", "freeze-hold"].includes(settings.splicePlaybackMode)) return true;
  if (!visualTransformIsDefault(settings)) return true;
  return ["cropTop", "cropBottom", "cropLeft", "cropRight"].some(
    (key) => Math.abs(Number(settings[key] || 0)) > 0.01,
  );
}

export function mainClipsUseConcat(clips = []) {
  const list = [...(clips || [])].sort(
    (left, right) => Number(left.start || 0) - Number(right.start || 0),
  );
  if (!list.length) return false;
  const track = list[0].trackId || "video";
  for (let index = 0; index < list.length; index += 1) {
    const clip = list[index];
    if ((clip.trackId || "video") !== track) return false;
    if (clipHasCustomVisual(clip.settings || {})) return false;
    if (index > 0 && Number(clip.start || 0) < Number(list[index - 1].end || 0) - 0.02)
      return false;
  }
  return true;
}

function comparableVisualSettings(settings = {}) {
  const value = settings || {};
  return {
    x: Number(value.x || 0), y: Number(value.y || 0), scale: Number(value.scale || 1),
    rotation: Number(value.rotation || 0), opacity: Number(value.opacity ?? 1),
    blendMode: value.blendMode || "normal", cropTop: Number(value.cropTop || 0),
    cropBottom: Number(value.cropBottom || 0), cropLeft: Number(value.cropLeft || 0),
    cropRight: Number(value.cropRight || 0),
  };
}

export function mainClipsUseSharedVisualConcat(clips = [], outputDuration = 0) {
  const list = [...(clips || [])].sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
  if (list.length < 2 || !clipHasCustomVisual(list[0]?.settings || {})) return false;
  const track = list[0].trackId || "video";
  const signature = JSON.stringify(comparableVisualSettings(list[0].settings));
  if (Number(list[0].start || 0) > 0.01) return false;
  for (let index = 0; index < list.length; index += 1) {
    const clip = list[index];
    if ((clip.trackId || "video") !== track) return false;
    if (JSON.stringify(comparableVisualSettings(clip.settings)) !== signature) return false;
    if ((clip.settings?.blendMode || "normal") !== "normal") return false;
    if (index > 0 && Math.abs(Number(clip.start || 0) - Number(list[index - 1].end || 0)) > 0.04) return false;
  }
  const end = Number(list[list.length - 1].end || 0);
  return !outputDuration || Math.abs(end - Number(outputDuration || end)) <= 0.05;
}

export function mainClipsUseSharedSpliceConcat(clips = [], outputDuration = 0, speed = 1) {
  const list = [...(clips || [])].sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
  if (list.length < 2) return false;
  const first = list[0];
  const settings = first.settings || {};
  const region = settings.spliceRegion;
  if (!region || !(Number(region.w) > 0) || !(Number(region.h) > 0)) return false;
  const track = first.trackId || "video";
  const signature = JSON.stringify({
    visual: comparableVisualSettings(settings),
    color: settings.color || {},
    spliceRegion: region,
    playbackMode: settings.splicePlaybackMode || "normal-audio",
  });
  if (Number(first.start || 0) > 0.01) return false;
  for (let index = 0; index < list.length; index += 1) {
    const clip = list[index];
    const clipSettings = clip.settings || {};
    if ((clip.trackId || "video") !== track) return false;
    if (JSON.stringify({
      visual: comparableVisualSettings(clipSettings),
      color: clipSettings.color || {},
      spliceRegion: clipSettings.spliceRegion || null,
      playbackMode: clipSettings.splicePlaybackMode || "normal-audio",
    }) !== signature) return false;
    if ((clipSettings.blendMode || "normal") !== "normal") return false;
    if (["freeze-resume", "freeze-hold"].includes(clipSettings.splicePlaybackMode)) return false;
    if (Math.abs(Number(clip.playbackRate || speed) - Number(speed || 1)) > 1e-7) return false;
    if (index > 0 && Math.abs(Number(clip.start || 0) - Number(list[index - 1].end || 0)) > 0.04) return false;
  }
  const end = Number(list[list.length - 1].end || 0);
  return !outputDuration || Math.abs(end - Number(outputDuration || end)) <= 0.05;
}

function canSmartCopy(config, info, format) {
  // The export dialog exposes bitrate and quality controls. A stream copy
  // bypasses those settings entirely, so user initiated exports must encode.
  if (config.forceReencode) return false;
  const clips = config.mainVideoClips || [],
    clip = clips[0],
    sourceCodec = String(info.videoCodec || "").toLowerCase(),
    sourceIsWebSafe = /h264|avc|hevc|h265/.test(sourceCodec),
    codecMatches = (config.codec === "source" && (format === "mov" || sourceIsWebSafe)) || (config.codec === "hevc"
      ? /hevc|h265/.test(sourceCodec)
      : /h264|avc/.test(sourceCodec)),
    noColor = colorAdjustmentsAreDefault(config.color || {}),
    noBeauty = Object.values(config.beauty || {}).every(
      (value) => Math.abs(Number(value || 0)) < 0.001,
    );
  return exportSpeed(config) === 1 && ["mp4", "mov"].includes(format) && codecMatches &&
    Number(config.width) === Number(info.displayWidth || info.width) &&
    Number(config.height) === Number(info.displayHeight || info.height) &&
    Math.abs(Number(config.fps || info.frameRate) - Number(info.frameRate || config.fps)) < 0.1 &&
    clips.length === 1 && Number(clip.start || 0) < 0.002 &&
    Math.abs(Number(clip.sourceStart || 0)) < 0.002 &&
    Math.abs(Number(clip.sourceEnd || info.duration) - Number(info.duration)) < 0.04 &&
    Math.abs(Number(config.outputDuration || info.duration) - Number(info.duration)) < 0.04 &&
    visualTransformIsDefault(config.videoTransform) &&
    visualTransformIsDefault(clip.settings) && noColor && noBeauty &&
    !(config.removals || []).length && !(config.audioMutes || []).length &&
    !(config.videoLayers || []).length && !(config.images || []).length &&
    !(config.titles || []).length && !(config.captions || []).length &&
    !(config.audioAssets || []).length && config.includeVideo !== false &&
    config.includeAudio !== false && !config.audioProcessingEnabled &&
    Number(config.denoise?.strength || 0) <= 0.01 &&
    !normalizeAudioFxRack(config.audioFxRack || []).some((effect) => effect.enabled) &&
    !(config.mainAudioClips || []).some((item) =>
      normalizeAudioFxRack(item.fxRack || []).some((effect) => effect.enabled),
    );
}

export function startExport(config) {
  exportSpeed(config);
  let inputPath = String(config?.inputPath || "");
  if (config?.noMainVideoSource && (!inputPath || !fs.existsSync(inputPath)))
    inputPath = (config.videoLayers || []).find((item) => item?.path && fs.existsSync(item.path))?.path || "";
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error(inputPath
      ? `视频源文件不存在或已移动：${inputPath}。请重新关联素材后再导出。`
      : "没有可读取的视频源。请先导入主视频，或把视频素材放到视频轨道后再导出。");
  }
  config = { ...config, inputPath };
  if (!config?.outputPath) throw new Error("请选择导出保存位置。");
  const info = probeMedia(config.inputPath);
  const destination = prepareExportDestination(config.outputPath, config.inputPath);
  config = { ...config, outputPath: destination.temporary, exportDestination: destination };
  const id = crypto.randomUUID();
  const job = {
    id,
    state: "preparing",
    progress: 0.02,
    error: "",
    outputPath: destination.output,
    child: null,
    startedAt: Date.now(),
    stage: "prepare",
    frameProgress: false,
    message: "正在准备导出… · 已用 0:00",
  };
  jobs.set(id, job);
  const format = String(
    config.format || path.extname(config.outputPath).slice(1) || "mp4",
  ).toLowerCase();
  if (format === "mp3" && config.qualityMode === "lossless") throw Error("MP3 不支持无损压缩，请选择 MP4 或 MOV 视频格式。");
  if (canSmartCopy(config, info, format)) job.mode = "smart-copy";
  job.state = 'queued'; job.message = '等待可用渲染资源…';
  const launchWhenReady = () => {
    if(job.state === 'cancelled') return;
    const active=[...jobs.values()].filter(item=>['preparing','exporting'].includes(item.state));
    const queued=[...jobs.values()].filter(item=>item.state==='queued');
    const hardware=normalizeExportDevice(config.encoderDevice || config.device)!=='cpu';
    const limit=renderSlotLimit({hardware,gpuMemoryMiB:hardware ? freeGpuMemoryMiB() : null,pixels:Math.max(Number(config.width || 1920)*Number(config.height || 1080),...active.map(item=>item.pixels || 0))});
    if(queued[0]!==job || active.length>=limit) {setTimeout(launchWhenReady,250);return;}
    job.state='preparing';job.startedAt=Date.now();job.pixels=Number(config.width || 1920)*Number(config.height || 1080);
    try {beginExportJob(config,info,job);}
    catch(error){job.state='failed';job.error=error?.message || String(error);job.message=job.error;}
  };
  setImmediate(launchWhenReady);
  return { jobId: id, mode: job.mode || "preparing" };
}

function beginExportJob(config, info, job) {
  job.stage = "prepare";
  job.message = exportStageMessage(job);
  const format = String(
    config.format || path.extname(config.outputPath).slice(1) || "mp4",
  ).toLowerCase();
  if (canSmartCopy(config, info, format)) {
    const args = [
      "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", config.inputPath,
      "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
      "-map_metadata", "0", "-movflags", "+faststart",
      "-t", String(Math.max(0.04, Number(config.outputDuration || info.duration))),
      "-stats_period", "0.2", "-progress", "pipe:1", "-nostats", config.outputPath,
    ];
    const child = spawn(mediaBinary("ffmpeg"), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) {
      try { os.setPriority(child.pid, 5); } catch {}
    }
    job.child = child;
    job.state = "exporting";
    job.progress = Math.max(job.progress, 0.02);
    job.encoder = "copy";
    job.mode = "smart-copy";
    monitorExport(child, job, config, info);
    return;
  }
  job.stage = "captions";
  job.message = exportStageMessage(job);
  if (format !== "mp3" && (config.captions || []).length) {
    const alreadyRastered = !!(config.captionRasterized ||
      (config.images || []).some((image) => image?._clipAssistantCaptionRaster));
    if (alreadyRastered) config.captionRasterized = true;
    else {
      const rasterized = process.platform === "darwin" && prepareSharedCaptionRaster(config);
      if (!rasterized) config.captionAssPath = createAssSubtitleFile(config);
    }
    if (captionRasterItems(config).length >= 2) {
      job.message = "正在合并字幕叠层…";
      try {
        composeCaptionRasterConcat(config, info);
      } catch {
        /* keep individual rasters; movie/script path still works */
      }
    }
  }
  // Reuse the verified device across batch jobs; explicit device refresh resets the probe.
  const hardware = detectExportHardware();
  const busyGpuApps = listBusyGpuApps();
  job.gpuBusy = busyGpuApps.length > 0;
  job.busyGpuApps = busyGpuApps;
  const hasDenoisedMainAudio = !!(config.mainAudioPath && fs.existsSync(config.mainAudioPath));
  const extraInputs = [];
  if (format === "mp3") {
    for (const audio of config.audioAssets || []) extraInputs.push("-i", audio.path);
    const mainSource = hasDenoisedMainAudio ? config.mainAudioPath : config.inputPath;
    const inputs = ["-i", mainSource, ...extraInputs];
    const built = buildAudioExportGraph(config, info, 1, 0);
    const args = [
      "-y",
      "-hide_banner",
      ...inputs,
      "-filter_complex",
      built.graph,
      "-map",
      built.audioLabel,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      "-t",
      String(Math.max(0.04, Number(built.duration || config.outputDuration || info.duration))),
      "-stats_period",
      "0.2",
      "-progress",
      "pipe:1",
      "-nostats",
      config.outputPath,
    ];
    const child = spawn(mediaBinary("ffmpeg"), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) {
      try { os.setPriority(child.pid, 5); } catch {}
    }
    job.child = child;
    job.state = "exporting";
    job.progress = Math.max(job.progress, 0.02);
    monitorExport(child, job, config, info);
    return;
  }
  const preparedInputs = collectExportExtraInputs(config);
  config.captionRastersViaMovie = preparedInputs.captionRastersViaMovie;
  if (hasDenoisedMainAudio) {
    extraInputs.push("-i", config.mainAudioPath);
  }
  extraInputs.push(...preparedInputs.extraInputs);
  let built = buildExportGraph(config, info);
  const colorProfiles = {
      bt709: { space: "bt709", primaries: "bt709", transfer: "bt709", pixel: "yuv420p" },
      p3: { space: "bt709", primaries: "smpte432", transfer: "iec61966-2-1", pixel: "yuv420p" },
      bt2020: { space: "bt2020nc", primaries: "bt2020", transfer: "bt709", pixel: "yuv420p" },
      hlg: { space: "bt2020nc", primaries: "bt2020", transfer: "arib-std-b67", pixel: "p010le", hdr: true },
      pq: { space: "bt2020nc", primaries: "bt2020", transfer: "smpte2084", pixel: "p010le", hdr: true },
    },
    colorProfile = colorProfiles[config.colorSpace] || colorProfiles.bt709,
    useHevc = config.codec === "hevc" ||
      (config.codec === "source" && /hevc|h265/.test(String(info.videoCodec || "").toLowerCase())) ||
      colorProfile.hdr;
  const encoderDevice = normalizeExportDevice(config.encoderDevice || config.device);
  const fallbackEncoder = useHevc ? "libx265" : "libx264";
  let preferredEncoder = preferredVideoEncoder(useHevc, { device: encoderDevice, qualityMode: config.qualityMode });
  if (encoderDevice !== "cpu" && shouldSkipHardwareForBusyGpu(preferredEncoder, busyGpuApps)) {
    preferredEncoder = fallbackEncoder;
    job.stage = "retry";
    job.message = `检测到${busyGpuApps.join("、")}占用核显，改用 CPU 编码…`;
  }
  if (config.qualityMode === "lossless" && !/nvenc$/.test(preferredEncoder)) preferredEncoder = fallbackEncoder;
  const encodeQueue = [preferredEncoder];
  if (encoderDevice !== "cpu" && preferredEncoder !== fallbackEncoder) encodeQueue.push(fallbackEncoder);
  const launch = (encoder, rest, decodeKind) => {
    const logical = Math.max(2, Number(os.cpus?.().length || 4));
    const budget = config.resourceBudget && typeof config.resourceBudget === "object" ? config.resourceBudget : {};
    const hardwareEncode = isHardwareEncoder(encoder);
    const workerThreads = Math.max(2, Math.min(6, Number(budget.workerThreads || Math.ceil(logical / 2))));
    const filterThreads = Math.max(
      1,
      Math.min(
        6,
        Number(
          budget.filterThreads ||
            (hardwareEncode ? Math.ceil(logical / 2) : isDarwin ? 4 : 2),
        ),
      ),
    );
    const decodeKindNow =
      decodeKind === undefined
        ? preferredExportDecodeKind(encoder, hardware.decode)
        : decodeKind === "none"
          ? ""
          : decodeKind;
    const inputs = [...(decodeKindNow==='cuda-batch'?['-hwaccel','cuda','-hwaccel_output_format','cuda']:decodeAccelArgs(decodeKindNow)), "-i", config.inputPath, ...extraInputs];
    const args = [
      "-y",
      "-hide_banner",
      "-threads", String(workerThreads),
      "-filter_threads", String(filterThreads),
      "-filter_complex_threads", String(filterThreads),
      ...inputs,
      "-filter_complex",
      built.graph,
      "-map",
      built.videoLabel,
    ];
    if (built.audioLabel) args.push("-map", built.audioLabel);
    args.push("-r", String(built.fps));
    args.push("-frames:v", String(built.frameCount));
    args.push(
      ...videoEncodeArgs(encoder, {
        bitrate: config.bitrate || (config.quality === "high" ? "20M" : "12M"),
        fps: built.fps,
        qualityMode: config.qualityMode,
        rf: config.rf,
        quality: config.quality,
        hdr: colorProfile.hdr,
        gpuBusy: !!job.gpuBusy,
      }),
    );
    args.push(
      "-pix_fmt",
      decodeKindNow==='cuda-batch'?'cuda':colorProfile.pixel,
      "-colorspace",
      colorProfile.space,
      "-color_primaries",
      colorProfile.primaries,
      "-color_trc",
      colorProfile.transfer,
    );
    if (built.audioLabel) args.push(...(config.qualityMode === "lossless" ? ["-c:a", "alac"] : ["-c:a", "aac", "-b:a", "192k"]));
    args.push(
      "-t",
      String(Math.max(0.04, Number(built.duration))),
      "-movflags",
      "+faststart",
      "-loglevel",
      "error",
      "-stats_period",
      "0.2",
      "-progress",
      "pipe:1",
      "-nostats",
      config.outputPath,
    );
    if (decodeKindNow === "cuda-batch") { for (const flag of ["-colorspace", "-color_primaries", "-color_trc"]) { const index=args.indexOf(flag); if(index>=0)args.splice(index,2); } }
    const packed = compactFfmpegFilterArgs(args, {
      binary: mediaBinary("ffmpeg"),
      directory: config.captionRasterDirectory || path.join(supportRoot(), "temp"),
      rasterCount: captionRasterItems(config).length,
      force: !!config.forceFilterComplexScript,
    });
    if (packed.scriptPath) config.filterComplexScriptPath = packed.scriptPath;
    const child = spawn(mediaBinary("ffmpeg"), packed.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) {
      try { os.setPriority(child.pid, 5); } catch {}
    }
    job.child = child;
    job.state = "exporting";
    job.progress = Math.max(job.progress, 0.02);
    job.encoder = encoder;
    job.vendor = hardware.vendor;
    job.mode = hardwareEncode ? "hardware-quality" : "software-fallback";
    job.stage = "encoding";
    job.encoderLabel = encoderDisplayName(encoder)+(decodeKindNow==='cuda-batch'?' · GPU 解码':'');
    job.decodeKind = decodeKindNow || "none";
    const retry = (reason = "") => {
      job.progress = 0.015;
      job.error = "";
      job.stallRetried = false;
      job.lastProgressAt = Date.now();
      if (String(reason).includes("ENAMETOOLONG") && !config.spawnLengthRetried) {
        config.spawnLengthRetried = true;
        config.captionRastersViaMovie = true;
        config.forceFilterComplexScript = true;
        extraInputs.length = 0;
        extraInputs.push(...collectExportExtraInputs(config).extraInputs);
        built = buildExportGraph(config, info);
        launch(encoder, rest, decodeKind);
        return;
      }
      if (decodeKindNow && decodeKindNow !== "none") {
        launch(encoder, rest, decodeKindNow === "cuda" ? "d3d11va" : "none");
        return;
      }
      if (rest.length) {
        launch(rest[0], rest.slice(1), rest[0] === fallbackEncoder ? "none" : undefined);
      }
    };
    monitorExport(
      child,
      job,
      config,
      info,
      (decodeKindNow && decodeKindNow !== "none") || rest.length ? retry : null,
    );
  };
  launch(encodeQueue[0], encodeQueue.slice(1));
}

function clockToSeconds(match) {
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function parseFfmpegProgress(text, options = {}) {
  const duration = Math.max(0.1, Number(options.duration || 0));
  const fps = Math.max(1, Number(options.fps || 30));
  const source = String(text || "");
  const us = [...source.matchAll(/^out_time_us=(\d+)/gm)].pop();
  const clock = [...source.matchAll(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/gm)].pop();
  const ms = [...source.matchAll(/^out_time_ms=(\d+)/gm)].pop();
  const frame = [...source.matchAll(/^frame=(\d+)/gm)].pop();
  const speed = [...source.matchAll(/^speed=\s*([0-9.]+)x/gm)].pop();
  let seconds = 0;
  if (us) seconds = Number(us[1]) / 1e6;
  else if (clock) seconds = clockToSeconds(clock);
  else if (ms) {
    const value = Number(ms[1]);
    seconds = value > duration * 10_000 ? value / 1e6 : value / 1e3;
  } else if (frame) seconds = Number(frame[1]) / fps;
  return {
    seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
    ended: /^progress=end$/m.test(source),
    speed: speed ? Number(speed[1]) : 0,
  };
}

export function formatExportClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function refreshExportJob(job) {
  if (!job || ["completed", "failed", "cancelled"].includes(job.state)) {
    if (job) job.message = exportStageMessage(job);
    return job;
  }
  if (!job.startedAt) job.startedAt = Date.now();
  const elapsed = (Date.now() - job.startedAt) / 1000;
  if (!job.frameProgress) {
    const soft = Math.min(0.16, 0.02 + elapsed / 36);
    job.progress = Math.max(Number(job.progress || 0.02), soft);
  }
  job.message = exportStageMessage(job);
  return job;
}

function exportStageMessage(job) {
  const elapsed = Math.max(0, (Date.now() - (job.startedAt || Date.now())) / 1000);
  const percent = Math.round((job.progress || 0) * 100);
  const label = job.encoderLabel || encoderDisplayName(job.encoder || "");
  const used = formatExportClock(elapsed);
  if (job.state === "completed") return label ? `✅ 导出完成 · ${label} · 共用时 ${used}` : `✅ 导出完成 · 共用时 ${used}`;
  if (job.state === "queued") return "等待可用渲染资源…";
  if (job.state === "failed") return job.error || "视频导出失败。";
  if (job.state === "cancelled") return "已取消导出";
  if (job.stage === "retry") {
    return `⚠️ 显卡编码无响应，已自动转为 CPU 软件编码… · 已用 ${used}`;
  }
  if (job.stage === "prepare" || job.stage === "captions" || job.state === "preparing")
    return `正在准备导出（字幕/滤镜/硬件加速）… · 已用 ${used}`;
  if (job.stage === "muxing" || (job.progress >= 0.98 && job.state === "exporting"))
    return `正在封装文件… ${percent}% · ${label} · 已用 ${used}`;
  if (!job.frameProgress) {
    const hardware = isHardwareEncoder(job.encoder);
    if (elapsed >= 8) {
      return hardware
        ? `正在启动显卡编码器… ${percent}% · ${label} · 已用 ${used}`
        : `正在启动 CPU 编码器… ${percent}% · ${label} · 已用 ${used}`;
    }
    return `正在启动编码器… ${percent}% · ${label} · 已用 ${used}`;
  }
  if (job.speed > 0)
    return `正在导出 ${percent}% · ${label} · ${job.speed.toFixed(1)}x 实时倍速 · 已用 ${used}`;
  return `正在导出 ${percent}% · ${label} · 已用 ${used}`;
}

export function cleanFfmpegErrorMessage(rawStderr) {
  if (!rawStderr || typeof rawStderr !== "string") return "视频导出失败。";
  const lines = rawStderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !/^(frame|fps|stream_\d+_\d+|bitrate|total_size|out_time(_us|_ms)?|dup_frames|drop_frames|speed|progress)=/i.test(
          l,
        ),
    )
    .filter(
      (l) =>
        !/^ffmpeg version|^built with|^configuration:|^lib(av|sw|postproc)/i.test(
          l,
        ),
    );

  if (!lines.length) return "视频导出失败。";

  const errorLines = lines.filter((l) =>
    /(\[error\]|\[fatal\]|error|failed|invalid|cannot|unable|no such|denied|broken pipe|exceeded|out of memory|encoder.*error|conversion failed)/i.test(
      l,
    ),
  );

  const selected = errorLines.length ? errorLines : lines.slice(-4);
  return selected.slice(-4).join("\n");
}

function monitorExport(child, job, config, info, retry = null) {
  let stderr = "", progressBuffer = "";
  const token = {};
  job.monitorToken = token;
  job.startedAt = job.startedAt || Date.now();
  job.lastProgressAt = Date.now();
  job.speed = 0;
  job.retryLock = false;
  job.encoderLabel = encoderDisplayName(job.encoder || "")+(job.decodeKind==='cuda-batch'?' · GPU 解码':'');
  const duration = Math.max(0.1, Number(config.outputDuration || info.duration || 0) / exportSpeed(config));
  const fps = Math.max(1, Number(config.fps || info.frameRate || 30));
  const abandoned = () => job.monitorToken !== token;
  const requestRetry = (reason = "") => {
    if (abandoned() || job.retryLock || !retry) return false;
    job.retryLock = true;
    job.state = "preparing";
    job.stage = "retry";
    job.frameProgress = false;
    job.message = exportStageMessage(job);
    retry(reason);
    return true;
  };
  refreshExportJob(job);
  const stallWatch = setInterval(() => {
    if (abandoned() || ["completed", "failed", "cancelled"].includes(job.state) || job.frameProgress) {
      clearInterval(stallWatch);
      return;
    }
    if (!exportIsStalled(job) || job.stallRetried) return;
    job.stallRetried = true;
    if (retry) {
      job.stage = "retry";
      job.message = exportStageMessage(job);
      forceKillProcess(child);
      setTimeout(() => requestRetry("stall"), 1200);
    } else {
      job.state = "failed";
      job.error = encoderStallMessage(job);
      job.message = job.error;
      forceKillProcess(child);
    }
    clearInterval(stallWatch);
  }, 500);
  child.stdout?.on("data", (chunk) => {
    if (abandoned()) return;
    const text = chunk.toString();
    progressBuffer = (progressBuffer + text).slice(-8000);
    const parsed = parseFfmpegProgress(progressBuffer, { duration, fps });
    if (parsed.seconds > 0) {
      job.frameProgress = true;
      job.progress = Math.max(
        job.progress || 0,
        Math.min(parsed.ended ? 0.99 : 0.98, parsed.seconds / duration),
      );
      job.lastProgressAt = Date.now();
      job.stage = parsed.ended ? "muxing" : "encoding";
    }
    if (parsed.speed > 0) job.speed = parsed.speed;
    if (parsed.ended) job.stage = "muxing";
    refreshExportJob(job);
    const lastNewline = progressBuffer.lastIndexOf("\n");
    if (lastNewline > 0) progressBuffer = progressBuffer.slice(lastNewline + 1);
  });
  child.stderr?.on("data", (chunk) => {
    if (abandoned()) return;
    const text = chunk.toString();
    stderr = (stderr + text).slice(-16000);
    if (!job.frameProgress || /progress=/i.test(text)) {
      const parsed = parseFfmpegProgress(text, { duration, fps });
      if (parsed.seconds > 0) {
        job.frameProgress = true;
        job.progress = Math.max(
          job.progress || 0,
          Math.min(parsed.ended ? 0.99 : 0.98, parsed.seconds / duration),
        );
        job.lastProgressAt = Date.now();
      }
      if (parsed.speed > 0) job.speed = parsed.speed;
      if (parsed.ended) job.stage = "muxing";
      refreshExportJob(job);
    }
  });
  child.on("error", (error) => {
    if (abandoned()) return;
    if (isSpawnTooLongError(error) && retry && !config.spawnLengthRetried) {
      job.state = "preparing";
      job.stage = "retry";
      job.message = "导出命令太长，正在改用字幕脚本重试…";
      requestRetry("ENAMETOOLONG");
      return;
    }
    job.state = "failed";
    job.error = isSpawnTooLongError(error)
      ? "导出命令太长，显卡通道无法启动。请再导一次，或改勾 CPU。"
      : error.message;
    job.message = job.error;
  });
  child.on("close", (code) => {
    clearInterval(stallWatch);
    if (abandoned()) return;
    if (job.child === child) job.child = null;
    if (job.state === "cancelled") {
      if (config.captionAssPath)
        try {
          fs.unlinkSync(config.captionAssPath);
        } catch {
          /* temporary subtitle file */
        }
      return;
    }
    if (code === 0 && fs.existsSync(config.outputPath)) {
      try { commitExportDestination(config.exportDestination); }
      catch (error) {
        job.state = "failed";
        job.error = error.message;
        job.message = job.error;
        return;
      }
      job.state = "completed";
      job.progress = 1;
      job.stage = "done";
      job.message = exportStageMessage(job);
    } else if (job.state === "failed") {
      job.message = job.error || job.message;
    } else if (retry) {
      requestRetry(stderr);
      return;
    } else {
      job.state = "failed";
      job.error = cleanFfmpegErrorMessage(stderr);
      job.message = job.error;
    }
    if (config.captionAssPath)
      try {
        fs.unlinkSync(config.captionAssPath);
      } catch {
        /* temporary subtitle file */
      }
  });
}

export function exportStatus(jobId) {
  const job = jobs.get(String(jobId || ""));
  if (!job) throw new Error("导出任务已经不存在。");
  refreshExportJob(job);
  return {
    jobId: job.id,
    state: job.state,
    progress: job.progress,
    error: job.error,
    outputPath: job.outputPath,
    encoder: job.encoder || "",
    vendor: job.vendor || "",
    mode: job.mode || "",
    stage: job.stage || "",
    speed: job.speed || 0,
    elapsed: job.startedAt ? (Date.now() - job.startedAt) / 1000 : 0,
    encoderLabel: job.encoderLabel || encoderDisplayName(job.encoder || ""),
    message: job.message || "",
  };
}

export function cancelExport(jobId) {
  const job = jobs.get(String(jobId || ""));
  if (!job || ["completed", "failed", "cancelled"].includes(job.state))
    return false;
  job.state = "cancelled";
  forceKillProcess(job.child);
  return true;
}

// Uses the production graph, including LUT strength, selective colour and beauty.
export async function renderGradePreview(input = {}) {
  const inputPath=String(input.path || '');if(!fs.existsSync(inputPath))throw Error('请先导入视频');
  const info=await probeMediaAsync(inputPath);
  const height=Math.max(320,Math.round(640*Math.max(1,info.height || 360)/Math.max(1,info.width || 640)/2)*2);
  const config={inputPath,width:640,height,fps:30,outputDuration:.1,includeVideo:true,includeAudio:false,color:input.color || {},beauty:input.beauty || {},lut:input.lut || null,removals:[],mainVideoClips:[{start:0,end:.1,sourceStart:0,sourceEnd:.1,trackId:'video'}],trackOrder:['video'],trackVisibility:{video:true},audio:{speed:1,volume:0},captions:[],titles:[],images:[],videoLayers:[],audioAssets:[]};
  const built=buildExportGraph(config,{...info,duration:.1,audioCodec:null});
  const directory=path.join(supportRoot(),'cache','grade-proof');fs.mkdirSync(directory,{recursive:true});
  const outputPath=path.join(directory,crypto.randomUUID()+'.png');
  const graph=built.graph+(built.audioLabel ? ';'+built.audioLabel+'anullsink' : '');
  await run(mediaBinary('ffmpeg'),['-y','-hide_banner','-loglevel','error','-ss',String(Math.max(0,Number(input.time || 0))),'-i',inputPath,'-filter_complex',graph,'-map',built.videoLabel,'-frames:v','1','-threads','1',outputPath]);
  return outputPath;
}

export async function renderTimelineStill(input, destination) {
  const config = { ...input, mainAudioPath: "", includeAudio: false, audioAssets: [], captionRastersViaMovie: false };
  const info = await probeMediaAsync(config.inputPath);
  if (!config.captionRasterized && (config.captions || []).length) config.captionAssPath = createAssSubtitleFile(config);
  const prepared = collectExportExtraInputs(config);
  config.captionRastersViaMovie = prepared.captionRastersViaMovie;
  const built = buildExportGraph(config, info);
  const frame = Math.max(0, Math.min(built.frameCount - 1, Math.floor(Number(input.time || 0) * built.fps + 1e-6)));
  const graph = built.graph + (built.audioLabel ? ';' + built.audioLabel + 'anullsink' : '') + ';' + built.videoLabel + 'select=eq(n\\,' + frame + ')[still]';
  const args = ['-y','-hide_banner','-loglevel','error','-filter_complex_threads','2','-i',config.inputPath,...prepared.extraInputs,'-filter_complex',graph,'-map','[still]','-frames:v','1','-threads','1',destination];
  const packed = compactFfmpegFilterArgs(args, {binary:mediaBinary('ffmpeg'), directory:path.join(supportRoot(),'temp')});
  try {
    await run(mediaBinary('ffmpeg'), packed.args);
    if (!fs.existsSync(destination) || !fs.statSync(destination).size) throw Error('当前位置未生成静帧');
    return destination;
  } finally {
    for (const file of [packed.scriptPath,config.captionAssPath]) if(file) try {fs.unlinkSync(file);}catch{}
  }
}

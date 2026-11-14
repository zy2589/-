import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  analyzePauseFrames,
  mergeRanges,
  samplesToFrames,
  waveformPeaks,
  waveformChannelPeaks,
} from "../pausecut.mjs";
import { mediaBinary, supportRoot, probeMedia, run } from "./core.mjs";

const execFileAsync = promisify(execFile);

export async function extractAudioSamples(
  inputPath,
  sampleRate = 8000,
  lowPriority = false,
  channels = 1,
) {
  const bytes = await run(mediaBinary("ffmpeg"), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    String(Math.max(1, Math.min(2, Number(channels) || 1))),
    "-ar",
    String(sampleRate),
    "-f",
    "f32le",
    "pipe:1",
  ], { lowPriority });
  return new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 4),
  );
}

export async function analyzeWaveform(inputPath, points = 1800) {
  const samples = await extractAudioSamples(inputPath, 6000, true, 2);
  return waveformChannelPeaks(
    samples,
    Math.max(600, Math.min(180000, Number(points) || 1800)),
    2,
  );
}

export async function analyzeWaveformRange(inputPath, start = 0, duration = 8) {
  const from = Math.max(0, Number(start) || 0);
  const length = Math.max(0.02, Math.min(8, Number(duration) || 8));
  const bytes = await run(mediaBinary("ffmpeg"), [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(from),
    "-i", inputPath, "-t", String(length), "-vn", "-ac", "2", "-ar", "48000",
    "-af", "aresample=48000:async=1:first_pts=0,apad", "-f", "f32le", "pipe:1",
  ], { lowPriority: true });
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  const actualDuration = samples.length / 96000;
  return { start: from, duration: actualDuration,
    waveform: actualDuration > 0 ? waveformChannelPeaks(samples, Math.max(1, Math.ceil(actualDuration * 6000)), 2) : [] };
}

export async function analyzePauses(inputPath, options = {}) {
  const info = probeMedia(inputPath);
  const samples = await extractAudioSamples(inputPath, 8000);
  const frames = samplesToFrames(samples, 8000, 20);
  const analysis = analyzePauseFrames(frames, options);
  return {
    ...analysis,
    duration: info.duration,
    outputDuration: Math.max(
      0,
      info.duration -
        analysis.removals.reduce((sum, range) => sum + range.duration, 0),
    ),
    waveform: waveformPeaks(
      samples,
      Math.max(1200, Math.min(24000, Math.round(info.duration * 60))),
    ),
  };
}

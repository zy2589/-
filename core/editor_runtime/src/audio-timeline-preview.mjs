import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildAudioExportGraph } from './media/audio-fx.mjs';
import { probeMediaAsync, mediaBinary, run, supportRoot, compactFfmpegFilterArgs } from './media/core.mjs';

const pending = new Map();
export async function prepareAudioTimeline(config) {
  if (!config?.inputPath || !Number.isFinite(Number(config.outputDuration)) || Number(config.outputDuration) <= 0)
    throw new Error('预览音轨范围无效。');
  const paths = [config.mainAudioPath || config.inputPath, ...(config.audioAssets || []).map(clip => clip.path)];
  const metadata = await Promise.all(paths.map(async file => {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('预览音频素材不是文件。');
    return [path.resolve(file), stat.size, stat.mtimeMs];
  }));
  const signature = crypto.createHash('sha256').update(JSON.stringify({format:1, config, metadata})).digest('hex');
  const directory = path.join(supportRoot(), 'previews', 'timeline-audio');
  await fs.promises.mkdir(directory, {recursive:true});
  const destination = path.join(directory, `${signature}.flac`);
  if (fs.existsSync(destination)) return {path:destination, signature};
  if (pending.has(signature)) return pending.get(signature);
  const task = (async () => {
    const source = config.mainAudioPath || config.inputPath;
    const info = await probeMediaAsync(source);
    // Preview/export share sample-bounded trims, source-rate, fades and mix.
    const built = buildAudioExportGraph(config, info, 1, 0);
    const temporary = path.join(directory, `${signature}.${crypto.randomUUID()}.partial.flac`);
    const uniquePaths = [...new Set(paths)];
    const graph = built.graph.replace(/\[(\d+):a\]/g, (_, index) => `[${uniquePaths.indexOf(paths[Number(index)])}:a]`);
    const inputs = uniquePaths.flatMap(file => ['-i', file]);
    const compact = compactFfmpegFilterArgs([
      '-y','-hide_banner','-loglevel','error','-filter_complex_threads','2', ...inputs,
      '-filter_complex', graph, '-map', built.audioLabel,
      '-t', String(config.outputDuration), '-ar','48000','-ac','2','-c:a','flac', temporary,
    ], {directory});
    try {
      await run(mediaBinary('ffmpeg'), compact.args, {windowsHide:true});
      const stat = await fs.promises.stat(temporary);
      if (stat.size < 128) throw new Error('连续预览音轨生成失败。');
      await fs.promises.rename(temporary, destination);
      return {path:destination, signature};
    } finally {
      await fs.promises.unlink(temporary).catch(() => {});
      if (compact.scriptPath) await fs.promises.unlink(compact.scriptPath).catch(() => {});
    }
  })();
  pending.set(signature, task);
  try { return await task; } finally { pending.delete(signature); }
}

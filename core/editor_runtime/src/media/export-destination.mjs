import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function prepareExportDestination(outputPath, inputPath) {
  const output = path.resolve(String(outputPath));
  const source = path.resolve(String(inputPath));
  const same = process.platform === 'win32' ? output.toLowerCase() === source.toLowerCase() : output === source;
  if (same) throw new Error('导出位置与原素材相同，请选择其他文件名，避免覆盖原素材。');
  const directory = path.dirname(output);
  const temporary = path.join(directory, `.export-${crypto.randomUUID()}${path.extname(output) || '.mp4'}`);
  try {
    fs.mkdirSync(directory, {recursive:true});
    const fd = fs.openSync(temporary, 'wx');
    fs.closeSync(fd);
    fs.unlinkSync(temporary);
  } catch (error) {
    throw new Error(`无法写入导出文件夹，请选择可写的位置：${directory}（${error.code || error.message}）`);
  }
  return {output, temporary};
}

export function commitExportDestination(destination) {
  if (!destination) return;
  try { fs.renameSync(destination.temporary, destination.output); }
  catch (error) {
    throw new Error(`成片已生成，但无法替换目标文件。请关闭正在播放或占用目标文件的软件，或使用其他文件名。成片保留在：${destination.temporary}（${error.code || error.message}）`);
  }
}

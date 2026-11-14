import {readLargeJson} from './large-json-file.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const startedAt = Date.now();
const tickets = new Map();
let activityVersion = 0;
export function notifyCacheActivity() { activityVersion++; }
const normalized = file => path.resolve(file).toLowerCase();
async function noLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if ((await fs.lstat(current)).isSymbolicLink()) return false;
    if (path.dirname(current) === current) return true;
  }
}
async function walk(directory, visit) {
  let entries;
  try { if (!await noLinks(directory)) throw Error('目录链接不允许扫描'); entries = await fs.readdir(directory,{withFileTypes:true}); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw Error('发现目录链接，无法确认缓存引用；已停止清理');
    const file = path.join(directory,entry.name);
    if (entry.isDirectory()) await walk(file,visit);
    else if (entry.isFile()) await visit(file);
  }
}
async function referencedPaths(root) {
  const paths = new Set();
  const unreadableProjects = [];
  function visit(value) {
    if (typeof value === 'string' && path.isAbsolute(value)) paths.add(normalized(value));
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  for (const name of ['projects','splice-projects','deleted-projects']) await walk(path.join(root,name), async file => {
    if (!/\.json(?:\.deleted)?$/i.test(file) || path.basename(file) === 'card.json') return;
    try { visit(readLargeJson(file)); }
    catch { unreadableProjects.push(file); }
  });
  return {paths,unreadableProjects};
}
async function candidates(root) {
  const {paths:references,unreadableProjects} = await referencedPaths(root);
  const files = [];
  const cutoff = Math.min(startedAt,Date.now()-86400000);
  for (const name of ['previews/media','temp']) await walk(path.join(root,name),async file => {
    const relative = path.relative(root,file).replaceAll('\\','/');
    const known = /^previews\/media\/[a-f0-9]{20}\.png$/.test(relative)
      || /^temp\/caption-raster-[a-f0-9-]+\/[^/]+\.png$/.test(relative);
    // If project media references cannot be validated, never remove cached media
    // previews. Old, uniquely named caption raster temp files remain safe candidates.
    if (unreadableProjects.length && relative.startsWith('previews/media/')) return;
    if (!known || references.has(normalized(file))) return;
    const stat = await fs.lstat(file);
    if (stat.isFile() && stat.mtimeMs < cutoff && stat.nlink === 1)
      files.push({file,size:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino});
  });
  return {files,unreadableProjects:unreadableProjects.length};
}
export async function scanSafeCache(root) {
  const {files,unreadableProjects} = await candidates(root);
  const token = crypto.randomUUID();
  tickets.clear(); tickets.set(token,{root,files,unreadableProjects,expires:Date.now()+300000});
  return {token,bytes:files.reduce((sum,item)=>sum+item.size,0),count:files.length,unreadableProjects};
}
export async function cleanSafeCache(root,token) {
  const ticket = tickets.get(token); tickets.delete(token);
  if (!ticket || ticket.root !== root || ticket.expires < Date.now()) throw Error('统计已过期，请重新点击清理缓存');
  const activity = activityVersion;
  const latest = await candidates(root);
  const current = new Map(latest.files.map(item=>[item.file,item]));
  let bytes=0,removed=0,skipped=0;
  for (const item of ticket.files) {
    if (activity !== activityVersion) { skipped=ticket.files.length-removed; break; }
    try {
      const fresh=current.get(item.file);
      if (!fresh || fresh.size!==item.size || fresh.mtimeMs!==item.mtimeMs || fresh.ino!==item.ino || !await noLinks(item.file)) { skipped++; continue; }
      if (activity !== activityVersion) { skipped=ticket.files.length-removed; break; }
      await fs.unlink(item.file); bytes+=item.size; removed++;
    } catch { skipped++; }
  }
  return {bytes,removed,skipped,unreadableProjects:Math.max(ticket.unreadableProjects,latest.unreadableProjects)};
}

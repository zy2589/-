import {readLargeJson} from './large-json-file.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const startedAt = Date.now();
const tickets = new Map();
let activityVersion = 0;
export function notifyCacheActivity() { activityVersion++; }
const normalized = file => path.resolve(file).toLowerCase();
const inside = (parent, child) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

async function noLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if ((await fs.lstat(current)).isSymbolicLink()) return false;
    if (path.dirname(current) === current) return true;
  }
}

async function walk(directory, visit) {
  let entries;
  try {
    if (!await noLinks(directory)) throw Error('目录链接不允许扫描');
    entries = await fs.readdir(directory,{withFileTypes:true});
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
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

async function validatedWorkspaceRoot(root, workspaceHint) {
  if (!workspaceHint) return '';
  const userDataRoot = path.resolve(workspaceHint);
  if (path.basename(userDataRoot).toLowerCase() !== '用户数据') return '';
  if (path.resolve(root).toLowerCase() !== path.join(userDataRoot,'编辑器数据').toLowerCase()) return '';
  const workspace = path.dirname(userDataRoot);
  if (!await noLinks(workspace)) return '';
  try {
    const [buildScript,packageFile,releaseDir,buildDir] = await Promise.all([
      fs.stat(path.join(workspace,'build.ps1')),
      fs.stat(path.join(workspace,'core','editor_runtime','package.json')),
      fs.stat(path.join(workspace,'release')),
      fs.stat(path.join(workspace,'.build')),
    ]);
    if (!buildScript.isFile() || !packageFile.isFile() || !releaseDir.isDirectory() || !buildDir.isDirectory()) return '';
    return workspace;
  } catch { return ''; }
}

async function packageRoots(workspace) {
  if (!workspace) return [];
  const build = path.join(workspace,'.build');
  const roots = [
    path.join(workspace,'release','archives'),
    path.join(build,'github-release'),
    ...['work','codex-temp','preflight-temp','release-audit-env','security-audit-profile']
      .map(name => path.join(build,name)),
  ];
  try {
    for (const entry of await fs.readdir(build,{withFileTypes:true})) {
      if (entry.isDirectory() && !entry.isSymbolicLink() &&
          /^(caption-gap|compression-qa|drive-download-qa|node-pty-probe|recording-review|startup-alpha|title-preview-qa)/i.test(entry.name))
        roots.push(path.join(build,entry.name));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return roots;
}

async function packageCandidates(workspace) {
  if (!workspace) return {files:[],roots:[]};
  const roots = await packageRoots(workspace);
  const files = [];
  const cutoff=Math.min(startedAt,Date.now()-86400000);
  let latestArchiveVersion='';
  try {
    const names=await fs.readdir(path.join(workspace,'release','archives'));
    latestArchiveVersion=names.map(name=>name.match(/^ClipAssistant-(?:installer|portable)-(\d{8}-\d{6})(?:\.zip(?:\.sha256)?)?$/i)?.[1]||'')
      .filter(Boolean).sort().at(-1)||'';
  } catch (error) { if (error.code!=='ENOENT') throw error; }
  for (const directory of roots) {
    await walk(directory, async file => {
      const stat = await fs.lstat(file);
      if (stat.isFile() && stat.nlink === 1 && stat.mtimeMs<cutoff)
        files.push({file,size:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino});
    });
  }
  const release = path.join(workspace,'release');
  try {
    if (await noLinks(release)) {
      for (const entry of await fs.readdir(release,{withFileTypes:true})) {
        if (!entry.isFile() || !/\.(?:zip|sha256)$/i.test(entry.name)) continue;
        if (latestArchiveVersion && entry.name.includes(latestArchiveVersion)) continue;
        const file = path.join(release,entry.name);
        const stat = await fs.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.mtimeMs<cutoff)
          files.push({file,size:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino});
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {files,roots};
}

async function pythonBytecodeCandidates(workspace,cutoff) {
  if (!workspace) return [];
  const files=[];
  async function visit(directory,isWorkspaceRoot=false) {
    let entries;
    try {
      if (!await noLinks(directory)) return;
      entries=await fs.readdir(directory,{withFileTypes:true});
    } catch (error) { if (error.code==='ENOENT') return; throw error; }
    if (path.basename(directory)==='__pycache__') {
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.pyc')) continue;
        const file=path.join(directory,entry.name);
        const stat=await fs.lstat(file);
        if (stat.isFile() && stat.mtimeMs<cutoff && stat.nlink===1)
          files.push({file,size:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino});
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (isWorkspaceRoot && ['.git','release','用户数据','.codex','node_modules'].includes(entry.name)) continue;
      await visit(path.join(directory,entry.name));
    }
  }
  await visit(workspace,true);
  return files;
}

const browserCacheRoots = [
  'window-profile/Cache','window-profile/Code Cache','window-profile/GPUCache',
  'window-profile/GrShaderCache','window-profile/ShaderCache','window-profile/GPUPersistentCache',
  'window-profile/Default/Cache','window-profile/Default/Code Cache','window-profile/Default/GPUCache',
  'window-profile/Default/GrShaderCache','window-profile/Default/ShaderCache',
  'window-profile/Default/DawnGraphiteCache','window-profile/Default/DawnWebGPUCache',
];

async function cacheCandidates(root,workspace='') {
  const {paths:references,unreadableProjects} = await referencedPaths(root);
  const files = [];
  const cutoff = Math.min(startedAt,Date.now()-86400000);
  const roots = ['previews/media','previews/timeline-audio','temp','transcript-cache',...browserCacheRoots];
  for (const name of roots) await walk(path.join(root,name),async file => {
    const relative = path.relative(root,file).replaceAll('\\','/');
    const known = /^previews\/media\/[a-f0-9]{20}\.png$/i.test(relative)
      || /^previews\/timeline-audio\/[a-f0-9]{64}\.flac$/i.test(relative)
      || /^temp\/caption-raster-[a-f0-9-]+\/[^/]+\.png$/i.test(relative)
      || /^temp\/caption-concat-[a-f0-9-]+\/[^/]+$/i.test(relative)
      || /^transcript-cache\/[a-f0-9]{64}\.json$/i.test(relative)
      || browserCacheRoots.some(cacheRoot => relative.startsWith(`${cacheRoot}/`));
    if (!known || references.has(normalized(file))) return;
    // If project files cannot be checked, skip every cache under previews.
    if (unreadableProjects.length && relative.startsWith('previews/')) return;
    const stat = await fs.lstat(file);
    if (stat.isFile() && stat.mtimeMs < cutoff && stat.nlink === 1)
      files.push({file,size:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino});
  });
  files.push(...await pythonBytecodeCandidates(workspace,cutoff));
  return {files,unreadableProjects:unreadableProjects.length};
}

function sumBytes(files) { return files.reduce((sum,item)=>sum+item.size,0); }
function category(files) { return {bytes:sumBytes(files),count:files.length}; }

export async function scanSafeCache(root, workspaceHint = '') {
  const workspace=await validatedWorkspaceRoot(root,workspaceHint);
  const cache=await cacheCandidates(root,workspace);
  const packages = await packageCandidates(workspace);
  const token = crypto.randomUUID();
  tickets.clear();
  tickets.set(token,{
    root,workspaceRoot:workspace,cacheFiles:cache.files,packageFiles:packages.files,
    packageRoots:packages.roots,unreadableProjects:cache.unreadableProjects,expires:Date.now()+300000,
  });
  const categories = {caches:category(cache.files),packages:category(packages.files)};
  return {token,bytes:categories.caches.bytes+categories.packages.bytes,
    count:categories.caches.count+categories.packages.count,categories,
    unreadableProjects:cache.unreadableProjects};
}

function sameFile(current, expected) {
  return current && current.size === expected.size && current.mtimeMs === expected.mtimeMs && current.ino === expected.ino;
}

async function removeFiles(expectedFiles, latestFiles, activityChanged = () => false) {
  const current = new Map(latestFiles.map(item=>[item.file,item]));
  let bytes=0,removed=0,skipped=0;
  for (const item of expectedFiles) {
    if (activityChanged()) { skipped=expectedFiles.length-removed; break; }
    try {
      const fresh=current.get(item.file);
      if (!sameFile(fresh,item) || !await noLinks(item.file)) { skipped++; continue; }
      const stat = await fs.lstat(item.file);
      if (!stat.isFile() || stat.nlink !== 1) { skipped++; continue; }
      if (activityChanged()) { skipped=expectedFiles.length-removed; break; }
      await fs.unlink(item.file); bytes+=item.size; removed++;
    } catch { skipped++; }
  }
  return {bytes,removed,skipped};
}

async function pruneEmptyDirectories(files, roots) {
  const candidates = new Set();
  for (const item of files) {
    let current = path.dirname(item.file);
    for (const root of roots) {
      if (path.resolve(current).toLowerCase() === path.resolve(root).toLowerCase()) break;
      if (!inside(root,current)) continue;
      candidates.add(current);
      current = path.dirname(current);
    }
  }
  for (const directory of [...candidates].sort((a,b)=>b.length-a.length)) {
    try { if (await noLinks(directory)) await fs.rmdir(directory); } catch {}
  }
}

export async function cleanSafeCache(root,token,selectedCategories = ['caches']) {
  const ticket = tickets.get(token); tickets.delete(token);
  if (!ticket || ticket.root !== root || ticket.expires < Date.now()) throw Error('统计已过期，请重新点击清理缓存');
  const selected = new Set(Array.isArray(selectedCategories) ? selectedCategories : ['caches']);
  if ([...selected].some(name => !['caches','packages'].includes(name))) throw Error('清理类别无效，请重新扫描');

  let cacheResult={bytes:0,removed:0,skipped:0};
  let packageResult={bytes:0,removed:0,skipped:0};
  if (selected.has('caches')) {
    const activity=activityVersion;
    const latest=await cacheCandidates(root,ticket.workspaceRoot);
    cacheResult=await removeFiles(ticket.cacheFiles,latest.files,()=>activity!==activityVersion);
    cacheResult.unreadableProjects=Math.max(ticket.unreadableProjects,latest.unreadableProjects);
  }
  if (selected.has('packages')) {
    const latest=await packageCandidates(ticket.workspaceRoot);
    packageResult=await removeFiles(ticket.packageFiles,latest.files);
    await pruneEmptyDirectories(ticket.packageFiles,ticket.packageRoots);
  }
  return {
    bytes:cacheResult.bytes+packageResult.bytes,
    removed:cacheResult.removed+packageResult.removed,
    skipped:cacheResult.skipped+packageResult.skipped,
    cacheBytes:cacheResult.bytes,cacheRemoved:cacheResult.removed,cacheSkipped:cacheResult.skipped,
    packageBytes:packageResult.bytes,packageRemoved:packageResult.removed,packageSkipped:packageResult.skipped,
    unreadableProjects:cacheResult.unreadableProjects||0,
  };
}

import {readLargeJson} from './large-json-file.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

export function projectMetadata(value) {
  return { id: value.id, name: value.name, createdAt: value.createdAt,
    updatedAt: value.updatedAt, ratio: value.data?.ratio || value.ratio || '9:16',
    duration: Number(value.data?.duration || 0), videoName: value.videoName || '',
    thumbnailPath: value.thumbnailPath || '' };
}

export function writeProjectMetadata(directory, value) {
  const file = path.join(directory, 'card.json');
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(projectMetadata(value)));
  fs.renameSync(temporary, file);
}

export function filterProjectMetadata(items, query = {}, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const term = String(query.search || '').trim().toLowerCase();
  const period = query.period || 'today';
  const cutoff = /^older(15|30|60|90)$/.test(period)
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - Number(period.slice(5))).getTime()
    : period === 'custom' ? new Date(`${query.before}T00:00:00`).getTime() : NaN;
  return items.filter(item => {
    if (term && !String(item.name || '').toLowerCase().includes(term)) return false;
    const stamp = Date.parse(item.updatedAt);
    if (!Number.isFinite(stamp) || stamp > now.getTime()) return period === 'all' || (!!term && !query.selection);
    if (term && !query.selection) return true;
    if (period === 'all') return true;
    if (period === 'today') return stamp >= today.getTime();
    if (period === 'yesterday') return stamp >= yesterday.getTime() && stamp < today.getTime();
    return Number.isFinite(cutoff) && stamp < cutoff;
  }).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
}

let worker;
let sequence = 0;
const pending = new Map();
export function queryProjectCatalog(root, query = {}) {
  if (!worker) {
    worker = new Worker(new URL(import.meta.url));
    worker.on('message', ({id, result, error}) => {
      const task = pending.get(id); if (!task) return;
      pending.delete(id); error ? task.reject(new Error(error)) : task.resolve(result);
      if (!pending.size) worker?.unref();
    });
    const fail = error => {
      for (const task of pending.values()) task.reject(error);
      pending.clear(); worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', code => { if (code) fail(new Error('工程索引线程已停止')); });
  }
  worker.ref();
  return new Promise((resolve,reject) => {
    const id = ++sequence; pending.set(id,{resolve,reject}); worker.postMessage({id,root,query});
  });
}

if (!isMainThread) {
  const cache = new Map();
  const migration = new Map();
  let draining = false;
  function migrateNext() {
    const next = migration.entries().next();
    if (next.done) { draining = false; return; }
    const [file, directory] = next.value;
    migration.delete(file);
    try {
      const stat = fs.statSync(file);
      const project = readLargeJson(file);
      cache.set(file,{key:`${stat.mtimeMs}:${stat.size}`,value:projectMetadata(project)});
      try { writeProjectMetadata(directory,project); } catch {}
    } catch {}
    setTimeout(migrateNext,1);
  }
  parentPort.on('message', ({id,root,query}) => {
    try {
      const items = [];
      const excluded = new Set(Array.isArray(query.excludeIds) ? query.excludeIds : []);
      for (const entry of fs.readdirSync(root,{withFileTypes:true})) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{24,64}$/i.test(entry.name)) continue;
        if (excluded.has(entry.name)) continue;
        const directory = path.join(root,entry.name);
        try {
          if (fs.existsSync(path.join(directory,'.deleted'))) continue;
          const file = path.join(directory,'project.json');
          const stat = fs.statSync(file);
          const key = `${stat.mtimeMs}:${stat.size}`;
          let record = cache.get(file);
          if (record?.key !== key) {
            let value;
            try {
              if (fs.statSync(path.join(directory,'card.json')).mtimeMs < stat.mtimeMs) throw Error('stale');
              value = JSON.parse(fs.readFileSync(path.join(directory,'card.json'),'utf8'));
              if (value.id !== entry.name) throw Error('invalid');
            } catch {
              // Legacy projects have no lightweight record. Prioritize likely
              // matches and build the rest incrementally after the first page.
              if (!query.idsOnly && !query.search && query.period !== 'all' && !filterProjectMetadata([{id:entry.name,updatedAt:stat.mtime.toISOString()}],query).length) {
                migration.set(file,directory);
                if (!draining) { draining=true; setTimeout(migrateNext,1); }
                continue;
              }
              const project = readLargeJson(file);
              value = projectMetadata(project);
              // Derived index only. Never modify the authoritative project file.
              try { writeProjectMetadata(directory,project); } catch {}
            }
            record = {key,value}; cache.set(file,record);
          }
          items.push(record.value);
        } catch {}
      }
      const filtered = filterProjectMetadata(items,query);
      const offset = Math.max(0,Number(query.offset)||0);
      const limit = Math.max(1,Math.min(100,Number(query.limit)||40));
      parentPort.postMessage({id,result:{indexing:migration.size > 0,items:query.idsOnly ? [] : filtered.slice(offset,offset+limit),
        total:filtered.length, selection:query.idsOnly ? filtered.map(({id,updatedAt})=>({id,updatedAt})) : undefined}});
    } catch (error) { parentPort.postMessage({id,error:error.message}); }
  });
}

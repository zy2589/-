import fs from 'node:fs/promises';
import path from 'node:path';

export async function searchRelinkFolder(root, assets = []) {
  const index = new Map(), pending = [path.resolve(root)];
  const wanted = new Set(assets.map(a => String(a.sourceIdentity?.name || path.basename(a.originalPath || a.path || '')).toLowerCase()));
  let scanned = 0;
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {entries = await fs.readdir(directory, {withFileTypes:true});}
    catch (error) {if(directory === path.resolve(root)) throw error; continue;}
    for (const entry of entries) {
      if (++scanned > 200000) throw new Error('搜索范围过大，请选择更具体的素材文件夹。');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
        const key=entry.name.toLowerCase();
        if(!index.has(key)) index.set(key,[]);
        try {index.get(key).push({path:file,size:(await fs.stat(file)).size});} catch {}
      }
    }
  }
  return assets.map(asset => {
    const name=String(asset.sourceIdentity?.name || path.basename(asset.originalPath || asset.path || ''));
    const size=asset.sourceIdentity?.size;
    const candidates=(index.get(name.toLowerCase()) || []).filter(file => size == null || file.size === Number(size));
    return {asset,name,status:candidates.length === 1 ? 'matched' : candidates.length ? 'ambiguous' : 'missing',path:candidates.length === 1 ? candidates[0].path : null};
  });
}

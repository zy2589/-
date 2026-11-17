import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function transcriptCacheKey(inputPath, settings = {}) {
  const stat=fs.statSync(inputPath);
  const context={version:1,path:path.resolve(inputPath),size:stat.size,mtime:stat.mtimeMs,
    engine:settings.engine,language:settings.language,model:settings.engine==='local'?settings.localModel:settings.reviewModel || ''};
  if(settings.engine==='deepgram'&&Number.isFinite(Number(settings.deepgramChunkSeconds)))context.deepgramChunkSeconds=Number(settings.deepgramChunkSeconds);
  return crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex');
}
export function readTranscriptCache(root,key) {
  try {
    const record=JSON.parse(fs.readFileSync(path.join(root,'transcript-cache',key+'.json'),'utf8'));
    return record.key===key && Array.isArray(record.segments) && record.segments.length && record.segments.every(s=>typeof s.text==='string' && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end>s.start) ? record : null;
  } catch {return null;}
}
export function writeTranscriptCache(root,key,segments,fallbackText='') {
  if(!key || !segments?.length)return;
  const directory=path.join(root,'transcript-cache');fs.mkdirSync(directory,{recursive:true});
  const target=path.join(directory,key+'.json'),temporary=target+'.'+crypto.randomUUID()+'.tmp';
  try {fs.writeFileSync(temporary,JSON.stringify({key,segments,fallbackText}));fs.renameSync(temporary,target);}
  finally {try{fs.unlinkSync(temporary);}catch{}}
}

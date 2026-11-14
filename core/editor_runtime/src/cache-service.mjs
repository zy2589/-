import { Worker, isMainThread, parentPort } from 'node:worker_threads';

let worker, sequence = 0;
const pending = new Map();
export function notifyCacheActivity() { worker?.postMessage({activity:true}); }
function request(method, root, token) {
  if (!worker) {
    const current = worker = new Worker(new URL(import.meta.url), {execArgv:process.execArgv.filter(arg=>!arg.startsWith('--input-type'))});
    const fail = error => {
      if (worker !== current) return;
      worker = null;
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    };
    current.on('error',fail);
    current.on('exit',()=>fail(new Error('缓存后台任务已结束，请重试')));
    current.on('message',({id,result,error})=>{
      const task=pending.get(id); if(!task)return;
      pending.delete(id); error?task.reject(new Error(error)):task.resolve(result);
      if (!pending.size) current.unref();
    });
  }
  worker.ref();
  return new Promise((resolve,reject)=>{
    const id=++sequence; pending.set(id,{resolve,reject}); worker.postMessage({id,method,root,token});
  });
}
export const scanSafeCache = root => request('scan',root);
export const cleanSafeCache = (root,token) => request('clean',root,token);

if (!isMainThread) {
  const engine=await import('./cache-maintenance.mjs');
  let busy=false;
  parentPort.on('message',async message=>{
    if (message.activity) { engine.notifyCacheActivity(); return; }
    const {id,method,root,token}=message;
    if (busy) { parentPort.postMessage({id,error:'缓存任务正在后台运行'}); return; }
    busy=true;
    try {
      const result=method==='scan'?await engine.scanSafeCache(root):await engine.cleanSafeCache(root,token);
      parentPort.postMessage({id,result});
    } catch(error) {parentPort.postMessage({id,error:error.message});}
    finally {busy=false;}
  });
}

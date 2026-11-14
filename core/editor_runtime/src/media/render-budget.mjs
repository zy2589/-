import os from 'node:os';
import {spawnSync} from 'node:child_process';
let cachedGpu=null,checkedAt=0;
export function renderSlotLimit({freeMemory=os.freemem(),gpuMemoryMiB=null,pixels=1920*1080,hardware=true}={}) {
  const cost=Math.max(768,Math.ceil(pixels/(1920*1080)*768));
  const ramSlots=Math.max(1,Math.floor(freeMemory/(1024*1024*1024*2)));
  const gpuSlots=gpuMemoryMiB==null ? 2 : Math.max(1,Math.floor((gpuMemoryMiB-512)/cost));
  return Math.max(1,Math.min(hardware ? 4 : 2,ramSlots,hardware ? gpuSlots : 2));
}
export function freeGpuMemoryMiB() {
  if(Date.now()-checkedAt<10000)return cachedGpu;
  checkedAt=Date.now();
  try {const r=spawnSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true,timeout:1500});
    const value=Number(String(r.stdout || '').trim().split(/\r?\n/)[0]);cachedGpu=r.status===0 && value>0 ? value : null;
  }catch{cachedGpu=null;}
  return cachedGpu;
}

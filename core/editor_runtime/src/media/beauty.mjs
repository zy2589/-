import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { supportRoot, escapeFilterPath } from './core.mjs';
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,Number(x)||0));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
export function skinMask(r,g,b) {
  const lum=.299*r+.587*g+.114*b;
  return smooth(.005,.13,r-g)*smooth(-.045,.14,g-b)*smooth(.025,.17,Math.max(r,g,b)-Math.min(r,g,b))*smooth(.08,.32,lum)*(1-smooth(.94,1,lum));
}
export function normalizeBeauty(v={}) {
  return {smoothing:clamp(v.smoothing/100),blemish:clamp(v.blemish/100),texture:clamp(v.texture/100),whitening:clamp(v.whitening/100),brighten:clamp(v.brighten/100,-1,1),warmth:clamp(v.warmth/50,-1,1),rosy:clamp(v.rosy/100,-1,1)};
}
export function beautyPixel(rgb,b) {
  const m=skinMask(...rgb);
  const c=rgb.map(x=>(x+(Math.pow(Math.max(0,x),.78)-x)*b.whitening*.58*m)*(1+b.brighten*.13*m));
  c[0]+=(b.warmth*.030+b.rosy*.024)*m;c[1]-=b.rosy*.009*m;c[2]-=b.warmth*.020*m;
  return c.map(x=>clamp(x));
}
function cubeFile(key,pixel) {
  const dir=path.join(supportRoot(),'cache','beauty-luts');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,crypto.createHash('sha256').update('v1:'+key).digest('hex')+'.cube');
  if(fs.existsSync(file))return file;
  const size=33,rows=['TITLE "DaVinci Assistant skin correction"','LUT_3D_SIZE '+size,'DOMAIN_MIN 0 0 0','DOMAIN_MAX 1 1 1'];
  for(let b=0;b<size;b++)for(let g=0;g<size;g++)for(let r=0;r<size;r++)rows.push(pixel([r/(size-1),g/(size-1),b/(size-1)]).map(x=>x.toFixed(7)).join(' '));
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,rows.join('\n'));fs.renameSync(temporary,file);return file;
}
export function appendBeautyGraph(graph,input,values={}) {
  const b=normalizeBeauty(values);if(Object.values(b).every(v=>Math.abs(v)<.001))return input;
  let current=input;
  if(b.smoothing || b.blemish || b.texture) {
    const mask=cubeFile('skin-mask',rgb=>{const m=skinMask(...rgb);return [m,m,m];});
    graph.push(`${current}format=gbrp,split=3[qcbOriginal][qcbEffect][qcbMaskIn]`);
    const chain=[];
    // Keep a single moderate spatial pass. The point repair above does local
    // retouching; a heavy denoise pass over every frame is both slow and waxy.
    if(b.smoothing || b.blemish)chain.push(`hqdn3d=${(b.smoothing*2.4+b.blemish*3.0).toFixed(3)}:${(b.smoothing*0.9+b.blemish*1.6).toFixed(3)}:0:0`);
    if(b.texture)chain.push(`unsharp=5:5:${(b.texture*.85).toFixed(3)}:5:5:0`);
    graph.push(`[qcbEffect]${chain.join(',')},format=gbrp[qcbSoft]`);
    graph.push(`[qcbMaskIn]lut3d=file='${escapeFilterPath(mask)}':interp=tetrahedral,format=gbrp[qcbMask]`);
    graph.push('[qcbOriginal][qcbSoft][qcbMask]maskedmerge[qcbMerged]');current='[qcbMerged]';
  }
  if(b.whitening || b.brighten || b.warmth || b.rosy){
    const lut=cubeFile(JSON.stringify([b.whitening,b.brighten,b.warmth,b.rosy]),rgb=>beautyPixel(rgb,b));
    graph.push(`${current}lut3d=file='${escapeFilterPath(lut)}':interp=tetrahedral[qcbColor]`);current='[qcbColor]';
  }
  return current;
}

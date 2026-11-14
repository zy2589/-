import fs from 'node:fs';
import path from 'node:path';
import {seedUserPreference} from './user-seeds.mjs';
const keys=new Set(['exportFormat','exportResolution','exportFps','exportCodec','exportBitrate','exportQuality','exportRf','exportColorSpace','encoderDevice','directory','ccProofread']);
export function exportPreferencesStore(root){
 const file=path.join(root,'export-preferences.json');
 const load=()=>{seedUserPreference(file,'export-preferences.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{}};
 return {load,save(input={}){const result=load();for(const [key,value] of Object.entries(input))if(keys.has(key)&&(typeof value==='boolean'||typeof value==='string'&&value.length<=2048))result[key]=value;fs.mkdirSync(root,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(result,null,2));fs.renameSync(file+'.tmp',file);return result;}};
}

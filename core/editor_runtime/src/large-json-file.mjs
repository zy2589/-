import fs from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import {JsonChunkParser,bufferedJsonChunks} from './large-json-codec.mjs';
export function readLargeJson(file){
 const fd=fs.openSync(file,'r'),parser=new JsonChunkParser(),decoder=new StringDecoder('utf8'),buffer=Buffer.allocUnsafe(256*1024);
 try{let length;while((length=fs.readSync(fd,buffer,0,buffer.length,null)))parser.write(decoder.write(buffer.subarray(0,length)));parser.write(decoder.end());return parser.finish();}finally{fs.closeSync(fd);}
}
export function writeLargeJson(file,value){
 const fd=fs.openSync(file,'w',0o600);try{for(const chunk of bufferedJsonChunks(value))fs.writeFileSync(fd,chunk,'utf8');}finally{fs.closeSync(fd);}
}

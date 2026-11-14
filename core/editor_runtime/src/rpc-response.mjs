import {bufferedJsonChunks} from './large-json-codec.mjs';
function drainOrClose(response){
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{response.off('drain',drain);response.off('close',close);response.off('error',error);};
    const drain=()=>{cleanup();resolve();};
    const error=e=>{cleanup();reject(e);};
    const close=()=>error(new Error('RPC client disconnected'));
    response.once('drain',drain);response.once('close',close);response.once('error',error);
    if(response.destroyed)close();
  });
}
export async function sendRpcJson(response,value){
  response.writeHead(200);
  for(const chunk of bufferedJsonChunks(value)){
    if(response.destroyed)throw new Error('RPC client disconnected');
    if(!response.write(chunk))await drainOrClose(response);
  }
  response.end();
}
export function failRpcJson(response,error){
  if(response.destroyed||response.writableEnded)return;
  if(response.headersSent){response.destroy();return;}
  response.writeHead(500);
  response.end(JSON.stringify({ok:false,error:{message:error?.message||String(error),code:error?.code||'RPC_ERROR'}}));
}

// Shared by the local RPC client/server. No whole-document string is required.
export class JsonChunkParser {
  constructor(){this.stack=[];this.hasRoot=false;this.root=undefined;this.mode='';this.parts=[];this.escape=false;}
  frame(){return this.stack.at(-1);}
  value(value){
    const f=this.frame();
    if(!f){if(this.hasRoot)throw new SyntaxError('JSON contains multiple values');this.hasRoot=true;this.root=value;return;}
    if(!['value','valueOrEnd'].includes(f.state))throw new SyntaxError('Unexpected JSON value');
    if(f.array)f.value.push(value);else Object.defineProperty(f.value,f.key,{value,writable:true,enumerable:true,configurable:true});
    f.state='commaOrEnd';
  }
  token(){
    const text=this.parts.join('');this.parts=[];const value=JSON.parse(text),f=this.frame();
    if(this.mode==='string'&&f&&['key','keyOrEnd'].includes(f.state)){f.key=value;f.state='colon';}
    else this.value(value);
    this.mode='';
  }
  write(text){
    let i=0;
    while(i<text.length){
      if(this.mode==='string'){
        const start=i;
        if(this.escape){i++;this.escape=false;}
        const special=/["\\\u0000-\u001f]/g;special.lastIndex=i;let match;
        while((match=special.exec(text))){
          i=match.index;
          if(text[i]==='"'){this.parts.push(text.slice(start,i+1));i++;this.token();break;}
          if(text[i]!=='\\')throw new SyntaxError('Unescaped JSON control character');
          if(i+1>=text.length){this.escape=true;i=text.length;break;}
          i+=2;special.lastIndex=i;
        }
        if(this.mode==='string'){this.parts.push(text.slice(start));i=text.length;}
        continue;
      }
      if(this.mode){
        const start=i,valid=this.mode==='number'?/[0-9eE+.-]/:/[a-z]/;
        while(i<text.length&&valid.test(text[i]))i++;
        this.parts.push(text.slice(start,i));
        if(i<text.length)this.token();else break;
        continue;
      }
      const c=text[i++],f=this.frame();
      if(/\s/.test(c)){if(!/[ \t\r\n]/.test(c))throw new SyntaxError('Invalid JSON whitespace');continue;}
      if(c==='"'){this.mode='string';this.parts=['"'];continue;}
      if(c==='{'||c==='['){const array=c==='[',value=array?[]:{};this.value(value);this.stack.push({array,value,state:array?'valueOrEnd':'keyOrEnd'});continue;}
      if(c==='}'||c===']'){
        if(!f||f.array!==(c===']')||!['commaOrEnd',f.array?'valueOrEnd':'keyOrEnd'].includes(f.state))throw new SyntaxError('Invalid JSON container ending');
        this.stack.pop();continue;
      }
      if(c===':'){if(!f||f.state!=='colon')throw new SyntaxError('Unexpected JSON colon');f.state='value';continue;}
      if(c===','){if(!f||f.state!=='commaOrEnd')throw new SyntaxError('Unexpected JSON comma');f.state=f.array?'value':'key';continue;}
      if(/[0-9-]/.test(c)){this.mode='number';this.parts=[c];continue;}
      if(/[tfn]/.test(c)){this.mode='literal';this.parts=[c];continue;}
      throw new SyntaxError('Unexpected JSON character');
    }
  }
  finish(){if(this.mode==='string')throw new SyntaxError('Unterminated JSON string');if(this.mode)this.token();if(this.stack.length||!this.hasRoot)throw new SyntaxError('Incomplete JSON');return this.root;}
}
export function* jsonChunks(value,seen=new Set()) {
  if(value&&typeof value.toJSON==='function')value=value.toJSON();
  if(!value||typeof value!=='object'){yield JSON.stringify(value)??'null';return;}
  if(seen.has(value))throw new TypeError('Circular JSON');seen.add(value);
  const array=Array.isArray(value);yield array?'[':'{';let comma=false;
  for(const key of array?value.keys():Object.keys(value)){
    const item=value[key];if(!array&&['undefined','function','symbol'].includes(typeof item))continue;
    if(comma)yield ',';comma=true;if(!array){yield JSON.stringify(key);yield ':';}
    yield* jsonChunks(item,seen);
  }
  yield array?']':'}';seen.delete(value);
}
export function* bufferedJsonChunks(value,limit=64*1024){
  let parts=[],length=0;
  for(const part of jsonChunks(value)){parts.push(part);length+=part.length;if(length>=limit){yield parts.join('');parts=[];length=0;}}
  if(parts.length)yield parts.join('');
}

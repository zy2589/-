// Only abbreviations explicitly confirmed for this editing workflow.
const bibleVersions = new Set(['AKJV','AKGV']);
export function normalizeBibleVersionSegments(segments = []) {
 const result=[];
 const normalize=text=>String(text||'').replace(/\b(?:a[.\s]*k[.\s]*[jg][.\s]*v|ak[jg]v)\b/gi, value=>{const abbreviation=value.replace(/[.\s]/g,'').toUpperCase();return bibleVersions.has(abbreviation)?abbreviation:value;});
 for(let i=0;i<segments.length;i++){
  const segment=segments[i];const group=segments.slice(i,i+4);
  if(group.length===4 && group.every((s,j)=>/^[a-z][.]?$/i.test(String(s.text||'').trim()) && (!j || Number(s.start)-Number(group[j-1].end)<=.4 && Number(s.start)>=Number(group[j-1].start)))){
   const abbreviation=group.map(s=>String(s.text).replace(/\./g,'').trim()).join('').toUpperCase();
   if(bibleVersions.has(abbreviation)){result.push({...segment,text:abbreviation+(/\.$/.test(group[3].text)?'.':''),end:group[3].end,bibleVersionNormalized:true});i+=3;continue;}
  }
  const text=normalize(segment.text);result.push({...segment,text,...(text!==segment.text?{bibleVersionNormalized:true}:{})});
 }
 return result;
}

import {captionReviewDiffers} from '../caption-comparison.mjs';
// Detect surplus long takes independently of local word alignment. An intentional
// repeated passage in the reference consumes an occurrence and must not be flagged.
export function surplusTakeIssues(operations=[]){
 const norm=w=>String(w?.norm||w?.display||w?.text||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
 const spoken=operations.filter(o=>o.spoken&&!o.spoken.recoveredFromManuscript).sort((a,b)=>a.spoken.start-b.spoken.start);
 const expected=operations.filter(o=>o.expected).map(o=>norm(o.expected));
 const tokens=spoken.map(o=>norm(o.spoken)),seen=new Map(),candidates=[];
 const same=(a,b)=>a===b || /^[a-z]+$/.test(a) && /^[a-z]+$/.test(b) && !captionReviewDiffers(a,b);
 const safeVariation=(a,b)=>/^[a-z]+$/.test(a) && /^[a-z]+$/.test(b) && ![a,b].some(w=>/^(?:no|not|never|without|cannot|cant|dont|wont)$/.test(w));
 const cardinalValues=new Map('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ').map((word,index)=>[word,index]));
 const numberValue=word=>/^\d+$/.test(word)?Number(word):cardinalValues.get(word);
 const expectedSpan=(phrase,start,n)=>{
  let spokenAt=0,expectedAt=start,changes=0;
  while(spokenAt<n&&expectedAt<expected.length){
   if(same(phrase[spokenAt],expected[expectedAt])){spokenAt++;expectedAt++;continue;}
   const nextNumber=numberValue(phrase[spokenAt+1]||'');
   if(phrase[spokenAt]==='number'&&spokenAt+1<n&&nextNumber!=null&&nextNumber===numberValue(expected[expectedAt])){spokenAt+=2;expectedAt++;continue;}
   if(n>=12&&changes<2&&safeVariation(phrase[spokenAt],expected[expectedAt])){changes++;spokenAt++;expectedAt++;continue;}
   return 0;
  }
  return spokenAt===n&&changes/n<=.1?expectedAt-start:0;
 };
 for(let i=0;i+6<=tokens.length;i++){
  const key=tokens.slice(i,i+6).join('|');if(!key.replaceAll('|',''))continue;
  const earlier=seen.get(key)||[];
  for(const j of earlier.slice(-8)){
   if(i-j<6)continue;
   let changes=0,n=6;
   while(n<256&&j+n<i&&i+n<tokens.length){
    if(same(tokens[j+n],tokens[i+n])){n++;continue;}
    if(changes<2 && safeVariation(tokens[j+n],tokens[i+n]) && j+n+2<i && i+n+2<tokens.length && same(tokens[j+n+1],tokens[i+n+1]) && same(tokens[j+n+2],tokens[i+n+2])){changes++;n++;continue;}
    break;
   }
   let left=0;
   while(left<256-n && n+left<i-j && j-left>0){
    const a=j-left-1,b=i-left-1;
    if(same(tokens[a],tokens[b])){left++;continue;}
    if(changes<2 && a>=2 && n+left+2<i-j && safeVariation(tokens[a],tokens[b]) && same(tokens[a-1],tokens[b-1]) && same(tokens[a-2],tokens[b-2])){changes++;left++;continue;}
    break;
   }
   const first=j-left,second=i-left;n+=left;
   // A repeated passage is a take only when the speaker restarts locally.
   // Do not pair the same sentence across a separate thought or paragraph.
   const interveningWords=second-first-n;
   const silence=Number(spoken[second]?.spoken?.start)-Number(spoken[first+n-1]?.spoken?.end);
   if(interveningWords<0||interveningWords>3||!Number.isFinite(silence)||silence>4)continue;
   if(changes && (n<12 || changes/n>.1))continue;
   if([first,second].every(at=>spoken.slice(at,at+n).every(o=>o.expected && same(norm(o.spoken),norm(o.expected)))))continue;
   const score=at=>spoken.slice(at,at+n).filter(o=>o.expected&&['match','near'].includes(o.type)).length;
   const referenceAt=score(first)>score(second)?first:second;
   const phrase=tokens.slice(referenceAt,referenceAt+n);let count=0;
   for(let k=0;k<expected.length;){
    const consumed=expectedSpan(phrase,k,n);
    if(consumed){count++;k+=consumed;}else k++;
   }
   if(count!==1)continue;
   // A reread normally repairs the first take; review the earlier occurrence.
   const at=first;
   candidates.push({at,n,laterAt:second});
  }
  earlier.push(i);seen.set(key,earlier);
 }
 candidates.sort((a,b)=>b.n-a.n || b.laterAt-a.laterAt);const accepted=[];
 for(const c of candidates)if(!accepted.some(a=>c.at<a.at+a.n&&c.at+c.n>a.at))accepted.push(c);
 const longIssues=accepted.map(({at,n,laterAt})=>{const words=spoken.slice(at,at+n).map(o=>o.spoken),start=Number(words[0].start),end=Number(words.at(-1).end);
  return {id:`repeat-take-${start}-${end}`,type:'repeat',segmentedRepeat:true,start,end,retainedStart:Number(spoken[laterAt].spoken.start),retainedEnd:Number(spoken[laterAt+n-1].spoken.end),spokenText:words.map(w=>w.display||w.text).join(' '),expectedText:'',reason:'重复口播：正确文案中只有一次，优先检查前一遍并保留后面完整的一遍；请试听确认',action:'review',confirmedCut:false};
 });
 // A citation can be abandoned before its verse, then restarted with a corrected
 // chapter. Compare the raw speech, not the manuscript's collapsed numeric token.
 const restarts=[];
 const digit=w=>/^[0-9]$/.test(norm(w));
 const book=w=>norm(w).replace(/^psalms$/,'psalm');
 const scriptureBooks=new Set('genesis exodus leviticus numbers deuteronomy joshua judges ruth ezra nehemiah esther job psalm proverbs ecclesiastes isaiah jeremiah lamentations ezekiel daniel hosea joel amos obadiah jonah micah nahum habakkuk zephaniah haggai zechariah malachi matthew mark luke john acts romans galatians ephesians philippians colossians titus philemon hebrews james jude revelation'.split(' '));
 for(let i=0;i<spoken.length;i++) {
  if(!scriptureBooks.has(book(spoken[i].spoken)) || spoken[i].expected || spoken[i].type!=='extra')continue;
  let j=i+1;
  while(j<spoken.length && j-i<=12 && digit(spoken[j].spoken) && !spoken[j].expected && spoken[j].type==='extra')j++;
  const earlier=spoken.slice(i+1,j);
  const later=spoken[j];
  if(earlier.length<2 || !later?.expected || book(later.spoken)!==book(spoken[i].spoken) || book(later.expected)!==book(later.spoken))continue;
  if(Number(later.spoken.start)-Number(earlier.at(-1).spoken.end)>2)continue;
  const laterDigits=[];
  for(let k=j+1;k<spoken.length && laterDigits.length<8 && digit(spoken[k].spoken);k++)laterDigits.push(norm(spoken[k].spoken));
  if(laterDigits.length<2 || norm(earlier[0].spoken)!==laterDigits[0] || norm(earlier[1].spoken)!==laterDigits[1])continue;
  if(!earlier.some(o=>/[.!?…]["'”’)]*$/.test(String(o.spoken.display||''))))continue;
  const words=spoken.slice(i,j).map(o=>o.spoken),start=Number(words[0].start),end=Number(words.at(-1).end);
  if(longIssues.some(r=>r.start<end && r.end>start))continue;
  restarts.push({id:`repeat-restart-${start}-${end}`,type:'repeat',segmentedRepeat:true,start,end,spokenText:words.map(w=>w.display||w.text).join(' '),expectedText:'',reason:'经文数字读到一半后重新开始，后面保留完整一次；请试听确认',action:'review',confirmedCut:false});
  i=j-1;
 }
 return [...longIssues,...restarts];
}

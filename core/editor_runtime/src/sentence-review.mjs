import {scriptWords} from './alignment.mjs';

function distance(a,b) {
 let row=b.map((_,i)=>i+1);row.unshift(0);
 for(let i=0;i<a.length;i++) {const next=[i+1];for(let j=0;j<b.length;j++)next.push(Math.min(next[j]+1,row[j+1]+1,row[j]+(a[i]===b[j]?0:1)));row=next;}
 return row[b.length];
}

// Candidate discovery only. Fuzzy similarity must never directly authorize a cut.
export function sentenceCandidates(script, operations) {
 const speech=(operations||[]).filter(o=>o.spoken).map(o=>o.spoken).sort((a,b)=>a.start-b.start);
 const sentences=String(script).split(/(?<=[.!?。！？])\s+|\n+/u).map(s=>s.trim()).filter(Boolean);
 return sentences.map((text,sentenceIndex)=>{
  const expected=scriptWords(text).map(w=>w.norm);const candidates=[];
  if(expected.length<5)return {sentenceIndex,text,candidates};
  for(let start=0;start<speech.length;start++) {
   if(!expected.slice(0,2).includes(speech[start].norm))continue;
   let best=null;
   for(let length=Math.max(4,expected.length-Math.max(3,Math.ceil(expected.length*.35)));length<=expected.length+Math.max(3,Math.ceil(expected.length*.35))&&start+length<=speech.length;length++) {
    const words=speech.slice(start,start+length);
    if(words.some((w,i)=>i&&w.start-words[i-1].end>2))continue;
    const score=1-distance(expected,words.map(w=>w.norm))/Math.max(length,expected.length);
    if(score>=.6&&(!best||score>best.score))best={start:words[0].start,end:words.at(-1).end,score,text:words.map(w=>w.display).join(' ')};
   }
   if(best&&!candidates.some(c=>best.start<c.end&&best.end>c.start))candidates.push(best);
  }
  return {sentenceIndex,text,candidates:candidates.sort((a,b)=>b.score-a.score).slice(0,6)};
 });
}

export function validateCutCoverage(operations, cuts) {
 const problems=[];
 for(const op of operations||[]) {
  if(!op.spoken || !op.expected || !['match','near'].includes(op.type))continue;
  const w=op.spoken;
  const overlap=cuts.reduce((n,r)=>n+Math.max(0,Math.min(w.end,r.end)-Math.max(w.start,r.start)),0);
  if(overlap<=.001)continue;
  const replacement=(operations||[]).some(other=>other!==op&&other.spoken&&other.expected?.norm===op.expected.norm&&
   other.spoken.norm===op.expected.norm&&!cuts.some(r=>r.start<other.spoken.end&&r.end>other.spoken.start));
  // A repeat's full retained sentence is validated by guardAutomaticCuts.
  const ownsRepeat=cuts.some(r=>r.source==='script-repeat'&&w.start>=r.start&&w.end<=r.end+.001);
  if(!ownsRepeat||!replacement)problems.push({type:'coverage',start:w.start,end:w.end,expectedText:op.expected.display,spokenText:w.display,reviewRequired:true,reviewReason:'删除计划触及可靠对白，缺少有效保留证据'});
 }
 return problems;
}

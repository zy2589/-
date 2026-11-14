import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
let dictionary;
function wordDictionary() {
  return dictionary ||= JSON.parse(gunzipSync(fs.readFileSync(new URL('../assets/english-chinese.json.gz', import.meta.url))));
}
export function chineseWordMeanings(text) {
  const words = String(text || '').toLowerCase().match(/[a-z]+(?:['’][a-z]+)*/g) || [];
  if (!words.length) return '';
  const entries = wordDictionary();
  return [...new Set(words)].slice(0,12).map(word => {
    let meaning = entries[word.replaceAll('’',"'")];
    if (!meaning) return `${word}：词典未收录`;
    // Entries for irregular inflections sometimes contain only a root reference.
    meaning = meaning.replace(/\b([a-z]+)的(过去式(?:和过去分词)?|过去分词|复数|现在分词)/g, (match, root, form) =>
      entries[root] ? `${entries[root].slice(0,100)}（${root} 的${form}）` : match);
    return `${word}：${meaning.slice(0,160)}`;
  }).join('\n');
}
export function dictionaryCaptionMeanings(items) {
  const brief = text => chineseWordMeanings(text).split('\n').map(line=> {
    const colon=line.indexOf('：');
    const meaning=line.slice(colon+1).replace(/\([^()]*\)|（[^（）]*）/g,'').replace(/\b(?:n|v|vi|vt|adj|adv|pl|pron|prep|conj|aux)\./g,'').trim();
    return meaning.split(/[；;,，]/)[0].trim().slice(0,24);
  }).filter(Boolean).join('；').slice(0,60);
  return items.map(item => ({id:item.id, spokenZh:brief(item.spoken), expectedZh:brief(item.expected), meaningImpact:'uncertain',meaningMode:'dictionary',meaningVersion:2}));
}

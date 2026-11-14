import { flattenCaptionWords } from './alignment/regroup.mjs';
export function limitCaptionWords(captions = [], maximum = 3) {
  return captions.flatMap(caption => {
    if (String(caption.text || '').trim().split(/\s+/).filter(Boolean).length <= maximum) return [caption];
    const original = caption.words?.length ? caption.words : flattenCaptionWords([caption]);
    const words = original.flatMap(word => {
      const tokens = String(word.display || word.text || '').trim().split(/\s+/).filter(Boolean);
      return tokens.map((display, i) => ({...word, display,
        start:Number(word.start)+(Number(word.end)-Number(word.start))*i/tokens.length,
        end:Number(word.start)+(Number(word.end)-Number(word.start))*(i+1)/tokens.length}));
    });
    const result = [];
    for (let i=0;i<words.length;i+=maximum) {
      const group=words.slice(i,i+maximum);
      result.push({...caption,id:i ? `${caption.id || 'caption'}-part-${i}` : caption.id,
        text:group.map(word=>word.display).join(' '),words:group,
        start:i ? group[0].start : caption.start,
        end:i+maximum>=words.length ? caption.end : Math.min(group.at(-1).end,words[i+maximum].start)});
    }
    return result.length ? result : [caption];
  });
}


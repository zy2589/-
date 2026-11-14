// Original implementations inspired by publicly demonstrated caption behaviours.
// No third-party fonts, template code or media are shipped. Keep import-free.
export const captionEffectOptions = [
  ['静态整句', 'none'], ['跟读变色', 'karaoke'], ['逐词显现 / Clean', 'typewriter'],
  ['单词聚焦', 'word-focus'], ['跟读底色', 'word-pill'], ['跟读下划线', 'underline'],
  ['逐词弹出', 'word-pop'], ['逐词弹跳', 'word-bounce'], ['逐词上浮', 'word-lift'],
  ['逐行跳动', 'line-pulse'], ['整句淡入', 'fade'], ['整句上移', 'rise'],
  ['左侧滑入', 'slide-left'], ['右侧滑入', 'slide-right'], ['整句放大', 'zoom'], ['呼吸缩放', 'breathe'], ['故障色偏', 'glitch'], ['轻微震动', 'shake'], ['模糊显现', 'blur-reveal'], ['两个词聚焦', 'pair-focus'],
];

export const referenceCaptionPresets = [
  ['Karaoke · 荧绿跟读', 'Opus 参考风格', { highlight: '#39ff14', animation: 'karaoke', fontWeight: 900, textCase: 'upper', stroke: 3 }],
  ['Gameplay · 漫画黄字', 'Opus 参考风格', { fontFamily: 'Impact', fontSize: 64, highlight: '#fff000', animation: 'word-pop', textCase: 'upper', stroke: 4 }],
  ['Beasty · 粗体弹出', 'Opus 参考风格', { fontFamily: 'Arial Black', fontSize: 64, highlight: '#ffe600', animation: 'word-bounce', textCase: 'upper', stroke: 4 }],
  ['Deep Diver · 白底阅读', 'Opus 参考风格', { color: '#151515', highlight: '#151515', futureColor: '#909090', backgroundEnabled: true, background: '#ffffff', backgroundOpacity: .94, radius: 9, stroke: 0, fontWeight: 600, animation: 'karaoke' }],
  ['Youshaei · 绿字强调', 'Opus 参考风格', { color: '#c9ffe1', highlight: '#37ef8a', animation: 'word-lift', textCase: 'upper', stroke: 2, shadow: 3 }],
  ['Pod P · 紫色聚焦', 'Opus 参考风格', { fontFamily: 'Impact', color: '#ed63d4', highlight: '#ed63d4', animation: 'word-focus', textCase: 'upper', stroke: 2 }],
  ['Mozi · 双行荧绿', 'Opus 参考风格', { fontFamily: 'Arial Black', highlight: '#4bff25', animation: 'word-pop', textCase: 'upper', stroke: 4, lineHeight: 1.12 }],
  ['Popline · 红色跟读', 'Opus 参考风格', { highlight: '#ff555d', animation: 'karaoke', textCase: 'upper', stroke: 2 }],
  ['Simple · 单词白字', 'Opus 参考风格', { fontFamily: 'Impact', animation: 'word-focus', highlightEnabled: false, stroke: 3, textCase: 'upper' }],
  ['Think Media · 斜体绿字', 'Opus 参考风格', { fontFamily: 'Arial', fontItalic: true, highlight: '#56ff42', animation: 'typewriter', textCase: 'upper', stroke: 3 }],
  ['Classic · 经典整句', 'Descript 参考风格', { animation: 'none', highlightEnabled: false, fontWeight: 600, stroke: 0, backgroundEnabled: true, background: '#101318', backgroundOpacity: .8, radius: 6 }],
  ['Clean · 逐词显现', 'Descript 参考风格', { animation: 'typewriter', highlightEnabled: false, stroke: 1.5, fontWeight: 700 }],
  ['Karaoke · 蓝色跟读底板', 'Descript 参考风格', { animation: 'word-pill', highlight: '#5264f5', activeTextColor: '#ffffff', stroke: 0, fontWeight: 700 }],
  ['Fancy · 三态变色', 'Descript 参考风格', { animation: 'karaoke', futureColor: '#999eaa', pastColor: '#ffffff', highlight: '#ffe14c', stroke: 0, shadow: 4 }],
  ['Focus · 单词聚焦', 'Descript 参考风格', { animation: 'word-focus', highlight: '#a8d6ff', fontSize: 68, stroke: 0, shadow: 4 }],
  ['Marker · 跟读下划线', 'Descript 参考风格', { animation: 'underline', highlight: '#71d5ff', stroke: 0, shadow: 3 }],
].map(([name, category, style]) => ({
  name, category,
  style: { fontFamily: 'Arial', fontSize: 58, fontWeight: 800, color: '#ffffff',
    stroke: 2, strokeColor: '#111111', shadow: 0, backgroundEnabled: false,
    highlightEnabled: true, highlight: '#ffe14c', animationDuration: .28,
    futureColor: '', pastColor: '', activeTextColor: '#ffffff', captionLines: 2, autoFitCaption: true,
    backgroundWidth: 18, backgroundHeight: 10, radius: 10, ...style },
}));

function unit(value) { return Math.max(0, Math.min(1, value)); }
function duration(style) { return Math.max(.08, Math.min(1.5, Number(style.animationDuration) || .28)); }

export function captionGroupMotion(style, time, start) {
  const p = unit((time - start) / duration(style)), eased = 1 - Math.pow(1-p, 3);
  const r = { opacity: 1, scale: 1, x: 0, y: 0, rotation: Number(style.tilt || 0) };
  if (style.animation === 'breathe') r.scale = 1 + .045 * Math.sin(Math.max(0,time-start)*Math.PI*2/1.2);
  if (style.animation === 'shake') {r.x=.025*Math.sin((time-start)*71);r.y=.025*Math.cos((time-start)*53);}
  const mode = style.animation;
  if (['fade','rise','slide-left','slide-right','zoom'].includes(mode)) r.opacity = p;
  if (mode === 'rise') r.y = (1-eased) * .35;
  if (mode === 'slide-left') r.x = -(1-eased) * .7;
  if (mode === 'slide-right') r.x = (1-eased) * .7;
  if (mode === 'zoom') r.scale = .72 + .28 * eased;
  return r;
}

export function captionWordEffect(style, word, time) {
  const active = time >= word.start && time < word.end;
  const past = time >= word.end, future = time < word.start;
  const mode = style.animation || 'karaoke';
  const highlight = style.highlightEnabled !== false && mode !== 'none';
  const p = unit((time - word.start) / duration(style));
  const r = {
    blur: mode === 'blur-reveal' ? (1-p)*.18 : 0,
    visible: !style.captionHidden && !(mode === 'typewriter' && future) && !(mode === 'word-focus' && !active),
    color: active && highlight ? (style.highlight || '#ffe14c') :
      past ? (style.pastColor || style.color || '#ffffff') : (style.futureColor || style.color || '#ffffff'),
    scale: 1, y: 0, active, pill: active && highlight && (mode === 'word-pill' || style.wordBox === true),
    underline: active && highlight && mode === 'underline',
  };
  if (r.pill) r.color = style.activeTextColor || '#ffffff';
  if (active && mode === 'word-pop') r.scale = 1 + .22 * Math.sin(Math.PI * p);
  if (active && mode === 'word-bounce') r.y = -.25 * Math.sin(Math.PI * p);
  if (active && mode === 'word-lift') r.y = -.14;
  return r;
}

// Export samples the same absolute timeline clock as preview. Static spans collapse
// to a single image; only actual motion is sampled at the selected video frame rate.
export function captionEffectSegments(caption, style = {}, fps = 30) {
  fps = Math.max(1, Math.min(60, Number(fps) || 30));
  const start = Number(caption.start || 0), end = Number(caption.end || 0);
  if (!(end > start)) return [];
  const first = Math.ceil((start - 1e-8) * fps), last = Math.ceil((end - 1e-8) * fps);
  if (last <= first) return [];
  const mode = style.animation || 'karaoke', words = caption.words || [];
  const frames = new Set([first,last]);
  const add = time => { const f = Math.ceil((time - 1e-8) * fps); if (f > first && f < last) frames.add(f); };
  if (mode !== 'none') for (const w of words) { add(Number(w.start)); add(Number(w.end)); }
  const spans = [];
  if (['breathe','glitch','shake'].includes(mode)) spans.push([start,end]);
  if (['fade','rise','slide-left','slide-right','zoom'].includes(mode)) spans.push([start,start+duration(style)]);
  if (['word-pop','word-bounce','blur-reveal'].includes(mode)) for (const w of words) spans.push([Number(w.start),Math.min(Number(w.end),Number(w.start)+duration(style))]);
  for (const [a,b] of spans) for(let f = Math.max(first,Math.floor(a*fps)); f <= Math.min(last,Math.ceil(b*fps)); f++) frames.add(f);
  const sorted = [...frames].sort((a,b)=>a-b);
  return sorted.slice(0,-1).map((f,i)=>({start:f/fps,end:sorted[i+1]/fps}));
}


// Screenshot catalogue: independent approximations; font names are labels, not bundled fonts.
export const screenshotCaptionPresets = [
  {
    "name": "没有字幕",
    "category": "Opus · 截图样式",
    "style": {
      "captionHidden": true,
      "animation": "none"
    }
  },
  {
    "name": "卡拉OK",
    "category": "Opus · 截图样式",
    "style": {
      "textCase": "upper",
      "stroke": 3,
      "highlight": "#ffffff"
    }
  },
  {
    "name": "野兽",
    "category": "Opus · 截图样式",
    "style": {
      "fontItalic": true,
      "textCase": "upper",
      "animation": "word-pop",
      "highlight": "#ffffff",
      "fontSize": 48
    }
  },
  {
    "name": "深潜者",
    "category": "Opus · 截图样式",
    "style": {
      "backgroundEnabled": true,
      "background": "#eeeeee",
      "backgroundOpacity": 0.94,
      "color": "#222222",
      "highlight": "#111111",
      "futureColor": "#bbbbbb",
      "stroke": 0
    }
  },
  {
    "name": "友社莱",
    "category": "Opus · 截图样式",
    "style": {
      "textCase": "upper",
      "highlight": "#51e4c1",
      "color": "#858585",
      "fontWeight": 600,
      "stroke": 1
    }
  },
  {
    "name": "Pod P",
    "category": "Opus · 截图样式",
    "style": {
      "fontFamily": "Impact",
      "highlight": "#ff42d7",
      "color": "#ff42d7",
      "animation": "pair-focus",
      "textCase": "upper"
    }
  },
  {
    "name": "墨子",
    "category": "Opus · 截图样式",
    "style": {
      "fontFamily": "Arial Black",
      "highlight": "#17ff25",
      "textCase": "upper",
      "stroke": 4
    }
  },
  {
    "name": "Popline",
    "category": "Opus · 截图样式",
    "style": {
      "highlight": "#8659e9",
      "wordBox": true,
      "textCase": "upper",
      "stroke": 3
    }
  },
  {
    "name": "无限故障",
    "category": "Opus · 截图样式",
    "style": {
      "color": "#ffca00",
      "highlight": "#ff9b00",
      "chromatic": 3,
      "animation": "glitch",
      "stroke": 0
    }
  },
  {
    "name": "无缝弹跳",
    "category": "Opus · 截图样式",
    "style": {
      "stroke": 7,
      "strokeColor": "#307944",
      "highlight": "#dfff00",
      "animation": "word-bounce"
    }
  },
  {
    "name": "婴儿地震",
    "category": "Opus · 截图样式",
    "style": {
      "fontFamily": "Georgia",
      "highlight": "#ffd543",
      "animation": "shake",
      "stroke": 0
    }
  },
  {
    "name": "模糊开关",
    "category": "Opus · 截图样式",
    "style": {
      "fontSize": 46,
      "fontWeight": 500,
      "textCase": "upper",
      "highlight": "#49f0ed",
      "animation": "blur-reveal",
      "stroke": 0
    }
  },
  {
    "name": "高光盒",
    "category": "Opus · 截图样式",
    "style": {
      "fontFamily": "Impact",
      "stroke": 3,
      "strokeColor": "#f27bba",
      "highlight": "#aaa9ff",
      "activeTextColor": "#ec299c",
      "wordBox": true
    }
  },
  {
    "name": "简单的",
    "category": "Opus · 截图样式",
    "style": {
      "fontFamily": "Impact",
      "textCase": "upper",
      "highlightEnabled": false,
      "animation": "none",
      "stroke": 3
    }
  },
  {
    "name": "Think Media",
    "category": "Opus · 截图样式",
    "style": {
      "fontFamily": "Impact",
      "textCase": "upper",
      "highlight": "#f6ff00",
      "stroke": 3
    }
  },
  {
    "name": "重点",
    "category": "Opus · 截图样式",
    "style": {
      "fontFamily": "Georgia",
      "textCase": "upper",
      "highlight": "#e9ff00",
      "stroke": 2
    }
  },
  {
    "name": "模糊",
    "category": "Opus · 截图样式",
    "style": {
      "fontFamily": "Georgia",
      "highlight": "#e99ced",
      "animation": "blur-reveal",
      "stroke": 2
    }
  },
  {
    "name": "背景幕",
    "category": "Opus · 截图样式",
    "style": {
      "fontFamily": "Georgia",
      "fontItalic": true,
      "color": "#efff28",
      "highlight": "#efff28",
      "backgroundEnabled": true,
      "background": "#252525",
      "backgroundOpacity": 0.8,
      "animation": "none",
      "stroke": 0,
      "radius": 0
    }
  },
  {
    "name": "软着陆",
    "category": "Opus · 截图样式",
    "style": {
      "highlight": "#51e7ec",
      "animation": "word-lift",
      "stroke": 0,
      "shadow": 4
    }
  },
  {
    "name": "婴儿学步",
    "category": "Opus · 截图样式",
    "style": {
      "highlight": "#ffffff",
      "strokeColor": "#f42ba2",
      "stroke": 3,
      "animation": "word-bounce"
    }
  },
  {
    "name": "生长",
    "category": "Opus · 截图样式",
    "style": {
      "highlight": "#ffffff",
      "strokeColor": "#9000ff",
      "stroke": 4,
      "animation": "word-pop"
    }
  },
  {
    "name": "呼吸",
    "category": "Opus · 截图样式",
    "style": {
      "fontFamily": "Arial Black",
      "highlight": "#19ff28",
      "stroke": 4,
      "animation": "breathe",
      "tilt": 5
    }
  },
  {
    "name": "布顿",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "animation": "word-pill",
      "highlight": "#ff3d45",
      "wordBoxRadius": 0
    }
  },
  {
    "name": "瑰索",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 3,
      "highlight": "#ed7938"
    }
  },
  {
    "name": "档案",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontWeight": 500,
      "textCase": "upper",
      "color": "#fff000",
      "highlight": "#fff000",
      "animation": "word-focus"
    }
  },
  {
    "name": "年轻构缀体",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 2,
      "highlightEnabled": false,
      "animation": "none",
      "fontWeight": 500
    }
  },
  {
    "name": "Plus Jakarta Sans",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "wordBox": true,
      "highlight": "#ffffff",
      "activeTextColor": "#111111",
      "wordBoxRadius": 0
    }
  },
  {
    "name": "贝斯利",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "backgroundEnabled": true,
      "background": "#ffffff",
      "backgroundOpacity": 0.22,
      "animation": "none",
      "radius": 0
    }
  },
  {
    "name": "机器人单",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontFamily": "Consolas",
      "wordSpacing": 12,
      "highlight": "#dcff91"
    }
  },
  {
    "name": "快递员 Prime",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontFamily": "Courier New",
      "color": "#ffed60",
      "highlightEnabled": false,
      "animation": "none"
    }
  },
  {
    "name": "什里克汉德",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "highlight": "#d6fa72",
      "shadow": 8,
      "shadowDistance": 2,
      "shadowBlur": 1
    }
  },
  {
    "name": "自由富兰克林",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "wordBox": true,
      "highlight": "#ffb181",
      "activeTextColor": "#a9340a",
      "wordBoxRadius": 0
    }
  },
  {
    "name": "宽阔的肩膀",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontFamily": "Arial Black",
      "textCase": "upper",
      "highlight": "#dfb3fa",
      "shadow": 9,
      "shadowDistance": 3,
      "shadowBlur": 0
    }
  },
  {
    "name": "Gasoek One",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontFamily": "Arial Black",
      "highlight": "#ff6176",
      "shadow": 9,
      "shadowDistance": 2,
      "shadowBlur": 0
    }
  },
  {
    "name": "斯莱基",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontWeight": 400,
      "color": "#efff30",
      "highlight": "#efff30",
      "animation": "word-focus"
    }
  },
  {
    "name": "全套服装",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "animation": "word-focus",
      "wordBox": true,
      "highlight": "#c5c0ff",
      "activeTextColor": "#6a5aff",
      "textCase": "upper",
      "tilt": -7,
      "wordBoxRadius": 4
    }
  },
  {
    "name": "迪纳普",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "animation": "none",
      "highlightEnabled": false,
      "glow": 5,
      "glowColor": "#ffffff"
    }
  },
  {
    "name": "弗雷多卡",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "animation": "word-focus",
      "highlight": "#ffc8ff",
      "glow": 7,
      "glowColor": "#fa91ff"
    }
  },
  {
    "name": "丝网印刷",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontFamily": "Impact",
      "textCase": "upper",
      "animation": "word-focus",
      "highlight": "#111111",
      "chromatic": 3
    }
  },
  {
    "name": "太空单",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontFamily": "Consolas",
      "color": "#24ff26",
      "highlightEnabled": false,
      "animation": "none",
      "backgroundEnabled": true,
      "background": "#000000",
      "backgroundOpacity": 1,
      "radius": 0
    }
  },
  {
    "name": "打字机",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontWeight": 500,
      "wordBox": true,
      "highlight": "#000000",
      "wordBoxRadius": 14
    }
  },
  {
    "name": "卡拉OK经典",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "wordBox": true,
      "highlight": "#00b7f6",
      "wordBoxRadius": 2
    }
  },
  {
    "name": "粗斜体：绿色",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 5,
      "fontFamily": "Arial Black",
      "fontItalic": true,
      "highlight": "#04fc28"
    }
  },
  {
    "name": "影响：黄色",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 4,
      "fontFamily": "Impact",
      "highlight": "#ffe01b"
    }
  },
  {
    "name": "现代黄色轮廓",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 4,
      "color": "#ffd819",
      "highlightEnabled": false,
      "animation": "none"
    }
  },
  {
    "name": "经典的",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontWeight": 500,
      "animation": "none",
      "highlightEnabled": false
    }
  },
  {
    "name": "粗体：两个词",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "animation": "pair-focus",
      "highlightEnabled": false,
      "shadow": 8,
      "shadowBlur": 9
    }
  },
  {
    "name": "粗体：黄色高亮",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "textCase": "upper",
      "highlight": "#ffe22d",
      "shadow": 8,
      "shadowBlur": 9
    }
  },
  {
    "name": "清理：段落",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "animation": "typewriter",
      "highlightEnabled": false,
      "fontWeight": 500
    }
  },
  {
    "name": "卡拉OK：一个词",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "animation": "word-focus",
      "wordBox": true,
      "highlight": "#00b7f6",
      "wordBoxRadius": 2
    }
  },
  {
    "name": "卡拉OK：歪斜",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "textCase": "upper",
      "wordBox": true,
      "highlight": "#00b7f6",
      "wordBoxRadius": 0,
      "tilt": -6,
      "shadow": 5,
      "shadowBlur": 7
    }
  },
  {
    "name": "现代黄",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 5,
      "highlight": "#f4ce18"
    }
  },
  {
    "name": "粗体：白色",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 4,
      "highlight": "#ffffff",
      "futureColor": "#bfbfbf"
    }
  },
  {
    "name": "单核细胞增多症",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontFamily": "Consolas",
      "wordSpacing": 12,
      "highlight": "#c080ff"
    }
  },
  {
    "name": "轨道器",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "fontWeight": 500,
      "animation": "none",
      "highlightEnabled": false
    }
  },
  {
    "name": "粗体：倾斜",
    "category": "Descript · 截图样式",
    "style": {
      "stroke": 0,
      "textCase": "upper",
      "tilt": 5,
      "animation": "none",
      "highlightEnabled": false,
      "shadow": 8,
      "shadowBlur": 9
    }
  }
].map(p=>({...p,style:{fontFamily:'Arial',fontSize:58,fontWeight:800,color:'#ffffff',stroke:2,strokeColor:'#000000',shadow:0,shadowBlur:6,shadowOpacity:.8,shadowDistance:0,backgroundEnabled:false,highlightEnabled:true,highlight:'#ffe14c',animation:'karaoke',animationDuration:.28,futureColor:'',pastColor:'',activeTextColor:'#ffffff',captionLines:2,autoFitCaption:true,backgroundWidth:14,backgroundHeight:8,radius:6,tilt:0,chromatic:0,wordBox:false,wordBoxRadius:6,captionHidden:false,glow:0,...p.style}}));

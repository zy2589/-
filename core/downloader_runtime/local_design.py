from color_picker import askcolor
"""Editable local title templates and transparent PNG rendering."""
import json
import copy
import difflib
from datetime import datetime
import re
import unicodedata
import sys
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from PIL import Image, ImageDraw, ImageFont, ImageTk, ImageFilter
from desktop_ui import PALETTES, apply_appearance, bind_scale_wheel

ORANGE = '#e15f35'
FONT_DIR = Path('C:/Windows/Fonts')
AUTO_TITLE_SINGLE_LINE_MAX_WIDTH = 650
AUTO_TITLE_MAX_WIDTH = 900


def spacing_value(value):
    return 1.2 if str(value) in ('自动','auto') else float(value)


def system_fonts():
    import winreg
    result={}
    for hive,subkey in [(winreg.HKEY_LOCAL_MACHINE,r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'),(winreg.HKEY_CURRENT_USER,r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts')]:
        try:
            with winreg.OpenKey(hive,subkey) as key:
                for index in range(winreg.QueryInfoKey(key)[1]):
                    name,value,_=winreg.EnumValue(key,index)
                    path=Path(value)
                    if not path.is_absolute():path=FONT_DIR/path
                    if path.is_file() and path.suffix.lower() in ('.ttf','.otf','.ttc'):
                        result[name.removesuffix(' (TrueType)')]=str(path)
        except OSError:pass
    bundled=Path(__file__).resolve().parent/'fonts'
    anton=bundled/'Anton-Regular.ttf'
    if anton.is_file():result['Anton']=str(anton)
    regular=bundled/'EBGaramond-Variable.ttf'
    italic=bundled/'EBGaramond-Italic-Variable.ttf'
    if regular.is_file():
        result['EB Garamond']=str(regular)
        result['EB Garamond Bold']=str(regular)
    if italic.is_file():
        result['EB Garamond Italic']=str(italic)
        result['EB Garamond Bold Italic']=str(italic)
    return dict(sorted(result.items()))


def normalize_manual_title_lines(title, lines):
    """Validate manual line breaks while keeping the title's words unchanged."""
    translate = str.maketrans({'“':'"','”':'"','‘':"'",'’':"'",'—':'-','–':'-'})
    normalize = lambda value: unicodedata.normalize('NFKC', str(value)).translate(translate)
    normalized_title = ' '.join(normalize(title).split())
    cleaned = [' '.join(normalize(line).split()) for line in lines]
    if not cleaned or any(not line for line in cleaned):
        raise ValueError('标题分行不能为空。')
    if len(cleaned) > 4:
        raise ValueError('标题最多手动分成 4 行。')
    if ' '.join(cleaned) != normalized_title:
        raise ValueError('手动分行只能调整换行，文字必须与“视频名称”完全一致。')
    return cleaned


def replace_title(template, title, language=None):
    source_title=str(title)
    title = unicodedata.normalize('NFKC',source_title).translate(str.maketrans({'“':'"','”':'"','‘':"'",'’':"'",'—':'-','–':'-'}))
    design = copy.deepcopy(template)
    if language:
        design['template_language']=language
    original = design.get('lines') or [{'size':52,'bold':True}]
    # The saved selection formatting belongs to the sample title. Replacement
    # titles inherit that style, so use it while measuring and wrapping too.
    inherited={}
    for style in design.get('custom_text_styles',{}).values():
        inherited.update({key:value for key,value in style.items() if key in ('size','bold')})
    # Measure with the same per-line typography that render() will use. The
    # old code measured every candidate line with line 1's size, which could
    # choose a different wrap (and therefore a visually smaller title) than
    # the saved template preview.
    def measure_line(value, line_index):
        spec=original[min(line_index,len(original)-1)]
        size=inherited.get('size',spec.get('size',52))
        bold=inherited.get('bold',spec.get('bold',True))
        return font(size,bold,design.get('font_path')).getlength(value)
    requested = {'单行':1,'两行':2,'三行':3,'四行':4}.get(design.get('layout','自动'),1)
    # A row's selected line count is a minimum. If its saved font makes that
    # layout too wide, continue to the next line count up to four.
    exact_layout=bool(design.get('layout_exact'))
    manual_lines=design.get('manual_title_lines')
    if manual_lines is not None:
        values=normalize_manual_title_lines(source_title,manual_lines)
    else:
        active_language=language or design.get('template_language','en')
        values = fit_title_lines(title,requested,lambda value:measure_line(value,0),language=active_language)
        if exact_layout and len(values)>requested:
            values=balanced_lines(title,requested,lambda value:measure_line(value,0),language=active_language)
    colored=title_line_runs(values,language or design.get('template_language','en'))
    design['lines']=[dict(original[min(i,len(original)-1)],**inherited,runs=colored[i]) for i,value in enumerate(values)]
    if inherited:
        for line in design['lines']:
            line['runs']=[dict(run,**inherited) for run in line['runs']]
    # A single unusually long word can still exceed the available width after
    # all four lines are used. Reduce that line's base size to keep the PNG
    # renderable and visually inside its plate.
    for index,(line,value) in enumerate(zip(design['lines'],values)):
        width=measure_line(value,index)
        if width>AUTO_TITLE_MAX_WIDTH:
            effective_size=inherited.get('size',line.get('size',52))
            effective_bold=inherited.get('bold',line.get('bold',True))
            adjusted=max(30,int(effective_size*AUTO_TITLE_MAX_WIDTH/width))
            while adjusted>30 and font(adjusted,effective_bold,design.get('font_path')).getlength(value)>AUTO_TITLE_MAX_WIDTH:
                adjusted-=1
            line['size']=adjusted
            for run in line['runs']:
                if 'size' in run:run['size']=adjusted
    for line in design['lines']:
        for word,color in design.get('custom_colors',{}).items():
            rewritten=[]
            for run in line['runs']:
                parts=re.split('('+re.escape(word)+')',run['text'],flags=re.I)
                rewritten.extend({'text':part,'color':color if part.casefold()==word.casefold() else run['color']} for part in parts if part)
            line['runs']=rewritten
    # Per-row title formatting uses source character ranges so the user can
    # color a word or even a single letter without changing the task text.
    # Map those ranges through Unicode normalization and line wrapping, then
    # keep the selected colors explicit even when the dark template remaps its
    # automatic keyword colors.
    ranges=design.get('custom_text_ranges') or []
    if ranges:
        normalized_colors=[None]*len(title)
        matcher=difflib.SequenceMatcher(a=source_title,b=title,autojunk=False)
        for item in ranges:
            try:start,end,color=int(item['start']),int(item['end']),str(item['color'])
            except (KeyError,TypeError,ValueError):continue
            if not re.fullmatch(r'#[0-9a-fA-F]{6}',color):continue
            for old_start,new_start,length in matcher.get_matching_blocks():
                left=max(start,old_start);right=min(end,old_start+length)
                for offset in range(left,right):
                    mapped=new_start+offset-old_start
                    if 0<=mapped<len(normalized_colors):normalized_colors[mapped]=color.lower()
        compact=[];normalized_to_compact={};space_pending=False
        for source_index,char in enumerate(title):
            if char.isspace():
                if compact and not space_pending:
                    normalized_to_compact[source_index]=len(compact)
                    compact.append(' ')
                elif compact:
                    normalized_to_compact[source_index]=len(compact)-1
                space_pending=True
            else:
                normalized_to_compact[source_index]=len(compact)
                compact.append(char);space_pending=False
        compact_title=''.join(compact).strip()
        compact_colors=[None]*len(compact_title)
        for source_index,color in enumerate(normalized_colors):
            target=normalized_to_compact.get(source_index)
            if color and target is not None and 0<=target<len(compact_colors):compact_colors[target]=color
        cursor=0
        for line in design['lines']:
            value=''.join(run['text'] for run in line['runs'])
            line_start=compact_title.find(value,cursor)
            if line_start<0:
                line_start=compact_title.find(value)
            if line_start<0:continue
            cursor=line_start+len(value)
            rewritten=[];char_offset=0
            for run in line['runs']:
                for offset,char in enumerate(run['text']):
                    custom=compact_colors[line_start+char_offset+offset] if line_start+char_offset+offset<len(compact_colors) else None
                    spec={key:value for key,value in run.items() if key!='text'}
                    if custom:
                        spec['color']=custom;spec['user_color']=True
                    previous=rewritten[-1] if rewritten else None
                    if previous and all(previous.get(key)==spec.get(key) for key in set(previous)|set(spec) if key!='text'):
                        previous['text']+=char
                    else:rewritten.append({'text':char,**spec})
                char_offset+=len(run['text'])
            line['runs']=rewritten
    return design


def preset_path(directory, value):
    if not value or value in ('.','..') or re.search(r'[<>:"/\\|?*]',value):
        raise ValueError('预设名称包含不允许的字符')
    return Path(directory) / (f'page-{value}.json' if value.isdigit() else f'{value}.json')


@lru_cache(maxsize=256)
def font_variant(path,bold):
    choices=system_fonts()
    name=next((name for name,value in choices.items() if value==str(path)),None)
    if not name:return str(path)
    family=name.replace(' Bold','').replace(' Regular','')
    return choices.get(family+(' Bold' if bold else ''),str(path))


def font(size, bold=True, path=None, sans=False):
    target = Path(path) if path else FONT_DIR / ('arialbd.ttf' if sans and bold else 'arial.ttf' if sans else 'timesbd.ttf' if bold else 'times.ttf')
    if path and not target.is_file():
        bundled = Path(__file__).resolve().parent / 'fonts'
        fallback = bundled / target.name
        if fallback.is_file():
            target = fallback
    face=ImageFont.truetype(font_variant(str(target),bold),int(size))
    if target.name.startswith('EBGaramond-'):
        face.set_variation_by_axes([700 if bold else 400])
    return face


def balanced_lines(text, count, measure, language='en'):
    raw_words=text.split()
    words=[];index=0
    while index<len(raw_words):
        word=raw_words[index]
        if words and re.fullmatch(r'[-\u2013\u2014]+',word):
            words[-1]+=' '+word
            index+=1
            continue
        phrase=re.match(KEYWORD_PATTERN,' '.join(raw_words[index:]),re.I)
        if phrase and ' ' in phrase.group():
            length=len(phrase.group().split())
            words.append(' '.join(raw_words[index:index+length]));index+=length;continue
        if re.fullmatch(r'[\"\'(]*Holy',word,re.I) and index+1<len(raw_words) and re.match(r'Spirit\b',raw_words[index+1],re.I):
            words.append(word+' '+raw_words[index+1]);index+=2
        else:words.append(word);index+=1
    if not words:
        return ['']
    count = min(count, len(words))
    # Dynamic programming balances real glyph widths, rather than word counts.
    target = measure(' '.join(words)) / count
    cache = {}
    def solve(start, remaining):
        key = (start, remaining)
        if key in cache:
            return cache[key]
        if remaining == 1:
            line = ' '.join(words[start:])
            return ((measure(line) - target) ** 2, [line])
        candidates = []
        for end in range(start + 1, len(words) - remaining + 2):
            line = ' '.join(words[start:end])
            score, rest = solve(end, remaining - 1)
            penalty=0
            if words[end-1].lower().strip(',:;') in ('a','an','the','of','to','and','or','with','in','for'):
                penalty+=target**2*.35
            if len(line.split())==1 and len(raw_words)>count*2:
                penalty+=target**2*.5
            candidates.append((score + (measure(line) - target) ** 2+penalty, [line, *rest]))
        result = min(candidates, key=lambda item: item[0])
        cache[key] = result
        return result
    return solve(0, count)[1]


def fit_title_lines(text, minimum, measure, max_width=AUTO_TITLE_MAX_WIDTH, language='en'):
    """Keep short titles to one line and allow wider lines when wrapping longer titles."""
    words=text.split()
    if not words:return ['']
    minimum=max(1,min(4,int(minimum)))
    for count in range(minimum,5):
        lines=balanced_lines(text,count,measure,language)
        line_width_limit=AUTO_TITLE_SINGLE_LINE_MAX_WIDTH if count==1 else max_width
        if max(measure(line) for line in lines)<=line_width_limit:
            return lines
    return balanced_lines(text,4,measure,language)


def render(design, green_preview=False, output_size='1080x1920'):
    """Render at double scale before reducing so letters and plate edges stay smooth."""
    output_dimensions={'1080x1920':(1080,1920),'1440x2560':(1440,2560)}.get(output_size,output_size)
    scale=2
    dark=design.get('theme')=='黑天'
    normal='#ffffff' if dark else '#000000';highlight='#ffd43b' if dark else ORANGE
    # Template 1's day/night selection owns the plate color. Older saved
    # template styles may carry a black plate from the former single-theme
    # renderer, so never let that stale color override the selected theme.
    background='#000000' if dark else '#ffffff'
    image=Image.new('RGBA',(1080*scale,1920*scale),'#1c3e30' if green_preview else (0,0,0,0))
    pad=int(design.get('padding',16))*scale;radius=max(0,int(design.get('radius',20))*scale)

    def paint(rows,start,footer=False):
        y=start;blocks=[];letters=[]
        for runs,size,bold in rows:
            chunks=[]
            for run in runs:
                face=font(round(run.get('size',size)*scale),run.get('bold',bold),design.get('footer_font_path' if footer else 'font_path'),sans=footer)
                chunks.append((run,face))
            total=sum(face.getlength(run['text']) for run,face in chunks)
            if total>(1000*scale if footer else 980*scale):
                if not footer:raise ValueError('某行文字超出画面, 请缩小字号或增加换行')
                ratio=1000*scale/total
                chunks=[(run,font(max(12*scale,round(face.size*ratio)),run.get('bold',bold),design.get('footer_font_path'),sans=True)) for run,face in chunks]
                total=sum(face.getlength(run['text']) for run,face in chunks)
            x=(1080*scale-total)/2;cursor=x;bounds=[]
            for run,face in chunks:
                box=face.getbbox(run['text'],anchor='ls')
                if run['text'].strip():bounds.append((cursor+box[0],box[1],cursor+box[2],box[3]))
                cursor+=face.getlength(run['text'])
            if not bounds:continue
            min_y=min(box[1] for box in bounds);max_y=max(box[3] for box in bounds)
            height=max_y-min_y;baseline=y-min_y
            correction=540*scale-(min(box[0] for box in bounds)+max(box[2] for box in bounds))/2
            x+=correction
            left=min(box[0] for box in bounds)+correction-pad;right=max(box[2] for box in bounds)+correction+pad
            if left<0 or right>1080*scale:raise ValueError('文字底板超出画面, 请调整字号或边距')
            block=(left,y-pad,right,y+height+pad)
            if block[3]>(1920*scale if footer else 1400*scale):raise ValueError('文字超出所在区域, 请调整位置或字号')
            blocks.append(block);cursor=x
            for run,face in chunks:
                color=run.get('color',normal)
                if dark and not run.get('user_color'):
                    color=highlight if color.lower() in (ORANGE,'#ffd43b') else normal
                letters.append((cursor,baseline,run['text'],face,color))
                cursor+=face.getlength(run['text'])
            multiplier=spacing_value(design.get('footer_line_spacing',design.get('line_spacing',1)) if footer else design.get('line_spacing',1))
            y+=height*multiplier+(22*scale if footer else pad*2+design.get('gap',0)*scale)
        mask=Image.new('L',image.size);painter=ImageDraw.Draw(mask)
        for i,block in enumerate(blocks):
            painter.rectangle(block,fill=255)
            if i and blocks[i-1][3]<block[1]:
                previous=blocks[i-1];painter.rectangle((max(previous[0],block[0]),previous[3],min(previous[2],block[2]),block[1]),fill=255)
        if radius:mask=mask.filter(ImageFilter.GaussianBlur(radius/2)).point(lambda v:255 if v>=128 else 0)
        if design.get('show_plates', True):
            image.paste(Image.new('RGBA',image.size,background),(0,0),mask)
        draw=ImageDraw.Draw(image)
        for x,baseline,text,face,color in letters:draw.text((x,baseline),text,font=face,fill=color,anchor='ls')

    paint([(line['runs'],line.get('size',52),line.get('bold',True)) for line in design['lines']],design.get('top',850)*scale+pad)
    rows=[]
    footer_roles=design.get('footer_roles',[])
    footer_auto_highlights=design.get('footer_auto_highlights',{})
    for index,text in enumerate(design.get('footer','').splitlines()):
        if not text.strip():continue
        # Keep logical font sizes here; paint() applies the 2x supersampling once.
        role=footer_roles[index] if index<len(footer_roles) else ''
        size=design.get('phone_size',68) if role=='phone' or re.search(r'\d{3}',text) else design.get('link_size',48) if role=='cta' or text.strip()=='LINK IN MY BIO' else design.get('footer_size',38)
        try:
            auto_spans=list(footer_auto_highlights.get(str(index),[]))
        except AttributeError:
            auto_spans=[]
        auto_spans.extend(salient_title_spans(text,design.get('template_language','en')))
        runs=[]
        for j,char in enumerate(text):
            color=highlight if role=='phone' or role=='cta' or text.startswith('+') or text.strip()=='LINK IN MY BIO' or any(match.start()<=j<match.end() for match in re.finditer('FREE',text,re.IGNORECASE)) or any(
                isinstance(span,(list,tuple)) and len(span)>=2 and int(span[0])<=j<int(span[1])
                for span in auto_spans) else normal
            spec={'color':color}
            for style in design.get('footer_styles',[]):
                if style['line']==index and (style.get('whole_line') or style['start']<=j<style['end']):
                    spec.update({k:v for k,v in style.items() if k in ('size','bold','color')})
            if runs and all(runs[-1].get(k)==spec.get(k) for k in ('size','bold','color')):runs[-1]['text']+=char
            else:runs.append(dict(text=char,**spec))
        rows.append((runs,size,True))
    paint(rows,1425*scale,True)
    image=image.resize(tuple(map(int,output_dimensions)),Image.Resampling.LANCZOS)
    return image


# These are the equivalents of God, Jesus, Lord, and Holy Spirit in every language
# offered by the downloader.  The selected row language controls matching.
RELIGIOUS_TERMS = {
    'en': (r"GOD(?:['’]s?)?", r"JESUS(?:['’]s?)?", r"HOLY\s+SPIRIT(?:['’]s?)?"),
    'fr': ('DIEU', 'JÉSUS', 'SAINT[\s-]+ESPRIT', 'ESPRIT[\s-]+SAINT'),
    'es': ('DIOS', 'JES[ÚU]S', 'ESPÍRITU\s+SANTO'),
    'pt': ('DEUS', 'JESUS', 'ESPÍRITO\s+SANTO'),
    'de': (r'GOTT(?:ES)?', 'JESUS', 'HEILIGER\s+GEIST'),
    'it': ('DIO', 'GES[ÙU]', 'SPIRITO\s+SANTO'),
    'nl': ('GOD', 'JEZUS', 'HEILIGE\s+GEEST'),
    'ar': ('الله', 'يسوع', 'عيسى', 'الروح\s+القدس'),
    'ja': ('神', 'イエス(?:・キリスト)?', '聖霊'),
    'ko': ('하나님', '하느님', '예수님?', '성령'),
    'hi': ('परमेश्वर', 'ईश्वर', 'भगवान', 'यीशु', 'ईसा(?:\s+मसीह)?', 'पवित्र\s+आत्मा'),
    'id': ('ALLAH', 'TUHAN', 'YESUS', 'ROH\s+KUDUS'),
    'vi': ('ĐỨC\s+CHÚA\s+TRỜI', 'THIÊN\s+CHÚA', 'CHÚA\s+GIÊ[- ]?SU', 'CHÚA\s+GIÊ[- ]?XU', 'ĐỨC\s+THÁNH\s+LINH', 'CHÚA'),
    'th': ('พระเจ้า', 'พระเยซู', 'พระวิญญาณบริสุทธิ์'),
    'fil': ('DIYOS', 'HESUS', 'JESUS', 'BANAL\s+NA\s+ESPIRITU', 'ESPIRITU\s+SANTO'),
    'ru': ('БОГ(?:А|У|ОМ|Е)?', 'ИИСУС(?:А|У|ОМ|Е)?', 'СВЯТ(?:ОЙ|ОГО)\s+ДУХ(?:А)?'),
    'zh-Hans': ('上帝', '神', '耶稣', '圣灵'),
    'zh-Hant': ('上帝', '神', '耶穌', '聖靈'),
}

# Preserve multiword English terms as a single layout unit during wrapping.
KEYWORD_PATTERN = r"\b(?:GOD|JESUS|LORD)\b(?:['’]s?)?|\bHoly\s+Spirit\b(?:['’]s?)?"


def salient_title_spans(text, language='en'):
    """Return spans for faith terms in the selected language."""
    language = str(language or 'en')
    terms = RELIGIOUS_TERMS.get(language, RELIGIOUS_TERMS['en'])
    if language == 'en':
        terms = (*terms, r"LORD(?:['’]s?)?")
    unbounded = language in ('ja', 'zh-Hans', 'zh-Hant', 'th')
    matches=[]
    for term in terms:
        expression = re.escape(term) if term.isalnum() and not any(char.isspace() for char in term) else term
        if not unbounded:
            expression = r'(?<!\w)(?:' + expression + r')(?!\w)'
        matches.extend((match.start(),match.end()) for match in re.finditer(expression,text,re.IGNORECASE))
    matches.sort()
    merged=[]
    for start,end in matches:
        if merged and start < merged[-1][1]:
            merged[-1]=(merged[-1][0],max(merged[-1][1],end))
        else:
            merged.append((start,end))
    return merged


def title_line_runs(values, language='en'):
    text='\n'.join(values)
    spans=salient_title_spans(text,language)
    result=[];offset=0
    for value in values:
        runs=[]
        for index,char in enumerate(value):
            color=ORANGE if any(start<=offset+index<end for start,end in spans) else '#000000'
            if runs and runs[-1]['color']==color:runs[-1]['text']+=char
            else:runs.append({'text':char,'color':color})
        result.append(runs);offset+=len(value)+1
    return result


def title_runs(text,language='en'):
    return title_line_runs([text],language)[0]


class LocalEditor:
    def __init__(self, parent, data_dir, base, embedded=False, on_save=None, resolution=None, preview_target=None, preview_size=None):
        self.directory = Path(data_dir) / 'local_templates'
        self.directory.mkdir(exist_ok=True)
        self.base = base
        self.resolution = resolution
        self.preview_size = preview_size or (350, 650)
        self.on_save = on_save
        self.preview_executor=ThreadPoolExecutor(max_workers=1)
        self.preview_timer=None
        self.preview_poll=None
        self.preview_future=None
        self.preview_pending=None
        self.preview_generation=0
        self.preview_closed=False
        self.loading=False
        self.window = ttk.Frame(parent) if embedded else tk.Toplevel(parent)
        if embedded:
            self.window.pack(fill='both', expand=True)
        else:
            self.window.title('本地模板 · 可编辑文字 / 透明 PNG')
            screen_w=self.window.winfo_screenwidth();screen_h=self.window.winfo_screenheight()
            width=min(980,max(760,screen_w-64));height=min(740,max(560,screen_h-80))
            self.window.geometry(f'{width}x{height}+{max(0,(screen_w-width)//2)}+{max(0,(screen_h-height)//2)}')
            self.window.minsize(min(760,width),min(560,height))
            self.window.transient(parent)
            apply_appearance(self.window, '深色')
        self.design = {'footer': '', 'phone_input':'', 'lines': [], 'background': '#ffffff', 'radius': 20, 'padding':16, 'gap':0, 'top':850}
        left = ttk.Frame(self.window, padding=10)
        left.pack(side='left', fill='both', expand=True)
        self.canvas = preview_target if preview_target is not None else ttk.Label(self.window)
        if preview_target is None:self.canvas.pack(side='right', padx=12)
        self.window.bind('<Destroy>',self.stop_preview,add='+')
        toolbar = ttk.Frame(left)
        toolbar.pack(fill='x')
        actions = [('保存样式并应用所有页面', self.save)] if embedded else [('导入 Canva 文字', self.import_audit), ('打开预设', self.load), ('保存新版本', self.save)]
        for label, action in actions:
            button=ttk.Button(toolbar,text=label,command=action);button.pack(side='left',padx=2)
            if embedded:self.style_save_button=button
        ttk.Button(toolbar,text='字体吸管',command=lambda:self.eyedropper('title')).pack(side='left',padx=3)
        self.page = tk.StringVar(value='2')
        if not embedded:
            ttk.Label(left, text='预设名称（数字可对应 Canva 页码；每次保存保留旧版本）').pack(anchor='w', pady=5)
            ttk.Entry(left, textvariable=self.page, width=28).pack(anchor='w')
        self.layout=tk.StringVar(value='自动')
        modes=ttk.Frame(left);modes.pack(fill='x')
        ttk.Label(modes,text='批量替换排版').pack(side='left')
        ttk.Combobox(modes,textvariable=self.layout,values=['自动','单行','两行','三行','四行'],state='readonly',width=8).pack(side='left')
        self.top=tk.IntVar(value=850)
        ttk.Label(modes,text='标题高度').pack(side='left')
        ttk.Spinbox(modes,from_=0,to=1300,textvariable=self.top,width=6,command=self.preview).pack(side='left')
        ttk.Label(left, text='上方标题：Enter 换行；选中文字后点“改色”；光标所在行独立设置').pack(anchor='w', pady=6)
        self.text = tk.Text(left, height=7, undo=True, font=('Times New Roman', 16), wrap='word')
        self.text.configure(background=PALETTES['深色']['field'], foreground=PALETTES['深色']['fg'],
                            insertbackground=PALETTES['深色']['fg'], selectbackground=PALETTES['深色']['select'],
                            selectforeground='#ffffff', highlightbackground=PALETTES['深色']['border'],
                            highlightcolor=PALETTES['深色']['primary'], highlightthickness=1,
                            relief='flat', borderwidth=0)
        self.text.pack(fill='x')
        self.text.bind('<ButtonRelease-1>',self.sync_line_controls,add='+')
        self.text.bind('<KeyRelease>',self.sync_line_controls,add='+')
        self.text.bind('<KeyRelease>', lambda _: self.preview())
        self.text.bind('<Control-z>', lambda _: self.undo())
        controls = ttk.Frame(left)
        controls.pack(fill='x', pady=8)
        for label, action in [('自动排版', lambda:self.arrange(0)), ('两行', lambda:self.arrange(2)), ('三行', lambda:self.arrange(3)), ('四行', lambda:self.arrange(4)), ('选中文字改色', self.color)]:
            ttk.Button(controls, text=label, command=action).pack(side='left')
        self.size = tk.IntVar(value=52)
        self.bold = tk.BooleanVar(value=True)
        linebar = ttk.Frame(left)
        linebar.pack(fill='x')
        ttk.Label(linebar, text='当前行字号').pack(side='left')
        ttk.Spinbox(linebar, from_=12, to=180, textvariable=self.size, width=5).pack(side='left')
        ttk.Checkbutton(linebar, text='加粗', variable=self.bold).pack(side='left')
        ttk.Button(linebar, text='应用到当前行', command=self.line_style).pack(side='left')
        self.radius = tk.IntVar(value=20)
        self.gap = tk.IntVar(value=0)
        self.remove_white_plates = tk.BooleanVar(value=False)
        self.spacing=tk.StringVar(value='1.2')
        self.footer_spacing=tk.StringVar(value='1.2')
        style = ttk.Frame(left)
        style.pack(fill='x', pady=8)
        ttk.Button(style, text='标题底色', command=self.background).pack(side='left')
        ttk.Checkbutton(style, text='去掉白色底板', variable=self.remove_white_plates, command=self.preview).pack(side='left', padx=3)
        ttk.Label(style, text='圆角').pack(side='left')
        ttk.Spinbox(style, from_=0, to=100, textvariable=self.radius, width=4, command=self.preview).pack(side='left')
        ttk.Label(style, text='额外间距').pack(side='left')
        ttk.Spinbox(style, from_=0, to=80, textvariable=self.gap, width=4, command=self.preview).pack(side='left')
        ttk.Label(style,text='标题行高').pack(side='left',padx=3)
        self.title_spacing_scale=ttk.Scale(style,from_=0.0,to=3.0,orient='horizontal',length=100,command=lambda value:self.spacing.set(f'{float(value):.2f}'))
        bind_scale_wheel(self.title_spacing_scale, step=0.05)
        self.title_spacing_scale.set(1.2);self.title_spacing_scale.pack(side='left',padx=4)
        ttk.Entry(style,textvariable=self.spacing,width=5).pack(side='left')
        fontbar=ttk.Frame(left);fontbar.pack(fill='x',pady=3)
        ttk.Label(fontbar,text='标题字体').pack(side='left')
        self.font_choices=system_fonts()
        self.font_name=tk.StringVar(value='Times New Roman Bold')
        chooser=ttk.Combobox(fontbar,textvariable=self.font_name,values=list(self.font_choices),state='readonly',width=35)
        chooser.pack(side='left',fill='x',expand=True)
        chooser.bind('<<ComboboxSelected>>',lambda _:self.select_system_font())
        footerfontbar=ttk.Frame(left);footerfontbar.pack(fill='x',pady=3)
        ttk.Label(footerfontbar,text='下方信息字体').pack(side='left')
        self.footer_font_name=tk.StringVar(value='Arial Bold')
        footerchooser=ttk.Combobox(footerfontbar,textvariable=self.footer_font_name,values=list(self.font_choices),state='readonly',width=35)
        footerchooser.pack(side='left',fill='x',expand=True)
        footerchooser.bind('<<ComboboxSelected>>',lambda _:self.select_footer_font())
        footer_spacing_row=ttk.Frame(left);footer_spacing_row.pack(fill='x',pady=4)
        ttk.Label(footer_spacing_row,text='下方信息行距').pack(side='left')
        self.footer_spacing_scale=ttk.Scale(footer_spacing_row,from_=0,to=3,orient='horizontal',length=180,command=lambda value:self.footer_spacing.set(f'{float(value):.2f}'))
        bind_scale_wheel(self.footer_spacing_scale, step=0.05)
        self.footer_spacing_scale.set(1.2);self.footer_spacing_scale.pack(side='left',padx=5)
        ttk.Entry(footer_spacing_row,textvariable=self.footer_spacing,width=6).pack(side='left')
        self.padding = tk.IntVar(value=16)
        extra = ttk.Frame(left);extra.pack(fill='x',pady=3)
        ttk.Label(extra,text='底板边距').pack(side='left')
        ttk.Spinbox(extra,from_=0,to=60,textvariable=self.padding,width=4,command=self.preview).pack(side='left')
        self.footer_size = tk.IntVar(value=38)
        self.phone_size = tk.IntVar(value=68)
        self.link_size = tk.IntVar(value=48)
        for label, variable in [('下方字号',self.footer_size),('号码字号',self.phone_size),('链接字号',self.link_size)]:
            ttk.Label(extra,text=label).pack(side='left',padx=3)
            ttk.Spinbox(extra,from_=12,to=120,textvariable=variable,width=4,command=self.preview).pack(side='left')
        ttk.Label(left, text='下方文案和号码（可直接编辑, 保存到当前页面）').pack(anchor='w')
        self.phone_input=tk.StringVar(value='')
        phone_row=ttk.Frame(left);phone_row.pack(fill='x',pady=(0,3))
        ttk.Label(phone_row,text='导出号码').pack(side='left')
        ttk.Entry(phone_row,textvariable=self.phone_input,width=20).pack(side='left',padx=4)
        ttk.Label(phone_row,text='标题单独导出时留空，只导出标题').pack(side='left')
        self.footer = tk.Text(left, height=5, font=('Arial', 11))
        self.footer.configure(background=PALETTES['深色']['field'], foreground=PALETTES['深色']['fg'],
                              insertbackground=PALETTES['深色']['fg'], selectbackground=PALETTES['深色']['select'],
                              selectforeground='#ffffff', highlightbackground=PALETTES['深色']['border'],
                              highlightcolor=PALETTES['深色']['primary'], highlightthickness=1,
                              relief='flat', borderwidth=0)
        self.footer.pack(fill='x')
        self.footer.configure(exportselection=False)
        self.footer.bind('<<Modified>>',self.footer_changed)
        self.text.configure(exportselection=False)
        self.char_styles={}
        self.footer.insert('1.0', 'Message us on Whats/App at\n+1 (260)215-9873\nto join our FREE online Bible study.\nLINK IN MY BIO')
        self.phone_input.trace_add('write',lambda *_:self.preview())
        selectionbar=ttk.Frame(left);selectionbar.pack(fill='x',pady=4)
        ttk.Label(selectionbar,text='下方选中文字: 字号').pack(side='left')
        self.footer_selection_size=tk.IntVar(value=38)
        self.footer_selection_bold=tk.BooleanVar(value=True)
        ttk.Spinbox(selectionbar,from_=12,to=150,textvariable=self.footer_selection_size,width=5).pack(side='left')
        ttk.Checkbutton(selectionbar,text='加粗',variable=self.footer_selection_bold,command=lambda:self.footer_selection_style('bold')).pack(side='left',padx=4)
        ttk.Button(selectionbar,text='应用字号',command=lambda:self.footer_selection_style('size')).pack(side='left')
        ttk.Button(selectionbar,text='选区颜色',command=lambda:self.footer_selection_style('color')).pack(side='left',padx=3)
        ttk.Button(selectionbar,text='吸管',command=lambda:self.eyedropper('footer')).pack(side='left')
        footerbar=ttk.Frame(left);footerbar.pack(fill='x',pady=5)
        ttk.Button(footerbar, text='保存本页文案', command=self.save).pack(side='left')
        if not embedded:
            ttk.Button(footerbar, text='编辑下方文案', command=lambda:self.footer.configure(state='normal')).pack(side='left')
        ttk.Button(left, text='导出透明 PNG 到选择位置', command=self.export).pack(anchor='w', pady=8)
        self.notice = ttk.Label(left, wraplength=560)
        self.notice.pack(anchor='w')
        self.text.insert('1.0', 'Jesus Is Coming - And These Are the 4 Doors God Is About to Shut Forever')
        self.lock_footer()
        self.arrange(2)
        for variable in (self.top,self.radius,self.gap,self.padding,self.footer_size,self.phone_size,self.link_size,self.spacing,self.footer_spacing):
            variable.trace_add('write',lambda *_:self.preview())
        self.layout.trace_add('write',lambda *_:self.live_layout())

    def undo(self):
        try:self.text.edit_undo()
        except tk.TclError:pass
        self.preview()
        return 'break'

    def collect(self):
        from page_cache import normalize_contacts
        self.design['footer']=normalize_contacts(self.footer.get('1.0','end-1c'))
        self.design['phone_input']=self.phone_input.get().strip()
        lines = []
        from page_cache import english_brackets
        all_text=english_brackets(self.text.get('1.0','end-1c'))
        keywords=salient_title_spans(all_text,self.design.get('template_language','en'))
        offset=0
        for i, value in enumerate(all_text.split('\n'), 1):
            if not value:
                offset+=1;continue
            tags = self.text.tag_names(f'{i}.0')
            spec = getattr(self, 'styles', {}).get(next((t for t in tags if t.startswith('line_')), ''), {})
            runs = []
            for j, character in enumerate(value):
                colors = [self.text.tag_cget(t,'foreground') for t in self.text.tag_names(f'{i}.{j}') if t.startswith('color_')]
                color = next((c for c in reversed(colors) if c), '#000000')
                if any(start<=offset+j<end for start,end in keywords):color=ORANGE
                extra={}
                for tag in self.text.tag_names(f'{i}.{j}'):
                    if tag.startswith('char_'):extra.update(self.char_styles.get(tag,{}))
                run=dict(text=character,color=color,**extra)
                if runs and all(runs[-1].get(k)==run.get(k) for k in ('color','size','bold')):runs[-1]['text']+=character
                else:runs.append(run)
            lines.append({'runs':runs, 'size':spec.get('size',52), 'bold':spec.get('bold',True)})
            offset+=len(value)+1
        self.design.update(lines=lines,radius=self.radius.get(),gap=self.gap.get(),layout=self.layout.get(),top=self.top.get(),padding=self.padding.get(),footer_size=self.footer_size.get(),phone_size=self.phone_size.get(),link_size=self.link_size.get(),line_spacing=('auto' if self.spacing.get()=='自动' else self.spacing.get()),footer_line_spacing=float(self.footer_spacing.get()),show_plates=not self.remove_white_plates.get())
        return self.design

    def preview(self):
        if self.loading or self.preview_closed:return
        self.preview_generation+=1
        if self.preview_timer is not None:self.window.after_cancel(self.preview_timer)
        self.preview_timer=self.window.after(80,self.collect_preview)

    def collect_preview(self):
        self.preview_timer=None
        try:
            self.preview_pending=(self.preview_generation,copy.deepcopy(self.collect()))
            if self.preview_future is None:self.submit_preview()
        except Exception as exc:
            self.preview_pending=None
            self.notice.configure(text=str(exc))

    def render_preview(self, design):
        image=render(design,True)
        image.thumbnail(self.preview_size)
        return image

    def submit_preview(self):
        if self.preview_pending is None or self.preview_closed:return
        generation,design=self.preview_pending
        self.preview_pending=None
        self.preview_future=(generation,self.preview_executor.submit(self.render_preview,design))
        self.preview_poll=self.window.after(15,self.finish_preview)

    def finish_preview(self):
        self.preview_poll=None
        if self.preview_closed:return
        generation,future=self.preview_future
        if not future.done():
            self.preview_poll=self.window.after(15,self.finish_preview)
            return
        self.preview_future=None
        try:
            image=future.result()
            if generation==self.preview_generation:
                self.photo=ImageTk.PhotoImage(image,master=self.window)
                self.canvas.configure(image=self.photo,text='')
                self.notice.configure(text='实时效果已更新. 绿色只用于预览, 导出 PNG 外部仍透明.')
                self.preview_displayed=generation
        except Exception as exc:
            if generation==self.preview_generation:self.notice.configure(text=str(exc))
        self.submit_preview()

    def stop_preview(self,event):
        if event.widget!=self.window:return
        self.preview_closed=True
        for timer in (self.preview_timer,self.preview_poll):
            if timer is not None:
                try:self.window.after_cancel(timer)
                except tk.TclError:pass
        self.preview_executor.shutdown(wait=False,cancel_futures=True)

    def live_line_style(self):
        # Editing the controls alone must not overwrite a line's stored style.
        # The explicit apply button commits those values to the current line.
        if not self.loading:self.preview()

    def sync_line_controls(self,event=None):
        if self.loading:return
        try:
            number=self.text.index('insert').split('.')[0]
            tags=self.text.tag_names(f'{number}.0')
            line_tag=next((tag for tag in tags if tag.startswith('line_')),None)
            spec=self.styles.get(line_tag,{}) if line_tag else {}
            char_tag=next((tag for tag in tags if tag.startswith('char_')),None)
            if char_tag:spec={**spec,**self.char_styles.get(char_tag,{})}
            self.size.set(int(spec.get('size',52)))
            self.bold.set(bool(spec.get('bold',True)))
        except (tk.TclError,ValueError,TypeError):pass

    def live_layout(self):
        if self.loading:return
        self.arrange({'单行':1,'两行':2,'三行':3,'四行':4}.get(self.layout.get(),0))

    def arrange(self,count):
        value=self.text.get('1.0','end-1c')
        default_size=self.size.get()
        face=font(default_size,path=self.design.get('font_path'))
        values=fit_title_lines(value,count or 1,face.getlength)
        self.text.delete('1.0','end')
        self.text.insert('1.0','\n'.join(values))
        self.styles={}
        # Auto arranging is also a fresh layout operation: explicitly carry
        # the chosen current size onto each generated line so collect() does
        # not silently substitute the historical 52px fallback.
        for index in range(1,len(values)+1):
            tag=f'line_{index}'
            self.styles[tag]={'size':default_size,'bold':self.bold.get()}
            self.text.tag_add(tag,f'{index}.0',f'{index}.end')
        for start,end in salient_title_spans('\n'.join(values),self.design.get('template_language','en')):
            self.apply_color(f'1.0+{start}c',f'1.0+{end}c',ORANGE)
        self.preview()

    def apply_color(self,start,end,color):
        tag='color_'+str(len(self.text.tag_names()))
        self.text.tag_configure(tag,foreground=color)
        self.text.tag_add(tag,start,end)

    def color(self):
        try:start,end=self.text.index('sel.first'),self.text.index('sel.last')
        except tk.TclError:
            messagebox.showinfo('选择文字','请先选中要改色的单词或文字',parent=self.window);return
        value=askcolor(parent=self.window)[1]
        if value:self.apply_color(start,end,value);self.preview()

    def line_style(self):
        number=self.text.index('insert').split('.')[0]
        tag='line_'+number
        if not hasattr(self,'styles'):self.styles={}
        try:
            start,end=self.text.index('sel.first'),self.text.index('sel.last')
            tag='char_'+str(len(self.text.tag_names()))
            self.char_styles[tag]={'size':self.size.get(),'bold':self.bold.get()}
            self.text.tag_add(tag,start,end);self.preview();return
        except tk.TclError:pass
        self.styles[tag]={'size':self.size.get(),'bold':self.bold.get()}
        self.text.tag_add(tag,number+'.0',number+'.end')
        self.preview()

    def eyedropper(self,kind):
        widget=self.text if kind=='title' else self.footer
        try:start,end=widget.index('sel.first'),widget.index('sel.last')
        except tk.TclError:
            if kind=='footer':self.notice.configure(text='请先选中下方需要取色的文字.');return
            start,end='1.0','end-1c'
        from color_picker import pick_screen_color
        def apply(color):
            if kind=='title':self.apply_color(start,end,color)
            else:self.apply_footer_attribute(start,end,'color',color)
            self.preview()
        pick_screen_color(self.window,apply)

    def apply_footer_attribute(self,start,end,attribute,value):
        first,last=int(start.split('.')[0]),int(end.split('.')[0])
        styles=self.design.setdefault('footer_styles',[])
        for line in range(first,last+1):
            text=self.footer.get(f'{line}.0',f'{line}.end')
            lo=int(start.split('.')[1]) if line==first else 0
            hi=int(end.split('.')[1]) if line==last else len(text)
            if hi>lo:
                styles[:]=[item for item in styles if not (item.get('line')==line-1 and item.get('start')==lo and item.get('end')==hi and item.get('whole_line',False)==(lo==0 and hi==len(text)) and item.get(attribute) is not None)]
                styles.append({'line':line-1,'start':lo,'end':hi,'whole_line':lo==0 and hi==len(text),attribute:value})

    def footer_selection_style(self,attribute):
        try:start,end=self.footer.index('sel.first'),self.footer.index('sel.last')
        except tk.TclError:
            self.notice.configure(text='请先选中下方要单独设置的文字.');return
        value=askcolor(parent=self.window)[1] if attribute=='color' else self.footer_selection_size.get() if attribute=='size' else self.footer_selection_bold.get()
        if value is None:return
        first,last=int(start.split('.')[0]),int(end.split('.')[0])
        styles=self.design.setdefault('footer_styles',[])
        for line in range(first,last+1):
            value_text=self.footer.get(f'{line}.0',f'{line}.end')
            lo=int(start.split('.')[1]) if line==first else 0
            hi=int(end.split('.')[1]) if line==last else len(value_text)
            if hi<=lo:continue
            style={'line':line-1,'start':lo,'end':hi,'whole_line':lo==0 and hi==len(value_text),attribute:value}
            styles.append(style)
        self.preview()

    def background(self):
        value=askcolor(parent=self.window)[1]
        if value:self.design['background']=value;self.preview()

    def choose_font(self):
        path=filedialog.askopenfilename(parent=self.window,filetypes=[('字体','*.ttf *.otf')])
        if path:self.design['font_path']=path;self.preview()

    def select_system_font(self):
        self.design['font_path']=self.font_choices[self.font_name.get()]
        self.preview()

    def select_footer_font(self):
        self.design['footer_font_path']=self.font_choices[self.footer_font_name.get()]
        self.preview()

    def footer_changed(self,event=None):
        if self.footer.edit_modified():
            self.footer.edit_modified(False)
            self.preview()

    def lock_footer(self):
        self.footer.configure(state='normal')
        self.design['footer']=self.footer.get('1.0','end-1c')
        self.preview()

    def save(self):
        try:
            if self.on_save:
                data = self.collect()
                render(data)
                self.on_save(data)
                self.footer.delete('1.0','end');self.footer.insert('1.0',data['footer']);self.footer.edit_modified(False)
                from page_cache import phone_warnings
                warning=' 部分号码格式无法确认, 请核对.' if phone_warnings(data['footer']) else ''
                self.notice.configure(text='当前页面文案和样式已保存。'+warning)
                return
            target=preset_path(self.directory,self.page.get().strip())
            data=self.collect()
            render(data)
            versions=self.directory/'versions';versions.mkdir(exist_ok=True)
            version=versions/(target.stem+'-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'.json')
            if target.exists():
                (versions/(target.stem+'-previous-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'.json')).write_bytes(target.read_bytes())
            text=json.dumps(data,ensure_ascii=False,indent=2)
            version.write_text(text,encoding='utf-8')
            target.write_text(text,encoding='utf-8')
            self.notice.configure(text=f'模板已保存：{target}')
        except Exception as exc:messagebox.showerror('无法保存',str(exc),parent=self.window)

    def show_design(self,design):
        self.loading=True
        self.design=copy.deepcopy(design)
        for key in ('font_path','footer_font_path'):
            old_path=self.design.get(key)
            if old_path and not Path(old_path).is_file():
                bundled=Path(__file__).resolve().parent/'fonts'/Path(old_path).name
                if bundled.is_file():self.design[key]=str(bundled)
        design=self.design
        selected=design.get('font_path')
        self.font_name.set(next((n for n,p in self.font_choices.items() if p==selected),'Times New Roman Bold'))
        self.footer_font_name.set(next((n for n,p in self.font_choices.items() if p==design.get('footer_font_path')),'Arial Bold'))
        self.text.delete('1.0','end');self.styles={};self.char_styles={}
        for i,line in enumerate(design['lines'],1):
            if i>1:self.text.insert('end','\n')
            for run in line['runs']:
                start=self.text.index('end-1c');self.text.insert('end',run['text']);end=self.text.index('end-1c');self.apply_color(start,end,run['color'])
                extra={key:run[key] for key in ('size','bold') if key in run}
                if extra:
                    tag='char_'+str(len(self.text.tag_names()));self.char_styles[tag]=extra;self.text.tag_add(tag,start,end)
            tag='line_'+str(i);self.styles[tag]=line;self.text.tag_add(tag,f'{i}.0',f'{i}.end')
        first_line=design['lines'][0] if design.get('lines') else {}
        first_run=next((run for run in first_line.get('runs',[]) if 'size' in run or 'bold' in run),{})
        self.size.set(int(first_run.get('size',first_line.get('size',52))))
        self.bold.set(bool(first_run.get('bold',first_line.get('bold',True))))
        self.radius.set(design.get('radius',20));self.gap.set(design.get('gap',0))
        self.spacing.set('自动' if design.get('line_spacing')=='auto' else str(design.get('line_spacing',1.2)))
        footer_spacing=design.get('footer_line_spacing',design.get('line_spacing',1.2))
        self.footer_spacing.set(str(spacing_value(footer_spacing)))
        self.footer_spacing_scale.set(spacing_value(footer_spacing))
        self.title_spacing_scale.set(spacing_value(design.get('line_spacing',1.2)))
        self.padding.set(design.get('padding',16))
        self.footer_size.set(design.get('footer_size',38));self.phone_size.set(design.get('phone_size',68));self.link_size.set(design.get('link_size',48))
        self.remove_white_plates.set(not design.get('show_plates',True))
        self.phone_input.set(design.get('phone_input',''))
        self.top.set(design.get('top',850));self.layout.set(design.get('layout','自动'))
        self.footer.configure(state='normal');self.footer.delete('1.0','end');self.footer.insert('1.0',design['footer']);self.footer.edit_modified(False)
        self.loading=False
        self.preview()

    def load(self):
        path=filedialog.askopenfilename(parent=self.window,initialdir=self.directory,filetypes=[('本地模板','*.json')])
        if path:
            try:
                self.page.set(Path(path).stem.removeprefix('page-'))
                self.show_design(json.loads(Path(path).read_text(encoding='utf-8')))
            except Exception as exc:messagebox.showerror('无法读取',str(exc),parent=self.window)

    def import_audit(self):
        path=filedialog.askopenfilename(parent=self.window,filetypes=[('Canva 文字记录','*.json')])
        if not path:return
        try:
            data=json.loads(Path(path).read_text(encoding='utf-8'))
            page=next(p for p in data['pages'] if p['page_number']==int(self.page.get()))
            texts=[e for e in page['text_elements'] if e.get('type')=='TEXT' and e['text'].strip()]
            footer=[e for e in texts if 'Message us on' in e['text']]
            titles=[e for e in texts if e not in footer]
            if len(titles)!=1 or len(footer)!=1:raise ValueError('这一页没有唯一标题和联系文案，请先在本地手动建立模板')
            design={'footer':footer[0]['text'],'lines':[{'runs':title_runs(titles[0]['text']),'size':52,'bold':True}],'top':min(1100,int(titles[0]['position']['top'])),'background':'#ffffff','radius':20}
            self.show_design(design);self.arrange(0)
            self.notice.configure(text='已导入这一页的真实文字。原字体/字号/效果未包含在记录里，请校准后保存模板。')
        except Exception as exc:messagebox.showerror('导入失败',str(exc),parent=self.window)

    def export(self):
        path=filedialog.asksaveasfilename(parent=self.window,initialdir=self.base.get(),defaultextension='.png',filetypes=[('透明 PNG','*.png')])
        if path:
            try:
                design=self.collect()
                if design.get('lines') and not self.phone_input.get().strip():
                    design['footer']='';design['footer_styles']=[]
                image=render(design,output_size=self.resolution.get() if self.resolution is not None else '1080x1920')
                image.save(path);self.notice.configure(text=f'已导出: {path}')
            except Exception as exc:messagebox.showerror('导出失败',str(exc),parent=self.window)

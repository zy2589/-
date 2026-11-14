"""Offline Canva text cache. No network access or changes to source designs."""
import json
import copy
import re
import unicodedata
import phonenumbers
from datetime import datetime
from pathlib import Path


def english_brackets(text):
    return text.translate(str.maketrans({'（':'(', '）':')','—':'-','–':'-','−':'-','―':'-'}))


PHONE_PATTERN=r'\+[^\S\r\n]*\d[\d ()\-（）]{6,}\d'


def format_phone(text):
    clean=unicodedata.normalize('NFKC',text).strip()
    clean=re.sub(r'[ \t]+',' ',clean)
    if '(' in clean or ')' in clean:
        clean=re.sub(r'[ \t]*([()])[ \t]*',r'\1',clean)
        return re.sub(r'[ \t]*-[ \t]*','-',clean)
    try:
        parsed=phonenumbers.parse(clean,None)
        output=phonenumbers.format_number(parsed,phonenumbers.PhoneNumberFormat.INTERNATIONAL)
        if phonenumbers.is_possible_number(parsed) and re.sub(r'\D','',output)==re.sub(r'\D','',clean):return output
    except phonenumbers.NumberParseException:pass
    return clean


def format_phone_like(existing,text):
    """Format replacement digits with the saved number's separators when possible."""
    existing=str(existing or '').strip();text=str(text or '').strip()
    if text and not text.startswith('+'):
        try:
            old_number=phonenumbers.parse(existing,None)
            country_prefix=str(old_number.country_code)
            entered_digits=re.sub(r'\D','',text)
            if entered_digits.startswith(country_prefix):
                text='+'+text
            else:
                text='+'+country_prefix+' '+text
        except phonenumbers.NumberParseException:
            text='+'+text
    old_digits=re.sub(r'\D','',existing);new_digits=re.sub(r'\D','',text)
    same_country=False
    try:
        old_parsed=phonenumbers.parse(existing,None)
        new_parsed=phonenumbers.parse(text,None)
        same_country=old_parsed.country_code==new_parsed.country_code
    except phonenumbers.NumberParseException:pass
    if '(' in existing and same_country and len(old_digits)==len(new_digits) and new_digits:
        digits=iter(new_digits)
        return ''.join(next(digits) if char.isdigit() else char for char in existing)
    return format_phone(text)


def normalize_contacts(text):
    text=english_brackets(text)
    return re.sub(PHONE_PATTERN,lambda match:format_phone(match.group()),text)


def phone_warnings(text):
    warnings=[]
    for match in re.finditer(PHONE_PATTERN,english_brackets(text)):
        try:
            number=phonenumbers.parse(match.group(),None)
            if not phonenumbers.is_possible_number(number):warnings.append(match.group())
        except phonenumbers.NumberParseException:warnings.append(match.group())
    return warnings


def normalize_cache(data):
    for page in data.get('pages',[]):
        for element in page.get('text_elements',[]):
            if isinstance(element.get('text'),str):element['text']=normalize_contacts(element['text'])
    return data


def save_page_name(path,number,name):
    name=name.strip()
    if not name:raise ValueError('页面名称不能为空')
    data=normalize_cache(json.loads(Path(path).read_text(encoding='utf-8')))
    page=next(page for page in data['pages'] if page['page_number']==int(number))
    page['page_name']=name;write_cache(path,data)


def save_page_content(path,number,text):
    text=normalize_contacts(text.strip())
    if not text:raise ValueError('页面内容不能为空')
    data=normalize_cache(json.loads(Path(path).read_text(encoding='utf-8')))
    page=next(page for page in data['pages'] if page['page_number']==int(number))
    original=[element for element in page['text_elements'] if element.get('text','').strip()]
    paragraphs=re.split(r'\n[ \t]*\n',text)
    replacement=[]
    for index,paragraph in enumerate(paragraphs):
        if not paragraph.strip():continue
        element=copy.deepcopy(original[index]) if index<len(original) else {'type':'TEXT'}
        element['text']=paragraph.strip();element['type']='TEXT'
        if re.search(PHONE_PATTERN,paragraph) or 'Message us on' in paragraph:element['role']='LOCAL_FOOTER'
        replacement.append(element)
    nontext=[element for element in page['text_elements'] if not element.get('text','').strip()]
    page['text_elements']=nontext+replacement;write_cache(path,data)


def save_footer(path,number,text):
    text=normalize_contacts(text.strip())
    if not text:raise ValueError('下方文案不能为空')
    data=normalize_cache(json.loads(Path(path).read_text(encoding='utf-8')))
    page=next(page for page in data['pages'] if page['page_number']==int(number))
    footers=[element for element in page['text_elements'] if 'Message us on' in element.get('text','') or element.get('role')=='LOCAL_FOOTER']
    if not footers:
        element={'type':'TEXT','role':'LOCAL_FOOTER','text':text};page['text_elements'].append(element)
    else:
        for element in footers:element['text']=text;element['role']='LOCAL_FOOTER'
    write_cache(path,data)


def read_pages(path):
    data = normalize_cache(json.loads(Path(path).read_text(encoding='utf-8')))
    pages = {}
    for page in data['pages']:
        number = int(page['page_number'])
        if number < 1 or number in pages:
            raise ValueError('页面记录包含无效或重复页码')
        pages[number] = page
    return pages


def anonymize_template_names(path):
    """Remove person identities left by the former person-to-page workflow."""
    source=Path(path)
    data=normalize_cache(json.loads(source.read_text(encoding='utf-8')))
    changed=False
    pages=sorted(data.get('pages',[]),key=lambda page:int(page['page_number']))
    for position,page in enumerate(pages,1):
        label=f'模板 {position}'
        if page.get('page_name')!=label:
            page['page_name']=label;changed=True
        for key in ('local_person','local_title'):
            if key in page:
                del page[key];changed=True
    if changed:write_cache(source,data)


def ordered_page_numbers(pages):
    """Return template pages in stable source-page order."""
    return sorted(pages)


def page_number_for_position(pages, position):
    """Resolve the only supported traffic template to its local design page."""
    try:
        position=int(position)
    except (TypeError, ValueError):
        raise ValueError('请输入模板编号')
    ordered=ordered_page_numbers(pages)
    if position != 1 or not ordered:raise ValueError('目前仅保留模板 1')
    return ordered[0]


def page_text(page):
    return '\n\n'.join(e['text'].strip() for e in page['text_elements'] if e.get('text', '').strip())


def match_pages(pages, person, title=''):
    clean = lambda v: ' '.join(v.split()).casefold()
    wanted = clean(person)
    if not wanted:
        return []
    wanted_title = clean(title)
    results=[];task_copies=[]
    matching_task_titles={clean(p.get('local_title','')) for p in pages.values()
                          if p.get('origin')=='local-copy' and clean(p.get('local_person',''))==wanted
                          and clean(p.get('local_title',''))} if not wanted_title else set()
    for position,n in enumerate(ordered_page_numbers(pages),1):
        p=pages[n]
        if p.get('origin') == 'local-copy':
            local_person=clean(p.get('local_person', ''))
            local_title=clean(p.get('local_title', ''))
            if local_person and local_title:
                # Newer task copies have explicit identity metadata. Prefer an
                # exact person/title match, while still allowing a unique
                # person match when the title has not been entered yet.
                if local_person==wanted:
                    if not wanted_title:
                        if local_title not in matching_task_titles:
                            results.append(position)
                    elif local_title==wanted_title:
                        task_copies.append(position)
                continue
            # Older local copies may predate identity metadata. Fall through
            # and match their visible page name like other saved pages.
        name=p.get('page_name','')
        suffix=name.partition('-')[2] if '-' in name else name
        if clean(suffix)==wanted:results.append(position)
    return task_copies or results


def page_footer(page):
    values = [e['text'].strip() for e in page['text_elements']
              if e.get('type') == 'TEXT' and ('Message us on' in e.get('text', '') or e.get('role')=='LOCAL_FOOTER')]
    values = list(dict.fromkeys(values))
    values = [v for v in values if not any(v != other and v in other for other in values)]
    if len(values) != 1:
        raise ValueError('这一页没有唯一的固定联系文案，请核对页面资料')
    text = normalize_contacts(values[0])
    phones = re.findall(r'\+\s*\d[\d ()\-]{6,}\d', text)
    if not phones and any(e.get('role')=='LOCAL_FOOTER' for e in page['text_elements']):return text,''
    if len(phones) != 1:
        raise ValueError('这一页没有唯一联系电话，请核对页面资料')
    return text, phones[0]


def page_design(pages, number, theme='白天', layout='自动', style=None, phone_override=''):
    if not str(number).isdigit() or int(number) not in pages:
        raise ValueError('页码不存在，请在页面资料里查看可用编号')
    footer, phone = page_footer(pages[int(number)])
    if phone_override.strip():
        replacement = format_phone(phone_override.strip())
        if not re.fullmatch(r'\+\s*\d[\d ()\-]{6,}\d', replacement):
            raise ValueError('号码请包含国家区号，例如 +1(989)912-3890')
        if not phone:
            raise ValueError('这一页没有可替换的联系电话，请先在页面资料里添加号码')
        footer = footer.replace(phone, replacement, 1)
        phone = replacement
    # Isolate CTA without changing its case or any other source wording.
    footer = re.sub(r'\s*(LINK IN MY BIO)', r'\n\1', footer)
    design = {'footer': footer, 'phone': phone, 'theme': theme, 'layout': layout,
            'top': 850, 'background': '#ffffff', 'radius': 22, 'padding': 16,
            'lines': [{'size': 52, 'bold': True, 'runs': [{'text': '', 'color': '#000000'}]}]}
    if style:
        design.update(copy.deepcopy({k: v for k, v in style.items() if k not in ('footer','phone','theme','layout')}))
    local=pages[int(number)].get('local_style')
    if local is not None:design.update(copy.deepcopy({key:value for key,value in local.items() if key not in ('footer','phone','theme','layout')}))
    return design


def write_cache(path, data):
    data=normalize_cache(data)
    source = Path(path)
    backups = source.parent / 'page_cache_backups'
    backups.mkdir(exist_ok=True)
    if source.exists():
        (backups / f'{source.stem}-{datetime.now():%Y%m%d-%H%M%S-%f}.json').write_bytes(source.read_bytes())
    temporary = source.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(source)


def read_style(path):
    source = Path(path).with_name('global-template.json')
    return json.loads(source.read_text(encoding='utf-8')) if source.exists() else {}


def style_snapshot(style):
    values=copy.deepcopy({key:value for key,value in style.items() if key not in ('footer','phone','theme')})
    values['custom_colors']={run['text'].strip():run['color'] for line in values.get('lines',[]) for run in line.get('runs',[]) if run['text'].strip() and run['color'] not in ('#000000','black','#e15f35')}
    values['custom_text_styles']={run['text']: {key:run[key] for key in ('size','bold') if key in run} for line in values.get('lines',[]) for run in line.get('runs',[]) if run['text'].strip() and any(key in run for key in ('size','bold'))}
    return values


def save_style(path,style):
    write_cache(Path(path).with_name('global-template.json'),style_snapshot(style))


def duplicate_page(path,source_number,name,style=None):
    name=name.strip()
    if not name:raise ValueError('新页面名称不能为空')
    data=normalize_cache(json.loads(Path(path).read_text(encoding='utf-8')))
    original=next(page for page in data['pages'] if page['page_number']==int(source_number))
    number=max(data.get('next_page_number',1),max((page['page_number'] for page in data['pages']),default=0)+1)
    duplicate=copy.deepcopy(original)
    duplicate.update(page_number=number,page_name=name,origin='local-copy',copied_from=int(source_number))
    effective=style if style is not None else original.get('local_style',read_style(path))
    duplicate['local_style']=style_snapshot(effective)
    data['pages'].append(duplicate);data['next_page_number']=number+1;data['page_count']=len(data['pages'])
    write_cache(path,data);return number


def duplicate_page_for_task(path, person, title, phone, style=None, source_number=None):
    """Clone a usable page record and replace its title, person and contact number."""
    person = ' '.join(str(person or '').split())
    title = ' '.join(str(title or '').split())
    if not person or not title:
        raise ValueError('新建页面资料需要填写人名和视频名称')
    phone = format_phone(str(phone or '').strip())
    if not re.fullmatch(r'\+\s*\d[\d ()\-]{6,}\d', phone):
        raise ValueError('页面资料缺失时，请填写含国家区号的号码，例如 +1 (868) 372-2347')

    data = normalize_cache(json.loads(Path(path).read_text(encoding='utf-8')))
    pages = {int(page['page_number']): page for page in data['pages']}
    candidates = []
    if source_number is not None and int(source_number) in pages:
        candidates.append(int(source_number))
    candidates.extend(number for number in ordered_page_numbers(pages) if number not in candidates)
    original = None
    original_number = None
    for number in candidates:
        try:
            footer, old_phone = page_footer(pages[number])
        except ValueError:
            continue
        if old_phone:
            original = pages[number]
            original_number = number
            break
    if original is None:
        raise ValueError('页面资料中没有可复制的标题和号码模板')

    number = max(data.get('next_page_number', 1), max(pages, default=0) + 1)
    duplicate = copy.deepcopy(original)
    duplicate.update(page_number=number, page_name=person, origin='local-copy',
                     copied_from=original_number, local_person=person, local_title=title)
    elements = duplicate.get('text_elements', [])
    title_elements = [element for element in elements
                      if isinstance(element.get('text'), str)
                      and element.get('text', '').strip()
                      and element.get('role') != 'LOCAL_FOOTER'
                      and 'Message us on' not in element.get('text', '')]
    if title_elements:
        title_elements[0]['text'] = title
        for element in title_elements[1:]:
            element['text'] = ''
    footers = [element for element in elements
               if 'Message us on' in element.get('text', '') or element.get('role') == 'LOCAL_FOOTER']
    footer, old_phone = page_footer(original)
    if footers:
        for element in footers:
            element['text'] = element.get('text', '').replace(old_phone, phone, 1)
            element['role'] = 'LOCAL_FOOTER'
    else:
        raise ValueError('复制的页面没有可替换号码的联系文案')
    effective = style if style is not None else original.get('local_style', read_style(path))
    duplicate['local_style'] = style_snapshot(effective)
    data['pages'].append(duplicate)
    data['next_page_number'] = number + 1
    data['page_count'] = len(data['pages'])
    write_cache(path, data)
    return number


def save_local_style(path,number,style):
    data=normalize_cache(json.loads(Path(path).read_text(encoding='utf-8')))
    page=next(page for page in data['pages'] if page['page_number']==int(number))
    page['local_style']=style_snapshot(style)
    write_cache(path,data)


def add_page(path):
    data = normalize_cache(json.loads(Path(path).read_text(encoding='utf-8')))
    # Never reuse a removed number; stale download rows cannot target another person.
    number = max(data.get('next_page_number', 1), max((p['page_number'] for p in data['pages']), default=0) + 1)
    data['pages'].append({'page_number':number, 'page_name':'新页面', 'origin':'local',
                         'text_elements':[{'type':'TEXT','text':'标题预览','position':{'top':850,'left':0}}]})
    data['next_page_number'] = number + 1
    data['page_count'] = len(data['pages'])
    write_cache(path, data)
    return number


def delete_page(path, number):
    data = normalize_cache(json.loads(Path(path).read_text(encoding='utf-8')))
    data['next_page_number'] = max(data.get('next_page_number', 1), max((p['page_number'] for p in data['pages']), default=0)+1)
    original_count = len(data['pages'])
    data['pages'] = [p for p in data['pages'] if p['page_number'] != int(number)]
    if len(data['pages']) == original_count:
        raise ValueError('页码不存在')
    data['page_count'] = len(data['pages'])
    write_cache(path, data)


def save_page(path, number, name, phone):
    phone = format_phone(phone.strip())
    if not re.fullmatch(r'\+\s*\d[\d ()\-]{6,}\d', phone):
        raise ValueError('请输入带 + 国家区号的电话号码')
    data = normalize_cache(json.loads(Path(path).read_text(encoding='utf-8')))
    page = next(p for p in data['pages'] if p['page_number'] == int(number))
    page['page_name'] = name.strip()
    footers = [e for e in page['text_elements'] if 'Message us on' in e.get('text','') or e.get('role')=='LOCAL_FOOTER']
    if not footers:
        page['text_elements'].append({'type':'TEXT','position':{'top':1425,'left':0},
            'text':f'Message us on Whats/App at\n{phone}\nto join our FREE online Bible study.\nLINK IN MY BIO'})
    else:
        _, old = page_footer(page)
        for element in footers:
            element['text'] = element['text'].replace(old, phone, 1)
    write_cache(path, data)


def save_phone(path, number, phone):
    phone = format_phone(phone.strip())
    if not re.fullmatch(r'\+\s*\d[\d ()\-]{6,}\d', phone):
        raise ValueError('请输入带 + 国家区号的电话号码；可保留空格、括号和横线')
    source = Path(path)
    original = source.read_text(encoding='utf-8')
    data = normalize_cache(json.loads(original))
    page = next((p for p in data['pages'] if p['page_number'] == int(number)), None)
    if page is None:
        raise ValueError('页码不存在')
    _, old_phone = page_footer(page)
    for element in page['text_elements']:
        if 'Message us on' in element.get('text', '') or element.get('role')=='LOCAL_FOOTER':
            element['text'] = element['text'].replace(old_phone, phone, 1)
    backups = source.parent / 'page_cache_backups'
    backups.mkdir(exist_ok=True)
    (backups / f'{source.stem}-{datetime.now():%Y%m%d-%H%M%S-%f}.json').write_text(original, encoding='utf-8')
    temporary = source.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(source)

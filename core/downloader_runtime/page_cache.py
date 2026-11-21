"""Offline Canva text cache. No network access or changes to source designs."""
import json
import copy
import re
import unicodedata
import phonenumbers
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from app_settings import canva_page_cache_fallback_path, global_template_fallback_path


def english_brackets(text):
    return text.translate(str.maketrans({'（':'(', '）':')','—':'-','–':'-','−':'-','―':'-'}))


PHONE_PATTERN=r'\+[^\S\r\n]*\d[\d ()\-（）]{6,}\d'
PHONE_LABEL_PATTERN = re.compile(
    r'(?:电话(?:号码)?|電話(?:號碼|番号)?|号码|號碼|手机|手機|(?<![\w])(?:whats\s*app|whatsapp|phone(?:\s*number)?|telephone|tel)(?![\w]))\s*[:：=]?\s*',
    re.IGNORECASE,
)


def extract_phone_input(text, region='US'):
    """Extract a plausible phone number from pasted labels or descriptive text."""
    value = unicodedata.normalize('NFKC', str(text or '')).translate(str.maketrans({
        '（': '(', '）': ')', '—': '-', '–': '-', '−': '-', '―': '-',
        '\u00a0': ' ', '\u200b': ' ', '\u2060': ' ',
    }))
    value = ''.join(str(unicodedata.digit(char)) if char.isdigit() else char for char in value)

    # A labeled phone wins over incidental numbers in the surrounding copy,
    # for example a promo multiplier such as "1.25x" before "电话：+64…".
    labels = list(PHONE_LABEL_PATTERN.finditer(value))
    search_text = value[labels[-1].end():] if labels else value
    matches = list(phonenumbers.PhoneNumberMatcher(search_text, region))
    if not matches and labels:
        return ''
    if not matches:
        return ''
    international = [match for match in matches if '+' in match.raw_string]
    match = (international or matches)[-1]
    return re.sub(r'\s+', ' ', match.raw_string.translate(str.maketrans({'＋': '+'}))).strip()


def _format_nanp_phone(text, region='US', country_code_hint=1):
    """Format North American numbering-plan numbers in the established +1(area)xxx-xxxx style."""
    clean = str(text or '').strip()
    if not clean:
        return ''
    # A malformed pasted value like +(646)594-2103 is missing the US country
    # code. Restore it only when the current row/template is already US-based.
    if country_code_hint == 1 and re.match(r'^\+\s*\(', clean):
        clean = re.sub(r'^\+\s*', '+1', clean, count=1)
    try:
        number = phonenumbers.parse(clean, None if clean.startswith('+') else (region or 'US'))
        if (number.country_code != 1
                or not phonenumbers.is_possible_number(number)
                or number.extension):
            return ''
        national = str(number.national_number)
        if len(national) != 10:
            return ''
        return f'+1({national[:3]}){national[3:6]}-{national[6:]}'
    except phonenumbers.NumberParseException:
        return ''


def format_phone(text):
    clean=extract_phone_input(text)
    if not clean:return ''
    clean=re.sub(r'[ \t]+',' ',clean)
    nanp_phone=_format_nanp_phone(clean)
    if nanp_phone:return nanp_phone
    if '(' in clean or ')' in clean:
        clean=re.sub(r'[ \t]*([()])[ \t]*',r'\1',clean)
        return re.sub(r'[ \t]*-[ \t]*','-',clean)
    try:
        parsed=phonenumbers.parse(clean,None)
        output=phonenumbers.format_number(parsed,phonenumbers.PhoneNumberFormat.INTERNATIONAL)
        if phonenumbers.is_possible_number(parsed) and re.sub(r'\D','',output)==re.sub(r'\D','',clean):return output
    except phonenumbers.NumberParseException:pass
    return clean


def template_footer_with_phone(text, phone, previous_phone=''):
    """Keep a saved template's editable phone field present in its copy text."""
    footer=normalize_contacts(str(text or '').strip())
    phone=format_phone(str(phone or '').strip())
    if not footer:raise ValueError('引流文案不能为空')
    if not re.fullmatch(r'\+\s*\d[\d ()\-]{6,}\d',phone):
        raise ValueError('模板号码请包含国家区号，例如 +33 6 12 34 56 78')
    if previous_phone and previous_phone in footer:
        return footer.replace(previous_phone,phone,1)
    numbers=list(re.finditer(PHONE_PATTERN,footer))
    if len(numbers)>1:raise ValueError('引流文案中有多个联系电话，请保留一个号码')
    if numbers:
        match=numbers[0]
        return footer[:match.start()]+phone+footer[match.end():]
    return f'{footer.rstrip()}\n{phone}'


def format_phone_like(existing,text):
    """Format replacement digits with the saved number's separators when possible."""
    existing=str(existing or '').strip()
    region='US'
    country_code_hint=1
    try:
        old_number=phonenumbers.parse(existing,None)
        region=phonenumbers.region_code_for_number(old_number) or region
        country_code_hint=old_number.country_code
    except phonenumbers.NumberParseException:
        pass
    text=extract_phone_input(text,region)
    if not text:return ''
    nanp_phone=_format_nanp_phone(text,region,country_code_hint)
    if nanp_phone:return nanp_phone
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
    if same_country and len(old_digits)==len(new_digits) and new_digits:
        # Keep the existing row/template style for non-US numbers when the
        # pasted number is compact; US numbers use their fixed format above.
        if any(char in text for char in ' ()-'):
            return re.sub(r'\s+', ' ', text).strip()
        digits=iter(new_digits)
        return ''.join(next(digits) if char.isdigit() else char for char in existing)
    return format_phone(text)


def normalize_contacts(text):
    text=unicodedata.normalize('NFKC',english_brackets(text))
    return re.sub(PHONE_PATTERN,lambda match:format_phone(match.group()),text)


def phone_warnings(text):
    warnings=[]
    for match in re.finditer(PHONE_PATTERN,english_brackets(text)):
        try:
            number=phonenumbers.parse(match.group(),None)
            if not phonenumbers.is_possible_number(number):warnings.append(match.group())
        except phonenumbers.NumberParseException:warnings.append(match.group())
    return warnings


class _TemplateAuditParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_template_one = False
        self.in_pre = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'article' and attributes.get('id') == 'template-1':
            self.in_template_one = True
        elif self.in_template_one and tag == 'pre' and not self.parts:
            self.in_pre = True

    def handle_endtag(self, tag):
        if tag == 'pre' and self.in_pre:
            self.in_pre = False
        elif tag == 'article' and self.in_template_one:
            self.in_template_one = False

    def handle_data(self, data):
        if self.in_template_one and self.in_pre:
            self.parts.append(data)


def _bootstrap_cache_from_audit_html(path):
    audit = Path(path).with_name('Canva本地页面信息.html')
    if not audit.is_file():
        return None
    parser = _TemplateAuditParser()
    try:
        parser.feed(audit.read_text(encoding='utf-8'))
    except (OSError, UnicodeError):
        return None
    footer = ''.join(parser.parts).strip()
    if not footer:
        return None
    return {'checked_at': datetime.now().isoformat(timespec='seconds'), 'page_count': 1,
            'pages': [{'page_number': 1, 'page_name': '模板 1',
                       'text_elements': [{'type': 'TEXT', 'role': 'LOCAL_FOOTER', 'text': footer}]}]}


def normalize_cache(data):
    for page in data.get('pages',[]):
        for element in page.get('text_elements',[]):
            if isinstance(element.get('text'),str):element['text']=normalize_contacts(element['text'])
    return data


def read_cache(path):
    source = Path(path)
    fallback = canva_page_cache_fallback_path() if source.name == 'canva-page-audit.json' else None
    candidates = [source]
    if fallback is not None and fallback != source:
        candidates.append(fallback)
    readable = []
    parse_errors = []
    for candidate in candidates:
        try:
            data = json.loads(candidate.read_text(encoding='utf-8'))
            readable.append((candidate.stat().st_mtime_ns, data))
        except (FileNotFoundError, PermissionError):
            continue
        except json.JSONDecodeError as exc:
            parse_errors.append(exc)
    if readable:
        return normalize_cache(max(readable, key=lambda item: item[0])[1])
    if parse_errors:
        raise parse_errors[0]
    data = _bootstrap_cache_from_audit_html(source)
    if data is None:
        return json.loads(source.read_text(encoding='utf-8'))
    try:
        write_cache(source, data)
    except PermissionError:
        pass
    return normalize_cache(data)


def resolved_cache_path(path):
    source = Path(path)
    fallback = canva_page_cache_fallback_path() if source.name == 'canva-page-audit.json' else None
    candidates = [candidate for candidate in (source, fallback) if candidate is not None and candidate.is_file()]
    if candidates:
        return max(candidates, key=lambda candidate: candidate.stat().st_mtime_ns)
    read_cache(source)
    candidates = [candidate for candidate in (source, fallback) if candidate is not None and candidate.is_file()]
    return max(candidates, key=lambda candidate: candidate.stat().st_mtime_ns) if candidates else source


def save_page_name(path,number,name):
    name=' '.join(str(name or '').split())
    if not name:raise ValueError('模板名称不能为空')
    if len(name)>48:raise ValueError('模板名称不能超过 48 个字符')
    data=read_cache(path)
    page=next((page for page in data['pages'] if page['page_number']==int(number)),None)
    if page is None:raise ValueError('找不到要重命名的模板')
    page['page_name']=name;write_cache(path,data)


def save_page_content(path,number,text):
    text=normalize_contacts(text.strip())
    if not text:raise ValueError('页面内容不能为空')
    data=read_cache(path)
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
    data=read_cache(path)
    page=next(page for page in data['pages'] if page['page_number']==int(number))
    footers=[element for element in page['text_elements'] if 'Message us on' in element.get('text','') or element.get('role')=='LOCAL_FOOTER']
    if not footers:
        element={'type':'TEXT','role':'LOCAL_FOOTER','text':text};page['text_elements'].append(element)
    else:
        for element in footers:element['text']=text;element['role']='LOCAL_FOOTER'
    write_cache(path,data)


def read_pages(path):
    data = read_cache(path)
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
    data=read_cache(source)
    changed=False
    pages=sorted(data.get('pages',[]),key=lambda page:int(page['page_number']))
    for position,page in enumerate(pages,1):
        label=f'模板 {position}'
        has_legacy_identity=any(page.get(key) for key in ('local_person','local_title'))
        if has_legacy_identity and page.get('page_name')!=label:
            page['page_name']=label;changed=True
        for key in ('local_person','local_title'):
            if key in page:
                del page[key];changed=True
    if changed:write_cache(source,data)


def ordered_page_numbers(pages):
    """Return template pages in stable source-page order."""
    return sorted(pages)


def language_template_numbers(pages):
    """Return the English source template and any explicitly created language copies."""
    ordered = ordered_page_numbers(pages)
    source = next((number for number in ordered if not pages[number].get('template_language')), None)
    copies = [number for number in ordered if pages[number].get('template_language')]
    return ([source] if source is not None else []) + copies


def page_number_for_position(pages, position, language_code='en'):
    """Resolve template 1 to the selected language's saved copy."""
    try:
        position=int(position)
    except (TypeError, ValueError):
        raise ValueError('请输入模板编号')
    if position != 1:
        raise ValueError('目前仅保留模板 1')
    language_code = str(language_code or 'en').strip() or 'en'
    copies = [number for number in ordered_page_numbers(pages)
              if pages[number].get('template_language') == language_code]
    if copies:
        return copies[0]
    if language_code == 'en':
        source = next((number for number in ordered_page_numbers(pages)
                       if not pages[number].get('template_language')), None)
        if source is not None:
            return source
    language_names = {
        'fr': '法语', 'es': '西班牙语', 'pt': '葡萄牙语', 'de': '德语',
        'it': '意大利语', 'nl': '荷兰语', 'ar': '阿拉伯语', 'ja': '日语',
        'ko': '韩语', 'hi': '印地语', 'id': '印度尼西亚语', 'vi': '越南语',
        'th': '泰语', 'fil': '菲律宾语', 'ru': '俄语', 'zh-Hans': '简体中文',
        'zh-Hant': '繁体中文',
    }
    raise ValueError(f'还没有{language_names.get(language_code, language_code)}引流模板。请先在“引流模板”中从英语模板复制新建。')


def duplicate_language_template(path, source_number, language_code, language_name, style=None,
                               footer=None, phone=None):
    """Clone a complete page, then give its copy independent text, phone, and style."""
    language_code = str(language_code or '').strip()
    language_name = ' '.join(str(language_name or '').split())
    if not language_code or language_code == 'en' or not language_name:
        raise ValueError('请选择英语以外的模板语种。')
    data = read_cache(path)
    if any(page.get('template_language') == language_code for page in data.get('pages', [])):
        raise ValueError(f'已存在{language_name}模板。')
    original = next((page for page in data['pages']
                     if int(page['page_number']) == int(source_number)), None)
    if original is None:
        raise ValueError('找不到英语模板，无法复制。')
    number = max(data.get('next_page_number', 1),
                 max((int(page['page_number']) for page in data['pages']), default=0) + 1)
    duplicate = copy.deepcopy(original)
    duplicate.update(
        page_number=number,
        page_name=f'模板 1 · {language_name}',
        origin='local-copy',
        copied_from=int(source_number),
        template_language=language_code,
    )
    effective = style if style is not None else (original.get('local_style') or read_style(path))
    duplicate['local_style'] = style_snapshot(effective or {})
    if footer is not None:
        footer = normalize_contacts(str(footer).strip())
        if not footer:
            raise ValueError('复制模板需要先填写引流文案。')
        if phone is not None:
            _,source_phone=page_footer(duplicate)
            footer=template_footer_with_phone(footer,phone,source_phone)
        footer_elements = [element for element in duplicate.get('text_elements', [])
                           if 'Message us on' in element.get('text', '') or element.get('role') == 'LOCAL_FOOTER']
        if footer_elements:
            footer_elements[0]['text'] = footer
            footer_elements[0]['role'] = 'LOCAL_FOOTER'
            for element in footer_elements[1:]:
                element['text'] = ''
        else:
            duplicate.setdefault('text_elements', []).append(
                {'type': 'TEXT', 'role': 'LOCAL_FOOTER', 'text': footer})
    data['pages'].append(duplicate)
    data['next_page_number'] = number + 1
    data['page_count'] = len(data['pages'])
    write_cache(path, data)
    return number


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

    def write_to(target):
        backups = target.parent / 'page_cache_backups'
        backups.mkdir(parents=True, exist_ok=True)
        if target.exists():
            (backups / f'{target.stem}-{datetime.now():%Y%m%d-%H%M%S-%f}.json').write_bytes(target.read_bytes())
        temporary = target.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        try:
            temporary.replace(target)
        except Exception:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    try:
        write_to(source)
    except PermissionError:
        fallback = canva_page_cache_fallback_path() if source.name == 'canva-page-audit.json' else None
        if fallback is None or fallback.resolve() == source.resolve():
            raise
        write_to(fallback)


def read_style(path):
    source = Path(path).with_name('global-template.json')
    fallback = global_template_fallback_path()
    candidates = [source]
    if fallback is not None and fallback != source:
        candidates.append(fallback)
    readable = []
    for priority, candidate in enumerate(candidates):
        try:
            value = json.loads(candidate.read_text(encoding='utf-8'))
            modified = candidate.stat().st_mtime_ns
        except (FileNotFoundError, PermissionError):
            continue
        readable.append((modified, -priority, value))
    return max(readable, key=lambda item: (item[0], item[1]))[2] if readable else {}


def style_snapshot(style):
    values=copy.deepcopy({key:value for key,value in style.items() if key not in ('footer','phone','theme')})
    values['custom_colors']={run['text'].strip():run['color'] for line in values.get('lines',[]) for run in line.get('runs',[]) if run['text'].strip() and run['color'] not in ('#000000','black','#e15f35')}
    values['custom_text_styles']={run['text']: {key:run[key] for key in ('size','bold') if key in run} for line in values.get('lines',[]) for run in line.get('runs',[]) if run['text'].strip() and any(key in run for key in ('size','bold'))}
    return values


def save_style(path,style):
    source=Path(path).with_name('global-template.json')
    snapshot=style_snapshot(style)
    try:
        write_cache(source,snapshot)
    except PermissionError:
        fallback=global_template_fallback_path()
        if fallback is None or fallback.resolve()==source.resolve():raise
        fallback.parent.mkdir(parents=True,exist_ok=True)
        write_cache(fallback,snapshot)


def duplicate_page(path,source_number,name,style=None):
    name=name.strip()
    if not name:raise ValueError('新页面名称不能为空')
    data=read_cache(path)
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

    data = read_cache(path)
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
    data=read_cache(path)
    page=next(page for page in data['pages'] if page['page_number']==int(number))
    page['local_style']=style_snapshot(style)
    write_cache(path,data)


def add_page(path):
    data = read_cache(path)
    # Never reuse a removed number; stale download rows cannot target another person.
    number = max(data.get('next_page_number', 1), max((p['page_number'] for p in data['pages']), default=0) + 1)
    data['pages'].append({'page_number':number, 'page_name':'新页面', 'origin':'local',
                         'text_elements':[{'type':'TEXT','text':'标题预览','position':{'top':850,'left':0}}]})
    data['next_page_number'] = number + 1
    data['page_count'] = len(data['pages'])
    write_cache(path, data)
    return number


def delete_page(path, number):
    data = read_cache(path)
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
    data = read_cache(path)
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
    data = read_cache(source)
    page = next((p for p in data['pages'] if p['page_number'] == int(number)), None)
    if page is None:
        raise ValueError('页码不存在')
    _, old_phone = page_footer(page)
    for element in page['text_elements']:
        if 'Message us on' in element.get('text', '') or element.get('role')=='LOCAL_FOOTER':
            element['text'] = element['text'].replace(old_phone, phone, 1)
    write_cache(source, data)

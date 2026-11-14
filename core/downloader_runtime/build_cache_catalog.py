"""Build a readable, offline catalog from captured Canva page text."""
import html
import json
import re
from pathlib import Path


def build(source, target):
    data = json.loads(Path(source).read_text(encoding='utf-8'))
    pages = sorted(data['pages'], key=lambda p: p['page_number'])
    numbers = [p['page_number'] for p in pages]
    if len(set(numbers)) != len(numbers):
        raise ValueError('页面编号重复，未生成清单')
    cards = []
    for source_position,page in enumerate(pages,1):
        position=source_position if source_position==1 else source_position+1
        texts = [e['text'].strip() for e in page['text_elements'] if e.get('text', '').strip()]
        footers = list(dict.fromkeys(t for t in texts if 'Message us on' in t or any(e.get('role')=='LOCAL_FOOTER' and e.get('text','').strip()==t for e in page['text_elements'])))
        phones = list(dict.fromkeys(v.strip() for t in footers for v in re.findall(r'\+\s*\d[\d ()\-]{6,}\d', t)))
        notes = []
        if not phones:
            notes.append('未识别到联系电话，请人工核对')
        if len(footers) != 1:
            notes.append('固定联系文案不是唯一一段，请人工核对')
        body = ''.join('<pre>' + html.escape(t) + '</pre>' for t in footers)
        cards.append(f'<article id="template-{position}"><h2>模板 {position}</h2>'
                     f'<p>联系电话：{html.escape("；".join(phones) or "未识别")}</p>'
                     f'<p class="note">{html.escape("；".join(notes))}</p>{body}</article>')
    header = f'共 1 个模板 · 记录日期：{html.escape(str(data.get("checked_at", "未记录")))}'
    document = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>引流模板信息</title>
<style>body{font:16px "Microsoft YaHei",sans-serif;margin:24px auto;max-width:960px;padding:0 20px;background:#f5f6f8;color:#222}article{background:white;padding:18px 24px;margin:16px 0;border-radius:10px}pre{white-space:pre-wrap;font:inherit;line-height:1.7;border-top:1px solid #eee;padding-top:12px}.note{color:#945800}input{padding:10px;width:90%;font:inherit}h2{margin-top:0}</style>
<h1>引流模板信息</h1><p>''' + header + '''</p><p>当前仅保留模板 1。这里显示本机保存的引流文案和号码。</p>
<input placeholder="搜索模板编号、电话号码或文字" oninput="document.querySelectorAll('article').forEach(a=>a.hidden=!a.innerText.toLowerCase().includes(this.value.toLowerCase()))">
''' + ''.join(cards) + '</html>'
    Path(target).write_text(document, encoding='utf-8')
    paragraphs = ['# 引流模板信息', header, '当前仅保留模板 1。']
    if pages:
        paragraphs.append('## 模板 1')
        paragraphs.extend(e['text'].strip() for e in pages[0]['text_elements'] if e.get('text','').strip() and ('Message us on' in e.get('text','') or e.get('role')=='LOCAL_FOOTER'))
    Path(target).with_suffix('.md').write_text('\n\n'.join(paragraphs) + '\n', encoding='utf-8')
    return len(pages)


if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    print(build(root / 'canva-page-audit.json', root / 'Canva本地页面信息.html'))

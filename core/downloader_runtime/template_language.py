"""Build and apply a per-row language copy while retaining template styling."""
import copy
import re


_PHONE = re.compile(r'\+\s*\d[\d ()\-]{6,}\d')
_URL = re.compile(r'https?://[^\s]+', re.IGNORECASE)
_BRACKET_TOKEN = re.compile(r'\[[^\]\r\n]+\]|\{\{[^}]+\}\}')


def build_template_translation_request(design, source_phone=''):
    source_lines = str(design.get('footer', '')).split('\n')
    styles = design.get('footer_styles', []) or []
    style_by_line = {}
    for style_index, style in enumerate(styles):
        try:
            line_index = int(style.get('line', -1))
        except (TypeError, ValueError):
            continue
        if 0 <= line_index < len(source_lines):
            style_by_line.setdefault(line_index, []).append((style_index, style))

    markers = {}
    lines = []
    metadata = {'markers': markers, 'styles': [], 'emphasis': [], 'roles': []}
    counter = 0

    for line_index, original in enumerate(source_lines):
        replacements = []
        if source_phone and source_phone in original:
            replacements.append((original.index(source_phone), original.index(source_phone) + len(source_phone), source_phone, 'PHONE'))
        for pattern in (_PHONE, _URL, _BRACKET_TOKEN):
            for match in pattern.finditer(original):
                if any(match.start() < end and match.end() > start for start, end, _, _ in replacements):
                    continue
                kind = 'KEEP'
                if pattern is _PHONE and match.group(0) == source_phone:
                    kind = 'PHONE'
                replacements.append((match.start(), match.end(), match.group(0), kind))
        replacements.sort(key=lambda item: item[0])

        protected = []
        cursor = 0
        translated_line = ''
        mapped_replacements = []
        for start, end, value, kind in replacements:
            token = f'⟦CLIPASSIST_{kind}_{counter}⟧'
            counter += 1
            translated_line += original[cursor:start]
            token_start = len(translated_line)
            translated_line += token
            mapped_replacements.append((start, end, token_start, len(translated_line), token))
            markers[token] = {'value': value, 'kind': kind}
            cursor = end
        translated_line += original[cursor:]

        def mapped_offset(offset, prefer_end=False):
            delta = 0
            for old_start, old_end, new_start, new_end, _token in mapped_replacements:
                if offset < old_start:
                    break
                if offset >= old_end:
                    delta += (new_end - new_start) - (old_end - old_start)
                    continue
                return new_end if prefer_end else new_start
            return offset + delta

        phone_line = any(markers[token]['kind'] == 'PHONE'
                         and token in translated_line for *_coords, token in mapped_replacements)
        is_phone = phone_line or bool(_PHONE.search(original))
        is_cta = original.strip().casefold() == 'link in my bio'
        metadata['roles'].append('phone' if is_phone else 'cta' if is_cta else '')

        spans = []
        for style_index, style in style_by_line.get(line_index, []):
            if style.get('whole_line'):
                metadata['styles'].append({
                    'line': line_index, 'whole_line': True,
                    'style': copy.deepcopy(style),
                })
                continue
            try:
                old_start = max(0, min(len(original), int(style.get('start', 0))))
                old_end = max(old_start, min(len(original), int(style.get('end', 0))))
            except (TypeError, ValueError):
                continue
            if old_end <= old_start:
                continue
            new_start = mapped_offset(old_start)
            new_end = mapped_offset(old_end, prefer_end=True)
            for rep_start, rep_end, token_start, token_end, _token in mapped_replacements:
                if old_start < rep_end and old_end > rep_start:
                    new_start = min(new_start, token_start)
                    new_end = max(new_end, token_end)
            span_text = translated_line[new_start:new_end]
            if not span_text.strip():
                continue
            span_id = f'style_{style_index}'
            spans.append({'id': span_id, 'text': span_text})
            metadata['styles'].append({
                'line': line_index, 'span_id': span_id,
                'style': copy.deepcopy(style),
            })

        for emphasis_index, match in enumerate(re.finditer(r'FREE', translated_line, re.IGNORECASE)):
            span_id = f'auto_free_{line_index}_{emphasis_index}'
            spans.append({'id': span_id, 'text': match.group(0)})
            metadata['emphasis'].append({'line': line_index, 'span_id': span_id})

        only_marker = translated_line.strip() in markers
        lines.append({
            'index': line_index,
            'text': translated_line,
            'spans': spans,
            'skip': not translated_line.strip() or (only_marker and not spans),
        })

    return lines, metadata


def apply_template_translation(design, translation, metadata, replacement_phone=''):
    rows = translation.get('lines', []) if isinstance(translation, dict) else []
    if len(rows) != len(metadata.get('roles', [])):
        raise ValueError('翻译结果的换行数量与模板不一致。')

    marker_values = metadata.get('markers', {})
    lines = []
    row_spans = []
    for index, row in enumerate(rows):
        text = str(row.get('text', ''))
        spans = row.get('spans', {}) if isinstance(row.get('spans', {}), dict) else {}
        restored_spans = {}
        for span_id, value in spans.items():
            restored = str(value)
            for marker, item in marker_values.items():
                replacement = replacement_phone if item.get('kind') == 'PHONE' else item.get('value', '')
                restored = restored.replace(marker, replacement)
            restored_spans[str(span_id)] = restored
        for marker, item in marker_values.items():
            replacement = replacement_phone if item.get('kind') == 'PHONE' else item.get('value', '')
            text = text.replace(marker, replacement)
        lines.append(text)
        row_spans.append(restored_spans)

    styles = []
    for item in metadata.get('styles', []):
        line_index = int(item.get('line', -1))
        if line_index < 0 or line_index >= len(lines):
            continue
        style = copy.deepcopy(item.get('style', {}))
        style['line'] = line_index
        if item.get('whole_line'):
            style.update(start=0, end=len(lines[line_index]), whole_line=True)
        else:
            value = row_spans[line_index].get(item.get('span_id', ''), '')
            start = lines[line_index].find(value) if value else -1
            if start < 0:
                raise ValueError(f'第 {line_index + 1} 行无法恢复原有文字样式。')
            style.update(start=start, end=start + len(value), whole_line=False)
        styles.append(style)

    auto_highlights = {}
    for item in metadata.get('emphasis', []):
        line_index = int(item.get('line', -1))
        if line_index < 0 or line_index >= len(lines):
            continue
        value = row_spans[line_index].get(item.get('span_id', ''), '')
        start = lines[line_index].find(value) if value else -1
        if start < 0:
            raise ValueError(f'第 {line_index + 1} 行无法恢复原有强调颜色。')
        auto_highlights.setdefault(str(line_index), []).append([start, start + len(value)])

    result = dict(design)
    result['footer'] = '\n'.join(lines)
    result['footer_styles'] = styles
    result['footer_roles'] = list(metadata.get('roles', []))
    result['footer_auto_highlights'] = auto_highlights
    result['phone'] = replacement_phone or design.get('phone', '')
    return result

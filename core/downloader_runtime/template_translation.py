"""Translate per-row lead-copy without changing the shared saved template."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


LANGUAGE_CODES = {
    '英语': 'en',
    '法语': 'fr',
    '西班牙语': 'es',
    '葡萄牙语': 'pt',
    '德语': 'de',
    '意大利语': 'it',
    '荷兰语': 'nl',
    '阿拉伯语': 'ar',
    '日语': 'ja',
    '韩语': 'ko',
    '印地语': 'hi',
    '印度尼西亚语': 'id',
    '越南语': 'vi',
    '泰语': 'th',
    '菲律宾语': 'fil',
    '俄语': 'ru',
    '简体中文': 'zh-Hans',
    '繁体中文': 'zh-Hant',
}
LANGUAGES = tuple(LANGUAGE_CODES)
DEFAULT_LANGUAGE = '英语'


def translation_cache_key(target_language, request):
    encoded = json.dumps(
        {'targetLanguage': str(target_language), 'request': request},
        ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def load_translation_cache(path):
    try:
        value = json.loads(Path(path).read_text(encoding='utf-8'))
        entries = value.get('translations', {}) if isinstance(value, dict) else {}
        return {key: row for key, row in entries.items()
                if isinstance(key, str) and isinstance(row, dict)}
    except (OSError, ValueError, TypeError):
        return {}


def save_translation_cache(path, cache):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Bound cache growth while keeping recently used languages available.
    entries = dict(list(cache.items())[-128:])
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w', encoding='utf-8', dir=path.parent,
            delete=False, suffix='.tmp',
        ) as output:
            temporary = Path(output.name)
            json.dump({'version': 1, 'translations': entries}, output,
                      ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _translation_runtime():
    executable = 'node.exe' if os.name == 'nt' else 'node'
    if getattr(sys, 'frozen', False):
        install_root = Path(os.environ.get('CLIPASSIST_ENGINE_DIR') or Path(sys.executable).resolve().parent / '剪辑助手内核')
        if sys.platform == 'darwin' and not os.environ.get('CLIPASSIST_ENGINE_DIR'):
            install_root = Path(sys.executable).resolve().parent.parent / 'Resources' / '剪辑助手内核'
        node = install_root / 'runtime' / 'node' / executable
        module = (install_root / 'Modules' / '剪辑助手' /
                  '剪辑界面' / 'src' / 'template-translation.mjs')
    else:
        core_root = Path(__file__).resolve().parents[1]
        node = core_root / 'editor_runtime' / 'node.exe'
        module = core_root / 'editor_runtime' / 'src' / 'template-translation.mjs'
    if not node.is_file() or not module.is_file():
        raise RuntimeError('找不到剪辑助手的翻译运行时，请先更新软件。')
    return node, module


def translate_template_copy(request, target_language):
    """Call the app's configured Gemini/Vertex/Antigravity translator."""
    target_language = str(target_language or '')
    if target_language not in set(LANGUAGE_CODES.values()) or target_language == 'en':
        raise ValueError('目标语种无效。')
    node, module = _translation_runtime()
    module_url = json.dumps(module.as_uri(), ensure_ascii=False)
    runner = f'''import {{ readFileSync }} from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
const {{ translateLeadTemplate }} = await import({module_url});
try {{
  const result = await translateLeadTemplate(input);
  process.stdout.write(JSON.stringify(result));
}} catch (error) {{
  process.stderr.write(String(error?.message || error || "翻译失败"));
  process.exitCode = 1;
}}
'''
    payload = {'lines': request, 'targetLanguage': target_language}
    try:
        result = subprocess.run(
            [str(node), '--input-type=module', '--eval', runner],
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            cwd=str(module.parent), timeout=180,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError('翻译等待超过 3 分钟，未启动下载。请检查网络后重试。') from exc
    except OSError as exc:
        raise RuntimeError(f'无法启动翻译服务：{exc}') from exc
    if result.returncode:
        detail = (result.stderr or '').strip()
        raise RuntimeError(detail[:500] if detail else '翻译服务调用失败，请检查翻译设置和网络。')
    try:
        value = json.loads(result.stdout)
    except (ValueError, TypeError) as exc:
        raise RuntimeError('翻译服务返回的数据无法读取，请重试。') from exc
    if not isinstance(value, dict) or not isinstance(value.get('lines'), list):
        raise RuntimeError('翻译服务返回的数据不完整，请重试。')
    return value

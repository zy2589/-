"""Windows video download assistant. Run with Python 3.10+."""
import os
import ctypes
import html
import csv
import io
from html.parser import HTMLParser
import json
import difflib
import hashlib
import webbrowser
import queue
import re
import shutil
import sys
import subprocess
import threading
import time
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode, urljoin, urlsplit, urlunsplit, parse_qsl
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from app_settings import PALETTES, apply_appearance, read_settings, update_settings, settings_location, seed_user_data, rebase_local_fonts, sync_appearance
from desktop_ui import icon_button, icon_menu, DarkPopupMenu, add_theme_menu, set_window_icon, ToolTip, bind_scale_wheel
from template_translation import (DEFAULT_LANGUAGE, LANGUAGES, LANGUAGE_CODES,
                                  load_translation_cache, save_translation_cache,
                                  translate_template_copy, translation_cache_key)
from template_language import (apply_template_translation,
                               build_template_translation_request)

_drive_guard = threading.Lock()
_drive_locks = {}
_drive_completed = {}
_batch_download_cache = {}
_batch_download_locks = {}
VIDEO_SUFFIXES = frozenset({'.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpeg', '.mpg', '.ts',
                           '.flv', '.wmv', '.3gp', '.mts', '.m2ts', '.ogv', '.vob'})
DENOISE_PRESERVED_STATE = '降噪失败（视频已保留）'
DENOISE_ROW_LABEL = '降噪失败·已保留视频'
DEFAULT_CANVA_URL = 'https://www.canva.com/design/DAHRA0BP3kM/2iA1F04Kv1rmVAPeaFgF7w/edit'


def try_publish_title_png(design, title, output, resolution, backup_root):
    """Save a generated title image without blocking the related video task."""
    try:
        from local_design import replace_title, render
        from png_output import publish_png
        image_design=dict(design)
        image = render(replace_title(image_design, title), output_size=resolution)
        saved = publish_png(image, output, backup_root) or output
        saved = Path(saved)
        if not saved.is_file() or saved.stat().st_size < 128:
            raise OSError('PNG 文件未写入或文件为空')
    except Exception as exc:
        return str(exc)
    return None


def set_windows_window_app_id(hwnd, app_id):
    """Set the taskbar identity on the actual top-level window, not only its process."""
    if os.name != 'nt' or not hwnd:
        return
    import ctypes
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = [('Data1', wintypes.DWORD), ('Data2', wintypes.WORD),
                    ('Data3', wintypes.WORD), ('Data4', ctypes.c_ubyte * 8)]

    class PROPERTYKEY(ctypes.Structure):
        _fields_ = [('fmtid', GUID), ('pid', wintypes.DWORD)]

    class PROPVARIANT(ctypes.Structure):
        _fields_ = [('vt', wintypes.USHORT), ('reserved1', wintypes.USHORT),
                    ('reserved2', wintypes.USHORT), ('reserved3', wintypes.USHORT),
                    ('value', ctypes.c_void_p)]

    class IPropertyStore(ctypes.Structure):
        pass

    store_ptr = ctypes.POINTER(IPropertyStore)()
    iid = GUID(0x886D8EEB, 0x8CF2, 0x4446,
               (ctypes.c_ubyte * 8)(0x8D, 0x02, 0xCD, 0xBA, 0x1D, 0xBD, 0xCF, 0x99))
    key = PROPERTYKEY(
        GUID(0x9F4C2855, 0x9F79, 0x4B39,
             (ctypes.c_ubyte * 8)(0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3)), 5)
    shell32 = ctypes.WinDLL('shell32', use_last_error=True)
    shell32.SHGetPropertyStoreForWindow.argtypes = [wintypes.HWND, ctypes.POINTER(GUID),
                                                    ctypes.POINTER(ctypes.POINTER(IPropertyStore))]
    shell32.SHGetPropertyStoreForWindow.restype = ctypes.c_long
    hr = shell32.SHGetPropertyStoreForWindow(hwnd, ctypes.byref(iid), ctypes.byref(store_ptr))
    if hr < 0:
        raise OSError(f'SHGetPropertyStoreForWindow failed: 0x{hr & 0xffffffff:08X}')
    try:
        vtable = ctypes.cast(store_ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        set_value = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p,
                                       ctypes.POINTER(PROPERTYKEY), ctypes.POINTER(PROPVARIANT))(vtable[6])
        commit = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p)(vtable[7])
        string = ctypes.c_wchar_p(app_id)
        variant = PROPVARIANT(31, 0, 0, 0, ctypes.cast(string, ctypes.c_void_p))
        hr = set_value(store_ptr, ctypes.byref(key), ctypes.byref(variant))
        if hr < 0:
            raise OSError(f'IPropertyStore.SetValue failed: 0x{hr & 0xffffffff:08X}')
        hr = commit(store_ptr)
        if hr < 0:
            raise OSError(f'IPropertyStore.Commit failed: 0x{hr & 0xffffffff:08X}')
    finally:
        release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(
            ctypes.cast(store_ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents[2])
        release(store_ptr)


_windows_taskbar_icon_handles = []


def set_windows_window_icon(hwnd, icon_path):
    """Set both native window icons so the taskbar cannot fall back to pythonw.exe."""
    if os.name != 'nt' or not hwnd or not Path(icon_path).is_file():
        return
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
                                  ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.LoadImageW.restype = wintypes.HANDLE
    user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT,
                                    ctypes.c_size_t, ctypes.c_ssize_t]
    user32.SendMessageW.restype = ctypes.c_ssize_t
    image_icon = 1
    load_from_file_default_size = 0x10 | 0x40
    icon = user32.LoadImageW(None, str(icon_path), image_icon, 0, 0,
                             load_from_file_default_size)
    if not icon:
        raise ctypes.WinError(ctypes.get_last_error())
    # WM_SETICON: ICON_BIG=1 and ICON_SMALL=0. Keep the HICON alive for the window lifetime.
    user32.SendMessageW(hwnd, 0x0080, 1, icon)
    user32.SendMessageW(hwnd, 0x0080, 0, icon)
    _windows_taskbar_icon_handles.append(icon)


class ManualMinimizeOnly:
    """Allow minimization from the caption button, block keyboard/taskbar commands."""
    WM_SYSCOMMAND = 0x0112
    WM_NCLBUTTONDOWN = 0x00A1
    SC_MINIMIZE = 0xF020
    HTMINBUTTON = 8

    def __init__(self, root):
        import ctypes
        from ctypes import wintypes
        self.comctl32 = ctypes.WinDLL('comctl32', use_last_error=True)
        user32 = ctypes.WinDLL('user32', use_last_error=True)
        user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        user32.GetAncestor.restype = wintypes.HWND
        self.hwnd = user32.GetAncestor(root.winfo_id(), 2) or root.winfo_id()
        self.subclass_id = id(self)
        self.min_button_at = 0.0
        self.SUBCLASSPROC = ctypes.WINFUNCTYPE(
            ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, ctypes.c_size_t,
            ctypes.c_ssize_t, ctypes.c_size_t, ctypes.c_size_t)
        self.comctl32.DefSubclassProc.argtypes = [wintypes.HWND, wintypes.UINT,
                                                  ctypes.c_size_t, ctypes.c_ssize_t]
        self.comctl32.DefSubclassProc.restype = ctypes.c_ssize_t
        self.comctl32.SetWindowSubclass.argtypes = [wintypes.HWND, self.SUBCLASSPROC,
                                                     ctypes.c_size_t, ctypes.c_size_t]
        self.comctl32.SetWindowSubclass.restype = wintypes.BOOL
        self.comctl32.RemoveWindowSubclass.argtypes = [wintypes.HWND, self.SUBCLASSPROC,
                                                        ctypes.c_size_t]
        self.comctl32.RemoveWindowSubclass.restype = wintypes.BOOL
        self.callback = self.SUBCLASSPROC(self._window_proc)
        if not self.comctl32.SetWindowSubclass(self.hwnd, self.callback, self.subclass_id, 0):
            raise ctypes.WinError(ctypes.get_last_error())

    def _window_proc(self, hwnd, message, wparam, lparam, subclass_id, reference):
        import time
        if message == self.WM_NCLBUTTONDOWN and wparam == self.HTMINBUTTON:
            self.min_button_at = time.monotonic()
        elif message == self.WM_SYSCOMMAND and (wparam & 0xFFF0) == self.SC_MINIMIZE:
            # Only the native caption-button click is paired with this hit-test message.
            if time.monotonic() - self.min_button_at > 1.0:
                return 0
            self.min_button_at = 0.0
        return self.comctl32.DefSubclassProc(hwnd, message, wparam, lparam)

    def uninstall(self):
        if self.hwnd:
            self.comctl32.RemoveWindowSubclass(self.hwnd, self.callback, self.subclass_id)
            self.hwnd = None


def validate_canva_url(url):
    parts = urlparse(url.strip())
    if parts.scheme != 'https' or parts.hostname not in ('www.canva.com', 'canva.com') or not re.match(r'^/design/[^/]+', parts.path):
        raise ValueError('请填写 Canva 工程的 https 链接')
    return url.strip()


def validate_page(value):
    if not value.strip():
        return None
    if not value.strip().isdigit() or int(value) < 1:
        raise ValueError('Canva 页码必须是从 1 开始的整数')
    return int(value)


def drive_id(url):
    parts = urlparse(url)
    match = re.search(r'/d/([^/]+)', parts.path)
    return match.group(1) if match else parse_qs(parts.query).get('id', [url])[0]


def canonical_download_key(url):
    """Normalize common share/tracking variants so duplicate links share one transfer."""
    url = unwrap(url.strip())
    parts = urlsplit(url)
    host = (parts.hostname or '').lower().removeprefix('www.')
    if host in ('drive.google.com', 'docs.google.com'):
        return ('drive', drive_id(url))
    query = parse_qsl(parts.query, keep_blank_values=True)
    if host in ('youtube.com', 'm.youtube.com') and parts.path.rstrip('/') == '/watch':
        video_id = dict(query).get('v')
        if video_id:
            return ('youtube', video_id)
    tracking = {'igsh', 'feature', 'si', 'share_id', 'share_app_id', 'is_from_webapp', 'sender_device'}
    query = [(key, value) for key, value in query
             if key.casefold() not in tracking and not key.casefold().startswith('utm_')]
    return (host, parts.path.rstrip('/') or '/', tuple(sorted(query)))


def drive_quota_message(error):
    """Return a useful message for Google Drive's temporary download quota page."""
    text = str(error)
    quota_markers = (
        'too many users have viewed or downloaded this file recently',
        'download quota is exceeded',
        'quota exceeded for this file',
        'download quota exceeded',
        'quota has been exceeded',
        'google drive - quota exceeded',
    )
    if not any(marker in text.casefold() for marker in quota_markers):
        return None
    match = re.search(r'https?://drive\.google\.com/uc\?[^\s<>\"\']+', text, re.I)
    message = ('Google Drive 暂时限制了此文件的下载次数。程序已停止自动重试；请稍后再试（可能需要等待最多 24 小时），'
               '或在浏览器中打开文件链接。若仍无法下载，请联系文件所有者提供副本或新的分享链接。')
    return f'{message}\n浏览器链接：{match.group(0)}' if match else message


def drive_error_with_browser_link(error, url):
    """Keep the downloader's diagnostic and add a directly usable Drive link."""
    text = str(error)
    if '浏览器链接：' in text:
        return text
    browser_url = f'https://drive.google.com/file/d/{drive_id(url)}/view'
    lowered = text.casefold()
    if 'http 404' in lowered or '404 not found' in lowered:
        guidance = ('\nGoogle Drive 返回了 HTTP 404。链接可能输入有误、文件已删除，或当前访问方式没有查看权限；'
                    '请核对分享链接，并确认文件所有者允许当前账号访问。')
    elif 'winerror 10013' in lowered or 'wsaeacces' in lowered:
        guidance = ('\nWindows 拒绝了此程序连接 Google Drive 的 HTTPS 请求。请检查 Windows 防火墙或安全软件中“剪辑助手.exe”'
                    '的出站网络规则，以及单位/路由器的网络策略；保持防护开启，不要关闭防火墙来绕过拦截。')
    elif any(marker in lowered for marker in ('too many users have viewed or downloaded', 'download quota', 'quota exceeded')):
        guidance = '\nGoogle Drive 下载配额已耗尽，请稍后重试，或让文件所有者复制文件并提供新链接。'
    elif any(marker in lowered for marker in ('virus scan', 'unable to scan this file', 'cannot scan this file')):
        guidance = ('\nGoogle Drive 因文件较大而无法进行病毒扫描。请在浏览器提示页点击“仍然下载”继续；'
                    '自动下载时可尝试选择已登录且有权访问文件的浏览器 Cookie。')
    elif any(marker in lowered for marker in ('cannot retrieve the public link', 'permission', 'login', 'sign in', 'authentication')):
        guidance = ('\nGoogle Drive 拒绝了程序的匿名下载请求。请先在浏览器中登录有权访问该文件的 Google 账号，'
                    '并确认分享设置允许该账号查看和下载；然后在“更多设置 → 使用浏览器登录状态”选择已登录的浏览器，'
                    '或在更多设置中选择“Google Cookie 文件…”导入你指定账号导出的 Netscape Cookie。浏览器有多个账号时，请在 Google 账号头像菜单确认当前账号；若浏览器也无法下载，请联系文件所有者检查权限。')
    else:
        guidance = ('\nGoogle Drive 未提供可下载链接。请在浏览器中确认文件可访问，再在“更多设置 → 使用浏览器登录状态”'
                    '选择已登录的浏览器，或导入有权限账号的 Netscape Cookie 文件后重试。')
    return f'{text}{guidance}\n浏览器链接：{browser_url}'


def drive_auth_options(cookie, temporary):
    """Build explicit Google Drive cookie options; never silently use stale global cookies."""
    auth = {'use_cookies': bool(cookie)}
    if cookie:
        temporary = Path(temporary)
        temporary.mkdir(parents=True, exist_ok=True)
        cookie_copy = temporary / 'google-drive-login.txt'
        shutil.copyfile(cookie, cookie_copy)
        auth['cookies_file'] = str(cookie_copy)
    return auth


def gdrive_confirmation_url(contents, response_url):
    """Resolve Google Drive large-file virus-scan confirmation forms and links."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(contents, 'html.parser')
    form = soup.select_one('#download-form')
    if form is not None:
        action = urljoin(response_url, form.get('action') or response_url)
        query = list(parse_qsl(urlsplit(action).query, keep_blank_values=True))
        query.extend((field.get('name'), field.get('value', ''))
                     for field in form.select('input[type="hidden"][name]'))
        parts = urlsplit(action)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
    for selector in ('a[href*="confirm="]', 'a[href*="export=download"]',
                     'a[href*="download?id="]'):
        link = soup.select_one(selector)
        if link and link.get('href'):
            return urljoin(response_url, link['href'].replace('&amp;', '&'))
    return None


def gdrive_confirmation_fallback(url, cookie='', timeout=(20, 120)):
    """Follow the virus-scan confirmation flow exposed by Google Drive."""
    import requests
    from website_download import _PinnedAddressAdapter, _public_addresses

    def validate_drive_url(candidate):
        addresses = _public_addresses(candidate)
        host = (urlparse(candidate).hostname or '').lower().rstrip('.')
        allowed = ('google.com', 'googleusercontent.com', 'googleapis.com')
        if not any(host == domain or host.endswith('.' + domain) for domain in allowed):
            raise ValueError('Google Drive 确认链接跳转到了未经允许的域名')
        return addresses

    session = requests.Session()
    session.headers['User-Agent'] = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                                     'AppleWebKit/537.36 (KHTML, like Gecko) '
                                     'Chrome/131.0.0.0 Safari/537.36')
    if cookie:
        from http.cookiejar import MozillaCookieJar
        jar = MozillaCookieJar(str(cookie))
        jar.load(ignore_discard=True, ignore_expires=True)
        session.cookies.update(jar)
    current = url
    for _ in range(6):
        addresses = validate_drive_url(current)
        adapter = _PinnedAddressAdapter(addresses)
        session.mount('http://', adapter)
        session.mount('https://', adapter)
        response = session.get(current, timeout=timeout, allow_redirects=False)
        if response.status_code not in (301, 302, 303, 307, 308):
            if response.status_code == 404:
                response.close()
                raise RuntimeError(
                    'Google Drive 返回 HTTP 404：分享链接可能写错或已失效，'
                    '也可能因当前账号没有权限而不可见。请核对完整链接或分享权限。')
            response.raise_for_status()
            return gdrive_confirmation_url(response.text, response.url)
        location = response.headers.get('Location')
        response.close()
        if not location:
            raise RuntimeError('Google Drive 返回了不完整的确认跳转响应')
        current = urljoin(current, location)
    raise RuntimeError('Google Drive 确认链接跳转次数过多')


def drive_download_with_auth_retry(call, *, cookie, temporary, browser_auth=False, retry_args, **kwargs):
    """Retry a Drive URL retrieval failure once using the user's browser cookies."""
    from gdown.exceptions import FileURLRetrievalError
    try:
        return resolve_with_retry(call, **retry_args, **kwargs)
    except FileURLRetrievalError as first_error:
        # Resolve Drive's large-file warning page with the same credentials
        # as the download attempt. The warning may be shown even for public files.
        if cookie:
            target = gdrive_confirmation_fallback(kwargs['url'], cookie)
            if target:
                return resolve_with_retry(call, **retry_args, **{**kwargs, 'url': target})
            raise
        if not browser_auth:
            try:
                target = gdrive_confirmation_fallback(kwargs['url'])
            except Exception as confirmation_error:
                if 'http 404' in str(confirmation_error).casefold():
                    raise RuntimeError(str(confirmation_error)) from first_error
                raise first_error
            if target:
                return resolve_with_retry(call, **retry_args, **{**kwargs, 'url': target})
            raise first_error
        # gdown's browser-cookie import handles Firefox and older Chromium
        # profiles. Windows Chrome 127+ encrypts cookies so extraction may fail.
        try:
            from yt_dlp.cookies import extract_cookies_from_browser
            jar = None
            browser_error = None
            browsers = (browser_auth,) if isinstance(browser_auth, str) else ('firefox', 'edge', 'chrome')
            for browser in browsers:
                try:
                    candidate = extract_cookies_from_browser(browser)
                    if any(cookie.domain == '.google.com' or cookie.domain.endswith('.google.com')
                           for cookie in candidate):
                        jar = candidate
                        break
                except Exception as exc:
                    browser_error = exc
                    continue
            if jar is None:
                if browser_error and ('failed to decrypt with dpapi' in str(browser_error).casefold()
                                      or '10927' in str(browser_error)):
                    raise RuntimeError(
                        'Chrome Cookie 使用 DPAPI/应用绑定加密，当前 yt-dlp 无法解密；退出 Chrome 不能解决。'
                        '请在 Chrome 中登录有权访问文件的 Google 账号，用 Chrome Web Store 的本地 Cookie 导出扩展导出 Google Cookie，'
                        '然后在“更多设置 → 选择 Google Cookie 文件…”导入。'
                        f'\n详情：{browser_error}') from browser_error
                raise RuntimeError(
                    '没有从浏览器读取到 Google 登录 Cookie。若文件在浏览器中能打开，请在已登录且有权限的 Chrome 中'
                    '导出 Google Cookie 文件，再到“更多设置 → 选择 Google Cookie 文件…”导入。'
                    '若浏览器也无法打开，请让文件所有者将共享权限设为“知道链接的任何人”；若 Drive 提示下载次数过多，则需等待配额恢复。'
                    + (f'\n浏览器读取详情：{browser_error}' if browser_error else ''))
            temporary = Path(temporary)
            temporary.mkdir(parents=True, exist_ok=True)
            cookie_file = temporary / 'google-drive-browser-cookies.txt'
            jar.save(str(cookie_file))
            auth = {'use_cookies': True, 'cookies_file': str(cookie_file)}
            try:
                return resolve_with_retry(call, **retry_args, **kwargs, **auth)
            except FileURLRetrievalError:
                target = gdrive_confirmation_fallback(kwargs['url'], cookie_file)
                if not target:
                    raise
                return resolve_with_retry(call, **retry_args, **{**kwargs, 'url': target}, **auth)
        except Exception as auth_error:
            raise RuntimeError(
                f'{first_error}\n\n已尝试自动读取浏览器 Google 登录状态，但未能使用。'
                f'若自动读取失败，请在“更多设置 → 使用浏览器登录状态”选择已登录的浏览器，'
                f'或导入 Netscape 格式的 Google Cookie 文件。\n自动读取详情：{auth_error}'
            ) from first_error


def resolve_with_retry(call, stop_event, on_retry=None, **kwargs):
    import requests
    for attempt in range(3):
        try:
            return call(**kwargs)
        except Exception as exc:
            quota_message = drive_quota_message(exc)
            if quota_message:
                raise RuntimeError(quota_message) from exc
            # Drive confirmation pages can fail transiently even when the file
            # opens in a browser. Retry retrieval errors as well as transport
            # failures, while quota errors above still stop immediately.
            transient = isinstance(exc, (requests.exceptions.Timeout, requests.exceptions.ConnectionError)) or type(exc).__name__ == 'FileURLRetrievalError'
            if stop_event.is_set() or not transient or attempt == 2:
                raise
            if on_retry:
                on_retry(attempt + 1, exc)
            if stop_event.wait(2 * (attempt + 1)):
                raise RuntimeError('任务已取消')


def drive_item(url, name, temporary, folder, cancel, progress, cookie='', on_retry=None, on_wait=None, max_bytes=2 * 1024 * 1024 * 1024, browser_auth=False, output_stem=None, output_index=0, output_total=1, ffprobe=None):
    """Download each Drive file once per batch and copy it to other destinations."""
    import gdown
    key = drive_id(url)
    with _drive_guard:
        lock = _drive_locks.setdefault(key, threading.Lock())
    wait_started = time.monotonic()
    wait_notified = False
    while not lock.acquire(timeout=0.2):
        if cancel.is_set():
            raise RuntimeError('任务已取消')
        if time.monotonic() - wait_started >= 300:
            raise TimeoutError('等待同一 Google Drive 文件的另一个任务超过 5 分钟，已停止本任务。')
        if on_wait and not wait_notified and time.monotonic() - wait_started >= 10:
            on_wait()
            wait_notified = True
    try:
        if cancel.is_set():
            raise RuntimeError('任务已取消')
        saved = _drive_completed.get(key)
        if saved and saved.is_file():
            saved = repair_video_suffix(saved, ffprobe)
            _drive_completed[key] = saved
            output_name = video_output_filename(saved.name)
            copied = publish_file(saved, folder, output_name)
            return copied is None
        auth = drive_auth_options(cookie, temporary)
        if name is None:
            metadata = drive_download_with_auth_retry(
                gdown.download, cookie=cookie, temporary=temporary, browser_auth=browser_auth,
                retry_args={'stop_event': cancel, 'on_retry': on_retry},
                url=url, skip_download=True, quiet=True, cancel=cancel,
                timeout=(20, 120), **auth)
            name = metadata.path
        filename = safe_video_filename(name)
        output_name = video_output_filename(filename)
        target = folder / output_name
        if target.is_file():
            repair_video_suffix(target, ffprobe)
            return True
        def bounded_progress(done, total):
            if done > max_bytes:
                cancel.set()
                raise RuntimeError('视频超过单文件 2 GiB 下载上限')
            progress(done,total)
        try:
            result = drive_download_with_auth_retry(
                gdown.download, cookie=cookie, temporary=temporary,
                retry_args={'stop_event': cancel, 'on_retry': on_retry},
                url=url, output=str(temporary / filename), quiet=True,
                progress=bounded_progress, cancel=cancel, timeout=(20, 120), retries=1, **auth)
        except Exception as exc:
            quota_message = drive_quota_message(exc)
            if quota_message:
                raise RuntimeError(drive_error_with_browser_link(quota_message, url)) from exc
            raise RuntimeError(drive_error_with_browser_link(exc, url)) from exc
        if not result or not Path(result).is_file():
            raise RuntimeError('文件未成功保存，请检查分享权限或配额')
        source = repair_video_suffix(Path(result), ffprobe)
        output_name = video_output_filename(source.name)
        published = publish_file(source, folder, output_name)
        if published:
            _drive_completed[key] = published
        return published is None
    finally:
        lock.release()


def extract_urls(text):
    text = html.unescape(text)
    matches = re.findall(r'https?://(?:(?!https?://)[^\s\x00-\x20\"\'<>“”‘’，。；、（）【】])+', text, re.I)
    urls = []
    for match in matches:
        url = match.rstrip('.,;:!?)]}')
        try:
            unwrap(url)
        except ValueError:
            continue
        if url not in urls:
            urls.append(url)
    return urls


def strip_title_hashtags(value):
    """Keep the title text before its first social hashtag."""
    text = str(value or '').replace('＃', '#')
    return text.split('#', 1)[0].rstrip()


class _ClipboardLinkParser(HTMLParser):
    """Read link targets from Google Sheets rich clipboard HTML."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.table_rows = []
        self.row = None
        self.cell = None
        self.standalone = []
        self.standalone_text = []
        self.ignored_depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('style', 'script'):
            self.ignored_depth += 1
        elif tag == 'tr':
            self.row = []
            self.table_rows.append(self.row)
        elif tag in ('td', 'th') and self.row is not None:
            self.cell = {'links': [], 'text': []}
            self.row.append(self.cell)
        elif tag == 'a' and attrs.get('href'):
            href = html.unescape(attrs['href']).strip()
            if self.cell is not None:
                self.cell['links'].append(href)
            else:
                self.standalone.append(href)
        elif tag == 'br':
            if self.cell is not None:
                self.cell['text'].append('\n')
            else:
                self.standalone_text.append('\n')

    def handle_endtag(self, tag):
        if tag in ('style', 'script') and self.ignored_depth:
            self.ignored_depth -= 1
        elif tag in ('td', 'th'):
            self.cell = None
        elif tag == 'tr':
            self.row = None

    def handle_data(self, data):
        if self.ignored_depth:
            return
        if self.cell is not None:
            self.cell['text'].append(data)
        else:
            self.standalone_text.append(data)


def clipboard_matrix(plain_text, fragment):
    """Parse copied cells while keeping their hidden rich-link targets."""
    parser = _ClipboardLinkParser()
    try:
        parser.feed(fragment or '')
        parser.close()
    except Exception:
        parser = _ClipboardLinkParser()

    if parser.table_rows:
        return [[{'text': ''.join(cell['text']).strip(),
                  'links': list(dict.fromkeys(url for href in cell['links'] for url in extract_urls(href)))}
                 for cell in row] for row in parser.table_rows]

    if parser.standalone:
        links = list(dict.fromkeys(url for href in parser.standalone for url in extract_urls(href)))
        visible = str(plain_text or '').strip().strip('"')
        if not visible:
            visible = ''.join(parser.standalone_text).strip()
        return [[{'text': visible, 'links': links}]]

    text = str(plain_text or '').replace('\r\n', '\n').replace('\r', '\n')
    if not text.strip():
        return []
    try:
        values = list(csv.reader(io.StringIO(text), delimiter='\t', quotechar='"'))
    except csv.Error:
        values = [line.split('\t') for line in text.split('\n')]
    while values and not any(str(value).strip() for value in values[-1]):
        values.pop()
    return [[{'text': str(value).strip(), 'links': []} for value in row] for row in values]


def clipboard_field_rows(matrix):
    """Map a copied header row plus data rows to the download form fields."""
    if not matrix or not matrix[0]:
        return []
    headers = [re.sub(r'[\s：:（）()_/-]+', '', str(cell.get('text', '')).casefold())
               for cell in matrix[0]]
    columns = {}

    def find_column(field, aliases):
        for alias in aliases:
            alias = re.sub(r'[\s：:（）()_/-]+', '', alias.casefold())
            for index, header in enumerate(headers):
                is_header = header == alias
                if field == 'phone' and alias == '需求备注' and '需求备注' in header:
                    is_header = True
                if field == 'link' and '视频' in header and '链接' in header:
                    is_header = True
                if is_header:
                    return index
        return None

    columns['name'] = find_column('name', ('演员', '人名', '演员姓名', '人物', '姓名'))
    columns['phone'] = find_column('phone', ('电话号码', '电话', '号码', '需求备注'))
    columns['title'] = find_column('title', ('文案标题', '视频名称', '标题', '拍摄文案中文',
                                            '拍摄文案英文', '画面标题'))
    columns['link'] = find_column('link', ('拍摄视频链接', '视频链接地址', '视频链接', '视频URL'))
    columns = {field: index for field, index in columns.items() if index is not None}
    if not columns:
        # A compact four-column paste without headers follows the download
        # table's visible order: person, phone, title, video links.
        if all(len(row) == 4 and extract_urls(
                ' | '.join(row[3].get('links', []) or [row[3].get('text', '')]))
               for row in matrix):
            return [{'name': row[0].get('text', '').strip(),
                     'phone': row[1].get('text', '').strip(),
                     'title': row[2].get('text', '').strip(),
                     'link': ' | '.join(row[3].get('links', []) or extract_urls(row[3].get('text', '')))}
                    for row in matrix]
        return []

    result = []
    for row in matrix[1:]:
        values = {}
        for field, column in columns.items():
            if column >= len(row):
                continue
            cell = row[column]
            values[field] = (' | '.join(cell['links']) if field == 'link' and cell['links']
                             else str(cell.get('text', '')).strip())
        if any(cell.get('text') or cell.get('links') for cell in row):
            result.append(values)
    return result


def clipboard_link_groups(fragment):
    """Return one URL group per copied linked cell; reject ambiguous multi-column copies."""
    matrix = clipboard_matrix('', fragment)
    if not matrix:
        return []
    groups = []
    for row in matrix:
        linked_cells = [cell['links'] for cell in row if cell['links']]
        if len(linked_cells) > 1:
            return []
        groups.append(list(dict.fromkeys(linked_cells[0])) if linked_cells else [])
    return groups if any(groups) else []


def _clipboard_diagnostic(message):
    """Write clipboard diagnostics without storing clipboard contents or URLs."""
    try:
        profile = Path(os.environ.get('USERPROFILE') or Path.home())
        log_dir = profile / 'Documents' / 'ChatGPT' / '剪辑助手' / '用户数据' / '运行配置' / 'logs'
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / ('clipboard-' + datetime.now().strftime('%Y%m%d') + '.log')
        with log_path.open('a', encoding='utf-8') as stream:
            stream.write(f'{datetime.now().isoformat(timespec="milliseconds")} {message}\n')
    except OSError:
        pass


def _clipboard_format_label(user32, format_id):
    standard = {1: 'CF_TEXT', 2: 'CF_BITMAP', 3: 'CF_METAFILEPICT', 8: 'CF_DIB',
                13: 'CF_UNICODETEXT', 15: 'CF_HDROP', 16: 'CF_LOCALE', 17: 'CF_DIBV5'}
    if format_id in standard:
        return standard[format_id]
    name = ctypes.create_unicode_buffer(256)
    length = user32.GetClipboardFormatNameW(format_id, name, len(name))
    return name.value if length else f'FORMAT_{format_id}'


def _clipboard_bytes(user32, kernel32, format_id):
    handle = user32.GetClipboardData(format_id) if format_id else None
    if not handle:
        return b''
    size = kernel32.GlobalSize(handle)
    if not size or size > 32 * 1024 * 1024:
        return b''
    pointer = kernel32.GlobalLock(handle)
    if not pointer:
        return b''
    try:
        raw = ctypes.string_at(pointer, size)
        if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
            while raw.endswith(b'\0\0'):
                raw = raw[:-2]
            return raw
        return raw.rstrip(b'\0')
    finally:
        kernel32.GlobalUnlock(handle)


def _decode_clipboard_html(raw, cf_html=False):
    if not raw:
        return ''
    if cf_html:
        header = raw[:4096].decode('ascii', 'ignore')
        start_match = re.search(r'StartFragment:(\d+)', header)
        end_match = re.search(r'EndFragment:(\d+)', header)
        if start_match and end_match:
            start, end = int(start_match.group(1)), int(end_match.group(1))
            if 0 <= start <= end <= len(raw):
                raw = raw[start:end]
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
        return raw.decode('utf-16', 'replace').strip('\x00')
    return raw.decode('utf-8-sig', 'replace').strip('\x00')


def _clipboard_json_urls(raw):
    """Extract link targets from Sheets' private rich-cell clipboard payload."""
    if not raw:
        return []
    try:
        payload = json.loads(raw.decode('utf-8-sig', 'replace').strip('\x00'))
    except (UnicodeError, ValueError, TypeError):
        return []
    urls = []

    def visit(value):
        if isinstance(value, str):
            for url in extract_urls(value):
                if url not in urls:
                    urls.append(url)
        elif isinstance(value, dict):
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload)
    return urls


def _sheets_clipboard_json_fragment(raw):
    urls = _clipboard_json_urls(raw)
    if not urls:
        return ''
    anchors = ''.join(f'<a href="{html.escape(url, quote=True)}">link</a><br>' for url in urls)
    return f'<table><tr><td>{anchors}</td></tr></table>'


def read_clipboard_html():
    """Read rich Windows clipboard HTML, with a Google Sheets link-chip fallback."""
    if os.name != 'nt':
        return ''
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL('user32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
    user32.RegisterClipboardFormatW.restype = wintypes.UINT
    user32.EnumClipboardFormats.argtypes = [wintypes.UINT]
    user32.EnumClipboardFormats.restype = wintypes.UINT
    user32.GetClipboardFormatNameW.argtypes = [wintypes.UINT, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClipboardFormatNameW.restype = ctypes.c_int
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalSize.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalSize.restype = ctypes.c_size_t
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL

    if not user32.OpenClipboard(None):
        _clipboard_diagnostic('open_failed')
        return ''
    try:
        available = []
        current = 0
        while True:
            current = user32.EnumClipboardFormats(current)
            if not current:
                break
            available.append((current, _clipboard_format_label(user32, current)))
            if len(available) >= 100:
                break

        registered = {
            name: user32.RegisterClipboardFormatW(name)
            for name in ('HTML Format', 'text/html',
                         'application/x-vnd.google-spreadsheet-compact-table+json')
        }
        present_ids = {format_id for format_id, _ in available}
        sizes = []
        candidates = []
        for name, format_id in registered.items():
            if not format_id or format_id not in present_ids:
                continue
            raw = _clipboard_bytes(user32, kernel32, format_id)
            sizes.append(f'{name}:{len(raw)}')
            if name in ('HTML Format', 'text/html'):
                fragment = _decode_clipboard_html(raw, cf_html=(name == 'HTML Format'))
                if fragment:
                    candidates.append((fragment, len(extract_urls(fragment))))
            else:
                fragment = _sheets_clipboard_json_fragment(raw)
                if fragment:
                    candidates.append((fragment, len(_clipboard_json_urls(raw))))

        # Prefer a rich HTML fragment which contains hrefs. If the HTML format
        # only carries visible labels, use the private Sheets payload instead.
        candidates.sort(key=lambda item: item[1], reverse=True)
        chosen = candidates[0] if candidates else ('', 0)
        labels = ','.join(label for _, label in available)
        _clipboard_diagnostic(
            f'read formats=[{labels}] sizes=[{",".join(sizes)}] '
            f'rich_links={chosen[1]} result={"rich" if chosen[1] else "plain_only"}')
        return chosen[0]
    except (OSError, ValueError, ctypes.ArgumentError):
        _clipboard_diagnostic('read_failed')
        return ''
    finally:
        user32.CloseClipboard()


def task_rows(base, rows):
    if not base.strip():
        raise ValueError('请选择保存位置')
    tasks = []
    for index, (person, title, text) in enumerate(rows, 1):
        if not any(value.strip() for value in (person, title, text)):
            continue
        urls = extract_urls(text)
        if text.strip() and not urls:
            raise ValueError(f'第 {index} 行：没有识别到有效的视频链接')
        person=person.strip();title=strip_title_hashtags(title).strip()
        # Rows are independent: any combination of person, title, phone and
        # URL is valid. Missing naming fields get stable per-row placeholders.
        name = folder_name(person or f'第{index}行', title or '引流')
        path=destination(base,name)
        if urls:
            for link_index, url in enumerate(urls, 1):
                tasks.append((index - 1, name, url, path, link_index, len(urls)))
            continue
        # A missing URL means this row can still produce its title/promo art;
        # keep it in the same per-person / per-video-name folder as linked rows.
        tasks.append((index - 1, name.strip(), '', path, 1, 1))
    if not tasks:
        raise ValueError('请至少填写一行内容')
    return tasks


def task_pairs(base, rows):
    """Compatibility projection used by preflight helpers and legacy callers."""
    return [(name, url, path) for _, name, url, path, _, _ in task_rows(base, rows)]


def group_download_jobs(batch):
    """Download identical links once while retaining every row as a recipient."""
    groups = {}
    standalone = []
    for job in batch:
        _, url, _, settings = job
        if not url:
            standalone.append(job)
            continue
        try:
            identity = canonical_download_key(url)
        except Exception:
            identity = ('url', url.strip().casefold())
        retry_denoise = bool(settings[5]) if len(settings) > 5 else False
        if retry_denoise:
            identity = (identity, 'retry', int(settings[4]), 'denoise')
        else:
            identity = (identity, 'new')
        groups.setdefault(identity, []).append(job)
    return list(groups.values()), standalone


def plan_link_fill(text, current_links):
    seen = {url for value in current_links for url in extract_urls(value)}
    groups = []
    for line in str(text or '').splitlines():
        urls = []
        for url in extract_urls(line):
            if url in seen:
                continue
            seen.add(url)
            urls.append(url)
        if urls:
            groups.append(urls)
    empty = [index for index, value in enumerate(current_links) if not value.strip()]
    if not groups:
        raise ValueError('未识别到新链接；已填入的重复链接会被忽略。')
    if len(groups) > len(empty):
        raise ValueError(f'识别到 {len(groups)} 组视频链接，只有 {len(empty)} 个空行；请减少内容或清空不需要的行。')
    return [(index, ' | '.join(urls)) for index, urls in zip(empty, groups)]


def folder_name(person, title):
    def clean(value):
        value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', value).strip().rstrip('. ')
        if not value:
            raise ValueError('清理特殊字符后名称为空，请填写人名和视频名称')
        return value
    return f'{clean(person)}-{clean(title)}'


def media_name(person, title, generated_at=None, fallback='未命名'):
    """Build a readable, collision-resistant name that fits common Windows paths."""
    person = str(person or '').strip() or fallback
    title = str(title or '').strip() or '引流'
    generated_at = generated_at or datetime.now()
    timestamp = generated_at.strftime('%Y%m%d-%H%M%S-%f')
    base = folder_name(person, title)
    if len(base) > 40:
        suffix=hashlib.sha256(base.encode('utf-8')).hexdigest()[:8]
        base=f'{base[:31].rstrip(". ")}-{suffix}'
    return f'{base}-{timestamp}'


def video_output_filename(source_name):
    """Keep a video's downloaded source filename, cleaning only Windows-invalid characters."""
    return safe_video_filename(Path(str(source_name)).name)


def repair_video_suffix(path, ffprobe):
    """Detect a suffix-less Drive download by its container and append a usable suffix."""
    path = Path(path)
    if path.suffix.lower() in VIDEO_SUFFIXES:
        return path
    ffprobe = Path(ffprobe) if ffprobe else None
    if not ffprobe or not ffprobe.is_file():
        raise RuntimeError(f'下载文件“{path.name}”没有可识别的视频尾缀，且 FFprobe 不可用，无法确认文件格式。')
    try:
        result = subprocess.run(
            [str(ffprobe), '-v', 'error', '-show_entries',
             'format=format_name:format_tags=major_brand:stream=codec_type,width,height:stream_disposition=attached_pic',
             '-of', 'json', str(path)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', timeout=20,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=False)
        data = json.loads(result.stdout) if result.returncode == 0 else {}
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        data = {}

    streams = data.get('streams') or []
    has_video = any(
        stream.get('codec_type') == 'video'
        and str(stream.get('width') or '').isdigit()
        and str(stream.get('height') or '').isdigit()
        and int(stream.get('width') or 0) > 0
        and int(stream.get('height') or 0) > 0
        and str((stream.get('disposition') or {}).get('attached_pic', '0')).lower() not in {'1', 'true'}
        for stream in streams)
    if not has_video:
        raise RuntimeError(f'下载文件“{path.name}”尾缀不完整，且文件内容未能识别为有效视频。')

    format_data = data.get('format') or {}
    formats = {item.strip().lower() for item in str(format_data.get('format_name') or '').split(',')}
    brand = str((format_data.get('tags') or {}).get('major_brand') or '').lower()
    suffix = None
    if 'webm' in formats:
        suffix = '.webm'
    elif 'matroska' in formats:
        suffix = '.mkv'
    elif 'avi' in formats:
        suffix = '.avi'
    elif 'mpegts' in formats:
        suffix = '.ts'
    elif formats.intersection({'mpeg', 'mpegvideo'}):
        suffix = '.mpg'
    elif 'asf' in formats:
        suffix = '.wmv'
    elif 'flv' in formats:
        suffix = '.flv'
    elif 'ogg' in formats:
        suffix = '.ogv'
    elif 'vob' in formats:
        suffix = '.vob'
    elif formats.intersection({'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'}):
        suffix = '.3gp' if brand.startswith(('3gp', '3g')) else '.mov' if brand.startswith('qt') else '.m4v' if brand.startswith('m4v') else '.mp4'
    if not suffix:
        raise RuntimeError(f'已确认“{path.name}”包含视频，但暂不支持自动补全该容器格式的尾缀。')

    target = path.with_suffix(suffix)
    index = 2
    while target.exists() and target.resolve() != path.resolve():
        target = path.with_name(f'{path.stem}-{index}{suffix}')
        index += 1
    if target.resolve() != path.resolve():
        path.rename(target)
    return target


def local_video_files(folder):
    return sorted((item for item in Path(folder).iterdir()
                   if item.is_file() and item.suffix.lower() in VIDEO_SUFFIXES),
                  key=lambda item: item.name.casefold())


def safe_video_filename(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', str(name)).strip().rstrip('. ')
    if not name or name in ('.', '..'):
        name = 'video.mp4'
    stem, suffix = os.path.splitext(name)
    if stem.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}:
        stem = '_' + stem
    # Leave room for downloader partial-file suffixes and Windows path limits.
    return stem[:100].rstrip('. ') + suffix[:16]


def unwrap(url):
    for _ in range(5):
        parts = urlparse(url)
        if parts.scheme not in ('http', 'https') or not parts.hostname:
            raise ValueError('请输入完整的 http 或 https 链接')
        if parts.hostname in ('l.facebook.com', 'lm.facebook.com', 'l.instagram.com'):
            target = parse_qs(parts.query).get('u', [None])[0]
            if target:
                url = target
                continue
        return url
    raise ValueError('链接跳转层数过多')


def checked_public_redirects(url, session=None, max_redirects=5):
    """Resolve an HTTP URL while validating each destination before contacting it."""
    from website_download import _PinnedAddressAdapter, _public_addresses
    import requests
    owns_session=session is None
    session=session or requests.Session()
    current=url
    try:
        for _ in range(max_redirects+1):
            adapter=_PinnedAddressAdapter(_public_addresses(current))
            session.mount('http://',adapter)
            session.mount('https://',adapter)
            response=session.get(current,stream=True,timeout=25,allow_redirects=False)
            if response.status_code not in (301,302,303,307,308):
                return current
            location=response.headers.get('Location')
            response.close()
            if not location:
                raise RuntimeError('下载服务器返回了不完整的跳转响应')
            from urllib.parse import urljoin
            current=unwrap(urljoin(current,location))
        raise RuntimeError('下载链接跳转次数过多')
    finally:
        if owns_session:session.close()


def destination(base, name):
    name = name.strip()
    if not name or name in ('.', '..') or re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or name.endswith(('.', ' ')):
        raise ValueError('文件夹名称为空或包含不允许的字符')
    if name.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}:
        raise ValueError('此文件夹名称是 Windows 保留名称')
    return Path(base).expanduser().resolve() / name


def publish_file(source, folder, name=None):
    """Keep existing files and skip identical filenames without creating numbered copies."""
    source = Path(source)
    target = folder / safe_video_filename(name) if name else folder / source.name
    if target.exists():
        if not target.is_file():
            raise RuntimeError(f'目标名称被文件夹占用：{target.name}')
        return None
    try:
        output = target.open('xb')
    except FileExistsError:
        if not target.is_file():
            raise RuntimeError(f'目标名称被文件夹占用：{target.name}')
        return None
    except PermissionError as exc:
        # Some Windows file states (read-only or held open without sharing)
        # report ACCESS_DENIED instead of FILE_EXISTS for exclusive creation.
        if target.is_file():
            return None
        raise PermissionError(
            f'无法写入目标文件：{target}\n请检查保存文件夹的写入权限，或在软件中改选其他下载位置。'
        ) from exc
    try:
        with output, source.open('rb') as input_file:
            shutil.copyfileobj(input_file, output)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target


def replace_published_file(source, folder, name=None):
    """Atomically publish a shared batch result, replacing that row's prior copy."""
    source = Path(source)
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / safe_video_filename(name) if name else folder / source.name
    if source.resolve() == target.resolve():
        return target
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.clipassistant-copy-', suffix='.tmp',
                                         dir=folder, delete=False) as staged:
            temporary = Path(staged.name)
            with source.open('rb') as input_file:
                shutil.copyfileobj(input_file, staged)
            staged.flush()
        os.replace(temporary, target)
        return target
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def update_processing_markers(marker_paths, state, detail=''):
    """Keep a small, readable per-link status file in each output folder."""
    if not marker_paths:
        return
    paths = marker_paths.values() if isinstance(marker_paths, dict) else marker_paths
    content = f'剪辑助手：{state}\n{str(detail or "").strip()[:300]}\n'
    for path in set(Path(item) for item in paths if item):
        try:
            path.write_text(content, encoding='utf-8')
        except OSError:
            # The task itself should continue even if Explorer status markers
            # cannot be written (for example, the destination became read-only).
            continue


class App:
    def __init__(self, root, *, host=None, resource_dir=None, editor_callback=None, cutout_callback=None):
        self.root = root
        self.host = host or root
        self.embedded = host is not None
        self.resource_dir = Path(resource_dir) if resource_dir else Path(
            getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[2])) / 'resources'
        self.editor_callback = editor_callback
        self.cutout_callback = cutout_callback
        self._stopped = False
        # The downloader remains alive while other pages are shown.  Keep
        # background widget construction paused when its page is hidden.
        self.view_active = True
        self._poll_id = None
        self.events = queue.Queue()
        self.jobs = {}
        self.active = False
        self.settings_path = settings_location()
        bundle_directory=(Path(getattr(sys,'_MEIPASS'))/'core'/'downloader_runtime'
                          if getattr(sys,'frozen',False) else Path(__file__).resolve().parent)
        seed_user_data(self.settings_path.parent,bundle_directory)
        rebase_local_fonts(self.settings_path.parent,bundle_directory)
        saved_settings = read_settings(self.settings_path)
        saved_title_colors=saved_settings.get('title_preview_colors')
        valid_title_colors=[value.lower() for value in saved_title_colors
                            if isinstance(value,str) and re.fullmatch(r'#[0-9a-fA-F]{6}',value)] if isinstance(saved_title_colors,list) else None
        self.title_color_swatches=(valid_title_colors[:16] if valid_title_colors is not None else
                                   ['#e15f35','#ffd43b','#ffffff','#141414',
                                    '#68a9a2','#4d83c5','#9a70c5','#e25555'])
        self.title_font_choices = None
        # The embedded downloader shares the app-wide DaVinci dark theme.
        self.appearance = tk.StringVar(value='深色')
        self.cache_path = self.settings_path.parent / 'canva-page-audit.json'
        if self.cache_path.is_file():
            from page_cache import anonymize_template_names
            anonymize_template_names(self.cache_path)
        self.theme = tk.StringVar(value='白天')
        self.layout = tk.StringVar(value='自动')
        self.resolution = tk.StringVar(value='1080x1920')
        try:
            saved_denoise = max(0, min(100, int(saved_settings.get('denoise_strength', 30))))
        except (TypeError, ValueError):
            saved_denoise = 30
        self.global_denoise = tk.IntVar(value=saved_denoise)
        if not self.embedded:
            root.title('剪辑助手')
            screen_height=root.winfo_screenheight()
            root.geometry(f'1120x{min(1360, max(980, screen_height - 80))}')
            root.resizable(True, True)
        window_width=max(760, root.winfo_width())
        style = ttk.Style(root)
        if not self.embedded:
            style.theme_use('clam')
            style.configure('.', font=('Microsoft YaHei UI', 10))
            style.configure('TButton', padding=3)
        topbar = ttk.Frame(self.host, padding=(10, 3), style='Toolbar.TFrame')
        topbar.pack(fill='x')
        ttk.Label(topbar, text='下载任务', style='Toolbar.TLabel',
                  font=('Microsoft YaHei UI', 10, 'bold')).pack(side='left', padx=6)
        self.refresh_button = ttk.Button(topbar, text='刷新', command=self.refresh_task_list,
                                         takefocus=False)
        self.refresh_button.pack(side='right', padx=(0, 6))
        self.refresh_feedback_after = None
        panel = ttk.Frame(self.host, padding=(16, 12))
        panel.pack(fill='both', expand=True)
        header = ttk.Frame(panel)
        header.pack(fill='x')
        label_row = ttk.Frame(header)
        label_row.pack(fill='x')
        ttk.Label(label_row, text='批量链接', style='Muted.TLabel').pack(side='left')
        self.extract_button = ttk.Button(label_row, text='识别并填入', command=self.fill_bulk_links)
        self.extract_button.pack(side='right')
        text_row = ttk.Frame(header)
        text_row.pack(fill='x', pady=(6, 0))
        dark_palette = PALETTES['深色']
        self.bulk_text = tk.Text(
            text_row, height=3, width=1, wrap='word',
            background=dark_palette['field'], foreground=dark_palette['fg'],
            insertbackground=dark_palette['fg'], selectbackground=dark_palette['select'],
            selectforeground='#ffffff', font=('Segoe UI', 10), undo=True,
            relief='flat', borderwidth=0, highlightthickness=1,
            highlightbackground=dark_palette['border'],
            highlightcolor=dark_palette['border'], padx=10, pady=8,
        )
        self.bulk_text.pack(side='left', fill='x', expand=True)
        row = ttk.Frame(panel)
        row.pack(fill='x', pady=(12, 8))
        self.base = tk.StringVar(value=str(Path.home() / 'Downloads'))
        ttk.Label(row, text='保存位置', style='Muted.TLabel', width=7).pack(side='left')
        self.base_entry = ttk.Entry(row, textvariable=self.base, justify='left', style='Path.TEntry')
        self.base_entry.pack(side='left', fill='x', expand=True, padx=8)
        self.dir_button = icon_button(row, 'folder', '选择保存目录', self.choose_dir)
        self.dir_button.pack(side='left')
        template_row = ttk.Frame(panel)
        template_row.pack(fill='x', pady=(0, 4))
        ttk.Label(template_row, text='图片配色', style='Muted.TLabel', width=7).pack(side='left')
        theme_pick=ttk.Combobox(template_row, textvariable=self.theme, values=['白天', '黑天'], state='readonly', width=5)
        theme_pick.pack(side='left', padx=4)
        theme_pick.bind('<<ComboboxSelected>>',lambda _:messagebox.showinfo('配色说明','白天: 白色文字底板, 黑色文字, 橙色高亮.\n黑天: 黑色文字底板, 白色文字, 黄色高亮.\nPNG 画布外部保持透明.',parent=self.root))
        ttk.Combobox(template_row, textvariable=self.layout, values=['自动', '两行', '三行', '四行'], state='readonly', width=5).pack(side='left')
        ttk.Button(template_row, text='引流模板', width=7, command=self.open_page_data).pack(side='left', padx=4)
        ttk.Button(template_row, text='抠图区域', width=8, command=self._open_cutout).pack(side='left', padx=(0, 4))
        noise_row = ttk.Frame(panel)
        noise_row.pack(fill='x', pady=(4, 6))
        ttk.Label(noise_row, text='全局降噪', style='Muted.TLabel', width=7).pack(side='left')
        self.denoise_scale = ttk.Scale(noise_row, from_=0, to=100, variable=self.global_denoise,
                                       style='Horizontal.TScale',
                                       command=self._update_denoise_label)
        self.denoise_scale.pack(side='left', fill='x', expand=True, padx=(4, 8))
        bind_scale_wheel(self.denoise_scale, step=1)
        self.denoise_label = ttk.Label(noise_row, text='30%', width=5, style='Muted.TLabel')
        self.denoise_label.configure(text=f'{self.global_denoise.get()}%')
        self.denoise_label.pack(side='left')
        ttk.Label(noise_row, text='每行可单独设置', style='Muted.TLabel').pack(side='left', padx=(8, 0))
        ttk.Separator(panel).pack(fill='x', pady=(10, 6))
        task_box=tk.Frame(panel,background=PALETTES['深色']['bg'],bd=0,highlightthickness=0)
        task_box.pack(fill='both',expand=True,pady=(0,6))
        task_content=ttk.Frame(task_box,padding=0)
        task_content.pack(fill='both',expand=True)
        header_form = ttk.Frame(task_content)
        header_form.pack(fill='x', pady=(0, 2))
        for column, text in enumerate(('序号', '人名', '号码', '视频名称', '视频链接', '语言', '降噪', '进度', '清空')):
            ttk.Label(header_form, text=text, style='Muted.TLabel').grid(row=0, column=column, sticky='w', padx=4, pady=(0, 8))
        column_weights=(0,1,1,2,3,0,0,0,0)
        column_minimums=(34,56,72,76,110,68,52,128,42) if window_width<900 else ((40,65,84,92,130,72,58,138,44) if window_width<1120 else (48,85,112,130,180,78,64,148,46))
        for column,(weight,minimum) in enumerate(zip(column_weights,column_minimums)):
            header_form.columnconfigure(column,weight=weight,minsize=minimum)
        self.rows=[];self.row_statuses=[];self.row_clear_buttons=[]
        self.page_vars=[];self.language_vars=[];self.title_layout_vars=[];self.denoise_vars=[];self.denoise_picks=[];self.auto_page_values=[];self.auto_page_people=[];self.page_match_issues=[]
        self.template_translation_cache_path=self.settings_path.parent/'lead-template-translations.json'
        self.template_translation_cache=load_translation_cache(self.template_translation_cache_path)
        self.translation_pending=False
        self.suggested_page_values=[];self.match_jobs={};self.page_entries=[]
        self.title_entries=[];self.title_font_paths=[];self.title_color_ranges=[]
        self.title_last_values=[];self.title_selection_ranges=[];self.title_manual_lines=[]
        self.phone_vars=[];self.phone_source_numbers=[];self.original_phone_values=[];self.auto_phone_values=[]
        self.background_vars=[];self.background_checks=[];self.progress_labels=[];self.input_entries=[];self.title_layout_picks=[]
        self.title_preview_popup=None;self.title_preview_image_label=None;self.title_preview_heading=None
        self.title_preview_manual_text=None;self.title_preview_manual_syncing=False
        self.title_preview_photo=None;self.title_preview_index=None
        self.title_preview_font_var=None;self.title_preview_font_pick=None
        self.title_font_interaction=False;self.title_font_interaction_after=None
        self.title_preview_palette=None;self.title_preview_hint=None
        self.title_preview_after=None;self.title_preview_hide_after=None
        for variable in (self.theme,self.layout,self.resolution):
            variable.trace_add('write',lambda *_:self.refresh_active_title_preview())
        table=ttk.Frame(task_content);table.pack(fill='both',expand=True)
        self.task_table=table
        table.grid_rowconfigure(0,weight=1)
        table.grid_columnconfigure(0,weight=1)
        self.row_form=ttk.Frame(table)
        self.row_form.grid(row=0,column=0,sticky='nsew')
        for column,(weight,minimum) in enumerate(zip(column_weights,column_minimums)):
            self.row_form.columnconfigure(column,weight=weight,minsize=minimum)
            header_form.columnconfigure(column,weight=weight,minsize=minimum)
        self.rows_ready = False
        self.row_build_after = None
        for entry in self.input_entries:
            entry.bind('<FocusOut>', lambda event: event.widget.xview_moveto(0), add='+')
            entry.bind('<<Paste>>', lambda event: self.root.after(10, lambda widget=event.widget: widget.xview_moveto(0)))
        footer = ttk.Frame(self.host, padding=(12, 8), style='Toolbar.TFrame')
        footer.pack(side='bottom', fill='x', before=panel)
        row = ttk.Frame(footer, style='Toolbar.TFrame')
        row.pack(fill='x')
        self.count = tk.StringVar(value='3')
        self.quality = tk.StringVar(value='最佳原始流（下载后处理）')
        self.cookies = tk.StringVar()
        self.cookie_temp = None
        self.start_button = ttk.Button(row, text='开始下载', command=self.start, style='Primary.TButton')
        self.start_button.pack(side='left')
        icon_button(row, 'cancel', '取消下载', self.cancel).pack(side='left', padx=(8, 0))
        ttk.Separator(row, orient='vertical').pack(side='left', fill='y', padx=10, pady=6)
        icon_button(row, 'undo', '撤销编辑', lambda: self.restore_edit(False)).pack(side='left')
        icon_button(row, 'redo', '重做编辑', lambda: self.restore_edit(True)).pack(side='left')
        # Keep post-download actions on the existing control row. Adding a
        # second packed row only when the batch finishes resized the footer,
        # forcing the large download form to repaint and look like a reset.
        self.completion_actions = ttk.Frame(row, style='Toolbar.TFrame')
        ttk.Button(self.completion_actions, text='打开剪辑功能', command=self._open_editor,
                   style='Primary.TButton').pack(side='left', padx=(0, 6))
        more, menu = icon_menu(topbar, 'more', '更多设置')
        more.pack(side='right')
        browser_login = DarkPopupMenu(menu, PALETTES['深色'])
        for browser, label in (('edge', 'Microsoft Edge'), ('chrome', 'Google Chrome'),
                               ('firefox', 'Firefox')):
            browser_login.add_command(label=label, command=lambda b=browser: self.use_browser_login(b))
        menu.add_cascade(label='使用浏览器登录状态', menu=browser_login)
        menu.add_command(label='选择 Google Cookie 文件…', command=self.choose_cookie)
        menu.add_separator()
        concurrent = DarkPopupMenu(menu, PALETTES['深色'])
        for value in range(1, 11):
            concurrent.add_radiobutton(label=f'{value} 个', variable=self.count, value=str(value))
        menu.add_cascade(label='同时下载数量', menu=concurrent)
        menu.add_command(label='重试失败任务', command=self.retry)
        menu.add_command(label='查看失败原因', command=self.show_errors)
        menu.add_command(label='打开保存位置', command=self.open_dir)
        sizes = DarkPopupMenu(menu, PALETTES['深色'])
        for value in ('1080x1920','1440x2560'):
            sizes.add_radiobutton(label=value, variable=self.resolution, value=value)
        menu.add_cascade(label='竖版 PNG 分辨率', menu=sizes)
        self.popup_menus = (menu, browser_login, concurrent, sizes)
        self.exit_on_finish = tk.BooleanVar(value=False)
        self.clear_button = icon_button(row, 'clear', '清空下载列表', self.clear_list)
        self.clear_button.pack(side='right')
        status_area=ttk.Frame(footer,height=34,style='Toolbar.TFrame')
        status_area.pack(fill='x',pady=(6,0));status_area.pack_propagate(False)
        self.status = ttk.Label(status_area, text='就绪', wraplength=540, style='ToolbarMuted.TLabel')
        self.status.pack(fill='both',expand=True)
        footer.bind('<Configure>', lambda event: self.status.configure(wraplength=max(100,event.width-24)))
        self._poll_id = root.after(150, self.poll)
        self.completion_actions.pack_forget()
        if not self.embedded:
            root.protocol('WM_DELETE_WINDOW', self.close)
        self.undo_stack = []
        self.redo_stack = []
        self.history_paused = True
        self.last_snapshot = self.snapshot()
        for values in self.rows:
            for variable in values:
                variable.trace_add('write', lambda *_: self.record_edit())
        for variable in (*self.page_vars, *self.language_vars, *self.phone_vars,*self.title_layout_vars,*self.denoise_vars):
            variable.trace_add('write', lambda *_: self.record_edit())
        for variable in self.background_vars:
            variable.trace_add('write',lambda *_:self.record_edit())
        self.bulk_text.bind('<<Modified>>', self.bulk_changed)
        self.bulk_text.bind('<<Paste>>', self.paste_rich_links, add='+')
        for widget in [self.bulk_text, *self.input_entries, *self.title_layout_picks, *self.denoise_picks]:
            widget.bind('<Control-z>', lambda event: self.restore_edit(False))
            widget.bind('<Control-y>', lambda event: self.restore_edit(True))
            widget.bind('<Control-Shift-Z>', lambda event: self.restore_edit(True))
            widget.bind('<Control-a>', self.select_all)
        if not self.embedded:
            apply_appearance(root, '深色')
        if not self.embedded:
            root.after(1000, lambda: sync_appearance(self))
        self.start_button.configure(state='disabled')
        self.extract_button.configure(state='disabled')
        self.row_build_after = root.after_idle(self._build_task_rows_slice)

    def _build_task_rows_slice(self):
        self.row_build_after = None
        if self._stopped or not self.host.winfo_exists():
            return
        # One row per event-loop turn keeps navigation and text entry
        # responsive.  Previously each batch rebound every existing cell and
        # each new row recomputed a full history snapshot, producing quadratic
        # work on Tk's UI thread.
        self.add_task_row()
        if len(self.rows) < 12:
            self.row_build_after = self.root.after(1, self._build_task_rows_slice)
            return
        self.rows_ready = True
        self.history_paused = False
        self.last_snapshot = self.snapshot()
        self.start_button.configure(state='normal')
        self.extract_button.configure(state='normal')

    def set_view_active(self, active):
        active = bool(active)
        if active == self.view_active:
            return
        self.view_active = active
        if not self.view_active:
            # Native Tk menus are separate popup windows. If navigation hides
            # the downloader while a cascade is open, it can remain on-screen
            # at its old coordinates over the editor or project home.
            for popup in getattr(self, 'popup_menus', ()):
                try:
                    popup._root_menu._close()
                except (AttributeError, tk.TclError):
                    pass
            self.hide_title_preview()
        elif (self.view_active and not self.rows_ready and self.row_build_after is None
              and not self._stopped and self.host.winfo_exists()):
            self.row_build_after = self.root.after_idle(self._build_task_rows_slice)

    def _update_denoise_label(self, _value=None):
        self.denoise_label.configure(text=f'{int(float(self.global_denoise.get()))}%')

    def _open_editor(self):
        if self.editor_callback:
            self.editor_callback()

    def _open_cutout(self):
        if self.cutout_callback:
            self.cutout_callback()

    def destroy_embedded(self):
        if not self.embedded or self._stopped:
            return
        self._stopped = True
        if self._poll_id is not None:
            try:
                self.root.after_cancel(self._poll_id)
            except tk.TclError:
                pass
        if self.row_build_after is not None:
            try:
                self.root.after_cancel(self.row_build_after)
            except tk.TclError:
                pass
            self.row_build_after = None
        if self.refresh_feedback_after is not None:
            try:self.root.after_cancel(self.refresh_feedback_after)
            except tk.TclError:pass
            self.refresh_feedback_after=None
        for job in tuple(self.match_jobs.values()):
            try:
                self.root.after_cancel(job)
            except tk.TclError:
                pass
        self.match_jobs.clear()
        self.hide_title_preview()
        if self.cookie_temp is not None:
            self.cookie_temp.cleanup()
        self.host.destroy()

    def add_task_row(self):
        if getattr(self,'active',False):
            self.status.config(text='下载期间不能增加任务行。')
            return
        index=len(self.rows);row=self.row_form;grid_row=index*2
        row.rowconfigure(grid_row+1,weight=1,minsize=34)
        separator=ttk.Separator(row)
        separator.grid(row=grid_row,column=0,columnspan=9,sticky='sew')
        name,title,link=tk.StringVar(),tk.StringVar(),tk.StringVar()
        page,phone=tk.StringVar(value='1'),tk.StringVar()
        language=tk.StringVar(value=DEFAULT_LANGUAGE)
        background=tk.BooleanVar(value=False)
        title_layout=tk.StringVar(value='全局')
        denoise=tk.StringVar(value='全局')
        self.rows.append((name,title,link));self.page_vars.append(page);self.language_vars.append(language);self.phone_vars.append(phone);self.title_layout_vars.append(title_layout)
        self.row_statuses.append('待下载')
        self.title_entries.append(None);self.title_font_paths.append('');self.title_color_ranges.append([])
        self.title_last_values.append(title.get());self.title_selection_ranges.append(None)
        self.title_manual_lines.append(None)
        self.denoise_vars.append(denoise)
        self.background_vars.append(background);self.auto_page_values.append('');self.auto_page_people.append('');self.page_match_issues.append('')
        self.suggested_page_values.append('');self.phone_source_numbers.append(None)
        self.original_phone_values.append('');self.auto_phone_values.append('')
        number_label=ttk.Label(row,text=f'{index+1:02}',style='Muted.TLabel',anchor='w')
        number_label.grid(row=grid_row+1,column=0,padx=6,sticky='w')
        name_entry=ttk.Entry(row,textvariable=name,width=7,justify='left',style='Cell.TEntry')
        name_entry.grid(row=grid_row+1,column=1,sticky='ew',pady=4,padx=3)
        name_entry.bind('<<Paste>>',lambda event,i=index:self.paste_column_values(event,i,'name'),add='+')
        phone_entry=ttk.Entry(row,textvariable=phone,width=15,justify='left',style='Cell.TEntry')
        phone_entry.grid(row=grid_row+1,column=2,sticky='ew',padx=3,pady=4)
        phone_entry.bind('<<Paste>>',lambda event,i=index:self.paste_column_values(event,i,'phone'),add='+')
        title_cell=ttk.Frame(row)
        title_cell.grid(row=grid_row+1,column=3,sticky='ew',padx=3,pady=4)
        title_cell.columnconfigure(0,weight=1)
        title_entry=ttk.Entry(title_cell,textvariable=title,width=10,justify='left',style='Cell.TEntry')
        title_entry.grid(row=0,column=0,sticky='ew')
        title_entry.bind('<<Paste>>',lambda event,i=index:self.paste_column_values(event,i,'title'),add='+')
        self.title_entries[index]=title_entry
        title_layout_pick=ttk.Combobox(title_cell,textvariable=title_layout,values=['全局','1行','2行','3行','4行'],state='readonly',width=4)
        title_layout_pick.grid(row=0,column=1,sticky='e',padx=(3,0))
        self.title_layout_picks.append(title_layout_pick)
        ToolTip(title_layout_pick,'只调整本行标题：跟随全局，或至少排成 1、2、3、4 行；当前行数放不下时会自动增加到四行。悬停标题可查看最终效果。')
        link_entry=ttk.Entry(row,textvariable=link,width=10,justify='left',style='Cell.TEntry')
        link_entry.grid(row=grid_row+1,column=4,sticky='ew',padx=3,pady=4)
        link_entry.bind('<<Paste>>',lambda event,i=index:self.paste_column_values(event,i,'link'),add='+')
        ToolTip(link_entry,'可粘贴多个视频链接；同一行内的链接分别下载到同一人名-视频名称文件夹。直接从 Google 表格复制时会读取单元格里的真实链接地址。')
        page_entry=ttk.Combobox(row,textvariable=language,values=list(LANGUAGES),state='readonly',width=8,style='Cell.TEntry')
        page_entry.grid(row=grid_row+1,column=5,sticky='ew',padx=3,pady=4)
        page_entry.bind('<<ComboboxSelected>>',lambda _,i=index:self.preview_page(i))
        denoise_pick=ttk.Combobox(row,textvariable=denoise,
                                  values=['全局']+[f'{value}%' for value in range(0,101)],
                                  state='readonly',width=5,style='Cell.TEntry')
        denoise_pick.grid(row=grid_row+1,column=6,sticky='ew',padx=3,pady=4)
        self.denoise_picks.append(denoise_pick)
        progress=ttk.Label(row,text=self.row_statuses[index],width=18,anchor='w',style='Muted.TLabel')
        progress.grid(row=grid_row+1,column=7,sticky='w',padx=2)
        clear_row_button=icon_button(row,'clear','清空本行（保留已下载文件）',
                                     lambda i=index:self.clear_task_row(i))
        clear_row_button.grid(row=grid_row+1,column=8,sticky='w',padx=(1,3))
        self.row_clear_buttons.append(clear_row_button)
        self.page_entries.append(page_entry);self.progress_labels.append(progress)
        self.input_entries.extend((name_entry,phone_entry,title_entry,link_entry,page_entry))
        name_entry.bind('<FocusIn>',lambda _,i=index:self.preview_folder(i))
        page_entry.bind('<FocusIn>',lambda _,i=index:self.preview_page(i))
        page_entry.bind('<KeyRelease>',lambda _,i=index:self.preview_page(i))
        page_entry.bind('<FocusOut>',lambda _,i=index:self.load_matched_phone(i),add='+')
        phone_entry.bind('<FocusIn>',lambda _,i=index:self.preview_page(i))
        phone_entry.bind('<FocusOut>',lambda _,i=index:self.format_phone_cell(i),add='+')
        phone.trace_add('write',lambda *_,i=index:self.preview_page(i))
        for entry in (name_entry,title_entry,link_entry):
            entry.bind('<FocusIn>',lambda _,i=index:self.preview_folder(i))
            entry.bind('<KeyRelease>',lambda _,i=index:self.preview_folder(i),add='+')
        title_entry.bind('<Enter>',lambda _,i=index:self.schedule_title_preview(i),add='+')
        title_entry.bind('<Leave>',lambda _:self.schedule_title_preview_close(),add='+')
        title_entry.bind('<FocusOut>',lambda _,i=index:self.clean_title_field(i),add='+')
        title_entry.bind('<ButtonRelease-1>',lambda _,i=index:self.root.after_idle(lambda:self._capture_title_selection(i)),add='+')
        title_entry.bind('<KeyRelease>',lambda _,i=index:self.root.after_idle(lambda:self._capture_title_selection(i)),add='+')
        title_entry.bind('<KeyRelease>',lambda _,i=index:self.schedule_title_preview(i,180),add='+')
        title_entry.bind('<<Paste>>',lambda _,i=index:self.schedule_title_preview(i,80),add='+')
        title.trace_add('write',lambda *_,i=index:self.refresh_title_preview(i))
        title_layout.trace_add('write',lambda *_,i=index:self._title_layout_changed(i))
        page.trace_add('write',lambda *_,i=index:self.refresh_title_preview(i))
        phone.trace_add('write',lambda *_,i=index:self.refresh_title_preview(i))
        ToolTip(phone_entry,'生成标题图时用此号码替换所选模板中的号码；留空则使用模板原号码。')
        ToolTip(page_entry,'选择本行引流文案的语种。英语使用原文；其他语种会在开始下载/生成图片时翻译文案，号码和模板样式保持不变。')
        ToolTip(progress,lambda label=progress:label.cget('text'))
        if hasattr(self,'last_snapshot'):
            for variable in (name,title,link,page,language,phone,background,title_layout,denoise):
                variable.trace_add('write',lambda *_:self.record_edit())
            for widget in (name_entry,phone_entry,title_entry,link_entry,page_entry):
                widget.bind('<Control-z>',lambda event:self.restore_edit(False))
                widget.bind('<Control-y>',lambda event:self.restore_edit(True))
                widget.bind('<Control-Shift-Z>',lambda event:self.restore_edit(True))
                widget.bind('<Control-a>',self.select_all)
                widget.bind('<FocusOut>',lambda event:event.widget.xview_moveto(0),add='+')
                widget.bind('<<Paste>>',lambda event,w=widget:self.root.after(10,lambda:w.xview_moveto(0)),add='+')
        return index

    def schedule_title_preview(self,index,delay=280):
        if self.title_preview_hide_after is not None:
            try:self.root.after_cancel(self.title_preview_hide_after)
            except tk.TclError:pass
            self.title_preview_hide_after=None
        if self.title_preview_after is not None:
            try:self.root.after_cancel(self.title_preview_after)
            except tk.TclError:pass
        self.title_preview_after=self.root.after(delay,lambda i=index:self.show_title_preview(i))

    def refresh_title_preview(self,index):
        if index is not None and 0 <= index < len(self.title_last_values):
            current=self.rows[index][1].get()
            previous=self.title_last_values[index]
            if current!=previous:
                self.title_color_ranges[index]=self._remap_title_ranges(
                    previous,current,self.title_color_ranges[index])
                self.title_last_values[index]=current
            if self.title_manual_lines[index] is not None:
                from local_design import normalize_manual_title_lines
                try:
                    self.title_manual_lines[index]=normalize_manual_title_lines(
                        current,self.title_manual_lines[index])
                except ValueError:
                    self.title_manual_lines[index]=None
        if index is not None and self.title_preview_index==index:
            self.schedule_title_preview(index,180)

    def clean_title_field(self, index):
        title = self.rows[index][1]
        raw = title.get()
        cleaned = strip_title_hashtags(raw)
        if cleaned != raw:
            title.set(cleaned)
            self.status.config(text='已从视频标题中移除 # 后面的标签。')

    def _title_layout_changed(self,index):
        if self.title_manual_lines[index] is not None:
            self.title_manual_lines[index]=None
        self.refresh_title_preview(index)

    def _sync_title_manual_editor(self,lines):
        editor=self.title_preview_manual_text
        if editor is None or not editor.winfo_exists():return
        try:
            if self.root.focus_get() is editor:return
        except tk.TclError:pass
        self.title_preview_manual_syncing=True
        editor.delete('1.0','end')
        if lines:editor.insert('1.0','\n'.join(lines))
        self.title_preview_manual_syncing=False

    def _title_manual_lines_changed(self,_event=None):
        if self.title_preview_manual_syncing or self.title_preview_manual_text is None:return
        index=self.title_preview_index
        if index is None:return
        raw_title=self.rows[index][1].get()
        lines=self.title_preview_manual_text.get('1.0','end-1c').splitlines()
        from local_design import normalize_manual_title_lines
        try:
            normalized=normalize_manual_title_lines(raw_title,lines)
        except ValueError as exc:
            if self.title_preview_hint is not None:
                self.title_preview_hint.configure(text=str(exc))
            return
        if normalized!=self.title_manual_lines[index]:
            self.record_edit()
            self.title_manual_lines[index]=normalized
            self.record_edit()
            if self.title_preview_hint is not None:
                self.title_preview_hint.configure(text=f'手动分行已应用 · {len(normalized)} 行；只调整换行')
            self.schedule_title_preview(index,100)

    def _reset_title_manual_lines(self):
        index=self.title_preview_index
        if index is None:return
        if self.title_manual_lines[index] is not None:
            self.record_edit()
            self.title_manual_lines[index]=None
            self.record_edit()
        if self.title_preview_hint is not None:
            self.title_preview_hint.configure(text='已恢复自动分行；可在上方文字框按 Enter 调整换行。')
        self.schedule_title_preview(index,80)

    @staticmethod
    def _remap_title_ranges(previous,current,ranges):
        """Keep formatting on unchanged characters when a title is edited."""
        if not previous or not current or not ranges:return []
        matcher=difflib.SequenceMatcher(a=previous,b=current,autojunk=False)
        mapped=[]
        for start,end,color in ranges:
            for old_start,new_start,length in matcher.get_matching_blocks():
                left=max(start,old_start);right=min(end,old_start+length)
                if left<right:mapped.append((new_start+left-old_start,new_start+right-old_start,color))
        return ClipAssistant._merge_title_ranges(mapped)

    @staticmethod
    def _merge_title_ranges(ranges):
        merged=[]
        for start,end,color in sorted((int(a),int(b),str(c).lower()) for a,b,c in ranges if int(b)>int(a)):
            if merged and merged[-1][2]==color and start<=merged[-1][1]:
                merged[-1]=(merged[-1][0],max(merged[-1][1],end),color)
            else:merged.append((start,end,color))
        return merged

    def _capture_title_selection(self,index):
        if index is None or index>=len(self.title_entries):return
        entry=self.title_entries[index]
        try:
            if entry.selection_present():
                self.title_selection_ranges[index]=(entry.index('sel.first'),entry.index('sel.last'))
        except (tk.TclError,IndexError):pass

    def _apply_title_color(self,index,color):
        if index is None:return
        self._capture_title_selection(index)
        selected=self.title_selection_ranges[index]
        if not selected or selected[0]>=selected[1]:
            self.status.configure(text='先在“视频名称”中选中要改色的单词或字母，再点颜色色块。')
            return
        start,end=selected
        existing=self.title_color_ranges[index]
        updated=[]
        for old_start,old_end,old_color in existing:
            if old_end<=start or old_start>=end:
                updated.append((old_start,old_end,old_color))
            else:
                if old_start<start:updated.append((old_start,start,old_color))
                if old_end>end:updated.append((end,old_end,old_color))
        updated.append((start,end,color))
        self.record_edit()
        self.title_color_ranges[index]=self._merge_title_ranges(updated)
        self.record_edit()
        self.refresh_title_preview(index)

    def _add_title_color(self):
        if not self.title_preview_popup or not self.title_preview_popup.winfo_exists():return
        from color_picker import askcolor
        _,chosen=askcolor(parent=self.title_preview_popup)
        if not chosen:return
        chosen=chosen.lower()
        if chosen not in self.title_color_swatches:
            self.title_color_swatches=[chosen,*self.title_color_swatches][:16]
            update_settings(self.settings_path,title_preview_colors=self.title_color_swatches)
        self._render_title_color_swatches()
        self._apply_title_color(self.title_preview_index,chosen)

    def _remove_title_color(self,color):
        self.title_color_swatches=[value for value in self.title_color_swatches if value!=color]
        update_settings(self.settings_path,title_preview_colors=self.title_color_swatches)
        self._render_title_color_swatches()

    def _render_title_color_swatches(self):
        panel=self.title_preview_palette
        if panel is None or not panel.winfo_exists():return
        for child in panel.winfo_children():child.destroy()
        for index,color in enumerate(self.title_color_swatches[:16]):
            chip=tk.Button(panel,text=' ',width=2,height=1,background=color,activebackground=color,
                           relief='flat',bd=0,highlightthickness=1,highlightbackground='#70757d',
                           cursor='hand2',command=lambda chosen=color:self._apply_title_color(self.title_preview_index,chosen))
            chip.grid(row=index//8,column=index%8,padx=2,pady=2,sticky='ew')
            chip.bind('<Button-3>',lambda _event,chosen=color:self._remove_title_color(chosen))
        add=tk.Button(panel,text='+',width=3,background='#292d31',foreground='#f0f2f4',
                      activebackground='#3a4046',activeforeground='#ffffff',relief='flat',
                      highlightthickness=1,highlightbackground='#555b63',cursor='hand2',
                      command=self._add_title_color)
        add.grid(row=0,column=8,rowspan=2,padx=(5,0),sticky='ns')

    def _title_font_changed(self,_event=None):
        index=self.title_preview_index
        if index is None or self.title_preview_font_var is None:return
        if self.title_font_choices is None:
            from local_design import system_fonts
            self.title_font_choices=system_fonts()
        selection=self.title_preview_font_var.get()
        chosen='' if selection=='模板默认' else self.title_font_choices.get(selection,'')
        if chosen and not Path(chosen).is_file():
            self._end_title_font_interaction()
            self.status.config(text=f'字体文件不可用：{chosen}')
            return
        # Keep the exact path returned by system_fonts(): the preview uses it
        # to restore the selected family name in the read-only combobox.
        chosen=str(chosen) if chosen else ''
        self._end_title_font_interaction()
        if chosen==self.title_font_paths[index]:return
        self.record_edit()
        self.title_font_paths[index]=chosen
        self.record_edit()
        self.schedule_title_preview(index,80)

    def _decorate_title_design(self,design,index,raw_title):
        result=dict(design)
        if self.title_font_paths[index]:result['font_path']=self.title_font_paths[index]
        if self.title_manual_lines[index] is not None:
            from local_design import normalize_manual_title_lines
            result['manual_title_lines']=normalize_manual_title_lines(
                raw_title,self.title_manual_lines[index])
        leading=len(raw_title)-len(raw_title.lstrip())
        title_length=len(raw_title.strip())
        result['custom_text_ranges']=[
            {'start':max(0,start-leading),'end':min(title_length,end-leading),'color':color}
            for start,end,color in self.title_color_ranges[index]
            if min(title_length,end-leading)>max(0,start-leading)
        ]
        return result

    def refresh_active_title_preview(self):
        self.refresh_title_preview(self.title_preview_index)

    def schedule_title_preview_close(self):
        # The ttk combobox list is a separate native popup window. When it opens,
        # the pointer leaves this override-redirect preview; keep the preview
        # alive long enough for a font choice to complete.
        if self.title_font_interaction:
            return
        if self.title_preview_after is not None:
            try:self.root.after_cancel(self.title_preview_after)
            except tk.TclError:pass
            self.title_preview_after=None
        if self.title_preview_hide_after is not None:
            try:self.root.after_cancel(self.title_preview_hide_after)
            except tk.TclError:pass
        self.title_preview_hide_after=self.root.after(420,self.hide_title_preview)

    def hide_title_preview(self):
        self.title_preview_hide_after=None
        self._end_title_font_interaction()
        self.title_preview_index=None
        if self.title_preview_popup is not None:
            try:self.title_preview_popup.destroy()
            except tk.TclError:pass
        self.title_preview_popup=None;self.title_preview_image_label=None;self.title_preview_heading=None
        self.title_preview_font_var=None;self.title_preview_font_pick=None
        self.title_preview_manual_text=None;self.title_preview_manual_syncing=False
        self.title_preview_palette=None;self.title_preview_hint=None
        self.title_preview_photo=None

    def title_preview_design(self,index):
        from page_cache import page_design,read_pages,read_style,page_number_for_position
        theme=self.theme.get();layout=self.layout.get()
        position=self.page_vars[index].get().strip()
        design=None
        if position:
            pages=read_pages(self.cache_path)
            try:number=page_number_for_position(pages,position)
            except ValueError:number=None
            if number is not None:
                try:
                    design=page_design(pages,number,theme,layout,read_style(self.cache_path),
                                       phone_override=self.phone_vars[index].get())
                except ValueError:
                    design=page_design(pages,number,theme,layout,read_style(self.cache_path))
        if design is None:
            design={'footer':'','phone':'','theme':theme,'layout':layout,'top':850,
                    'background':'#ffffff','radius':22,'padding':16,
                    'lines':[{'size':52,'bold':True,'runs':[]}]}
            design.update(read_style(self.cache_path))
            design.update(theme=theme,layout=layout)
        override={'1行':'单行','2行':'两行','3行':'三行','4行':'四行'}.get(self.title_layout_vars[index].get())
        if override:
            design['layout']=override;design['layout_exact']=True
        return design

    def supplied_phone(self,index):
        """Return only a user-entered phone, ignoring the page's auto-filled default."""
        value=self.phone_vars[index].get().strip()
        automatic=self.auto_phone_values[index].strip()
        if not value or value==automatic:return ''
        from page_cache import format_phone_like
        formatted=format_phone_like(automatic or '+1',value)
        if formatted!=value:self.phone_vars[index].set(formatted)
        return '' if formatted==automatic else formatted

    def show_title_preview(self,index):
        self.title_preview_after=None
        self.title_preview_index=index
        popup=self.title_preview_popup
        if popup is None or not popup.winfo_exists():
            popup=tk.Toplevel(self.root)
            popup.overrideredirect(True)
            popup.transient(self.root)
            popup.configure(background='#30343a')
            frame=tk.Frame(popup,background='#30343a',padx=8,pady=7,
                           highlightthickness=1,highlightbackground='#7c848e')
            frame.pack()
            self.title_preview_heading=tk.Label(frame,text='',anchor='w',
                background='#30343a',foreground='white',font=('Microsoft YaHei UI',10,'bold'))
            self.title_preview_heading.pack(fill='x',pady=(0,5))
            if self.title_font_choices is None:
                from local_design import system_fonts
                self.title_font_choices=system_fonts()
            self.title_preview_font_var=tk.StringVar(master=popup,value='模板默认')
            font_row=ttk.Frame(frame)
            font_row.pack(fill='x',pady=(0,5))
            ttk.Label(font_row,text='标题字体').pack(side='left',padx=(0,5))
            self.title_preview_font_pick=ttk.Combobox(
                font_row,textvariable=self.title_preview_font_var,
                values=['模板默认',*self.title_font_choices.keys()],state='readonly',width=22)
            self.title_preview_font_pick.pack(side='left',fill='x',expand=True)
            self.title_preview_font_pick.bind('<<ComboboxSelected>>',self._title_font_changed)
            self.title_preview_font_pick.bind('<ButtonPress-1>',self._begin_title_font_interaction,add='+')
            self.title_preview_font_pick.bind('<KeyPress-Down>',self._begin_title_font_interaction,add='+')
            self.title_preview_font_pick.bind('<Escape>',lambda _e:self._end_title_font_interaction(),add='+')
            manual_row=tk.Frame(frame,background='#30343a')
            manual_row.pack(fill='x',pady=(0,5))
            manual_label=tk.Label(manual_row,text='手动分行',anchor='w',
                background='#30343a',foreground='#c2c7cf',font=('Microsoft YaHei UI',9))
            manual_label.pack(anchor='w')
            manual_controls=tk.Frame(manual_row,background='#30343a')
            manual_controls.pack(fill='x')
            self.title_preview_manual_text=tk.Text(
                manual_controls,height=4,width=34,wrap='word',
                background='#1c1f23',foreground='#f0f2f4',insertbackground='#f0f2f4',
                selectbackground='#3d668f',selectforeground='#ffffff',
                font=('Microsoft YaHei UI',9),relief='flat',borderwidth=0,
                highlightthickness=1,highlightbackground='#555b63',
                padx=6,pady=4,undo=True)
            self.title_preview_manual_text.pack(side='left',fill='x',expand=True)
            self.title_preview_manual_text.bind('<KeyRelease>',self._title_manual_lines_changed,add='+')
            self.title_preview_manual_text.bind('<<Paste>>',self._title_manual_lines_changed,add='+')
            reset_manual=tk.Button(manual_controls,text='自动分行',command=self._reset_title_manual_lines,
                background='#292d31',foreground='#f0f2f4',activebackground='#3a4046',
                activeforeground='#ffffff',relief='flat',cursor='hand2',padx=6)
            reset_manual.pack(side='left',padx=(5,0))
            style_hint=tk.Label(frame,text='选中标题文字后点色块改色 · 右键删除 · ＋添加预设',anchor='w',
                background='#30343a',foreground='#c2c7cf',font=('Microsoft YaHei UI',9))
            style_hint.pack(fill='x',pady=(0,2))
            self.title_preview_palette=tk.Frame(frame,background='#30343a')
            self.title_preview_palette.pack(fill='x',pady=(0,5))
            self._render_title_color_swatches()
            self.title_preview_image_label=tk.Label(frame,text='',background='#454a51',
                foreground='#e5e7eb',font=('Microsoft YaHei UI',10),justify='center')
            self.title_preview_image_label.pack()
            self.title_preview_hint=tk.Label(frame,text='每行一段；只调整换行，文字需与标题一致（最多 4 行）',anchor='w',
                background='#30343a',foreground='#c2c7cf',font=('Microsoft YaHei UI',9))
            self.title_preview_hint.pack(fill='x',pady=(5,0))
            for widget in (popup,frame,self.title_preview_heading,self.title_preview_image_label,
                           self.title_preview_hint,font_row,self.title_preview_font_pick,
                           manual_row,manual_label,manual_controls,self.title_preview_manual_text,reset_manual,
                           style_hint,self.title_preview_palette):
                widget.bind('<Enter>',lambda _:self.cancel_title_preview_close(),add='+')
                widget.bind('<Leave>',lambda _:self.schedule_title_preview_close(),add='+')
            self.title_preview_popup=popup
        else:
            popup.deiconify()
        raw_title=self.rows[index][1].get()
        title=self.rows[index][1].get().strip()
        design_for_font=self.title_preview_design(index) if title else {}
        current_font=self.title_font_paths[index] or design_for_font.get('font_path','')
        selected_font=next((name for name,path in self.title_font_choices.items() if path==current_font),'模板默认')
        self.title_preview_font_var.set(selected_font)
        self.title_preview_font_pick.configure(values=['模板默认',*self.title_font_choices.keys()])
        if not title:
            self._sync_title_manual_editor([])
            self.title_preview_heading.config(text=f'第 {index+1} 行 · 标题预览')
            self.title_preview_image_label.config(image='',text='输入标题后显示最终排版')
            self.title_preview_photo=None
        else:
            try:
                from local_design import replace_title,render
                from PIL import Image, ImageTk
                from page_cache import read_pages,page_number_for_position
                position=self.page_vars[index].get().strip()
                pages=read_pages(self.cache_path)
                number=page_number_for_position(pages,position) if position else None
                template=self._decorate_title_design(design_for_font,index,raw_title)
                design=replace_title(template,title)
                self._sync_title_manual_editor([
                    ''.join(run['text'] for run in line['runs']) for line in design['lines']])
                image=render(design,output_size=self.resolution.get())
                self.title_preview_heading.config(text=f'第 {index+1} 行 · {len(design["lines"])} 行标题')
                if self.title_preview_hint is not None and self.title_manual_lines[index] is None:
                    self.title_preview_hint.configure(text='每行一段；只调整换行，文字需与标题一致（最多 4 行）')
                image.thumbnail((180,320),Image.Resampling.LANCZOS)
                self.title_preview_photo=ImageTk.PhotoImage(image,master=popup)
                self.title_preview_image_label.config(image=self.title_preview_photo,text='')
            except Exception as exc:
                self.title_preview_photo=None
                self.title_preview_heading.config(text=f'第 {index+1} 行 · 标题预览')
                self.title_preview_image_label.config(image='',text=f'预览暂不可用\n{exc}')
        popup.update_idletasks()
        width=max(270,popup.winfo_reqwidth());height=popup.winfo_reqheight()
        screen_width=self.root.winfo_screenwidth();screen_height=self.root.winfo_screenheight()
        root_left=self.root.winfo_rootx();root_right=root_left+self.root.winfo_width()
        anchor=self.title_entries[index]
        anchor_left=anchor.winfo_rootx();anchor_right=anchor_left+anchor.winfo_width()
        right_candidate=anchor_right+8
        left_candidate=anchor_left-width-8
        if right_candidate+width<=min(screen_width,root_right):x=right_candidate
        elif left_candidate>=max(0,root_left):x=left_candidate
        else:x=max(root_left+8,min(right_candidate,root_right-width-8))
        x=max(0,min(x,screen_width-width))
        anchor_y=anchor.winfo_rooty()
        y=max(0,min(anchor_y-12,screen_height-height-8))
        popup.geometry(f'+{x}+{y}')
        popup.lift()

    def cancel_title_preview_close(self):
        if self.title_preview_hide_after is not None:
            try:self.root.after_cancel(self.title_preview_hide_after)
            except tk.TclError:pass
            self.title_preview_hide_after=None

    def _begin_title_font_interaction(self, _event=None):
        self.title_font_interaction=True
        self.cancel_title_preview_close()
        if self.title_preview_after is not None:
            try:self.root.after_cancel(self.title_preview_after)
            except tk.TclError:pass
            self.title_preview_after=None
        if self.title_font_interaction_after is not None:
            try:self.root.after_cancel(self.title_font_interaction_after)
            except tk.TclError:pass
        self.title_font_interaction_after=self.root.after(5000,self._end_title_font_interaction)

    def _end_title_font_interaction(self):
        self.title_font_interaction=False
        if self.title_font_interaction_after is not None:
            try:self.root.after_cancel(self.title_font_interaction_after)
            except tk.TclError:pass
        self.title_font_interaction_after=None

    def _set_row_progress(self,index,value):
        if index<0 or index>=len(self.row_statuses):return
        text=str(value)
        self.row_statuses[index]=text
        if index<len(self.progress_labels):
            try:self.progress_labels[index].config(text=text)
            except tk.TclError:pass

    def refresh_task_list(self):
        """Drain pending task events and redraw the fixed rows from UI state."""
        pending=self._poll_id
        if pending is not None:
            try:self.root.after_cancel(pending)
            except tk.TclError:pass
            self._poll_id=None
        self.poll()
        try:
            for label,value in zip(self.progress_labels,self.row_statuses):
                if label.winfo_exists():label.config(text=value)
        except tk.TclError:
            pass
        if self.refresh_feedback_after is not None:
            try:self.root.after_cancel(self.refresh_feedback_after)
            except tk.TclError:pass
        self.refresh_button.configure(text='已刷新')
        self.refresh_feedback_after=self.root.after(1000,self._reset_refresh_button)

    def _reset_refresh_button(self):
        self.refresh_feedback_after=None
        try:
            if self.refresh_button.winfo_exists():self.refresh_button.configure(text='刷新')
        except tk.TclError:pass

    def clear_task_row(self,index):
        if self.active:
            self.status.config(text='下载或降噪期间不能清空任务行。')
            return
        if index<0 or index>=len(self.rows):return
        self.record_edit()
        self.history_paused=True
        for variable in self.rows[index]:variable.set('')
        self.page_vars[index].set('1')
        self.language_vars[index].set(DEFAULT_LANGUAGE)
        self.phone_vars[index].set('')
        self.title_layout_vars[index].set('全局')
        self.denoise_vars[index].set('全局')
        self.background_vars[index].set(False)
        self.title_font_paths[index]=''
        self.title_color_ranges[index]=[]
        self.title_last_values[index]=''
        self.title_selection_ranges[index]=None
        self.title_manual_lines[index]=None
        self.auto_page_values[index]=''
        self.auto_page_people[index]=''
        self.suggested_page_values[index]=''
        self.page_match_issues[index]=''
        self.phone_source_numbers[index]=None
        self.original_phone_values[index]=''
        self.auto_phone_values[index]=''
        self._set_row_progress(index,'待下载')
        self.history_paused=False
        self.record_edit()
        if self.title_preview_index==index:self.hide_title_preview()
        self.status.config(text=f'第 {index+1} 行已清空；已下载文件保留，可用 Ctrl+Z 恢复。')

    def clear_cache(self):
        if self.active:
            messagebox.showinfo('清理缓存', '请等待下载结束后再清理缓存。', parent=self.root)
            return
        removed = 0
        failures = []
        directory = self.settings_path.parent
        targets = [directory / '__pycache__']
        base = Path(self.base.get())
        if base.is_dir():
            targets.extend(base.glob('*/.video-task-*'))
        for target in targets:
            name = target.name
            if not target.exists() or target.is_symlink() or target.is_junction():
                continue
            try:
                size = sum(p.stat().st_size for p in target.rglob('*') if p.is_file() and not p.is_symlink())
                shutil.rmtree(target)
                removed += size
            except OSError as exc:
                failures.append(f'{name}: {exc}')
        with _drive_guard:
            _drive_completed.clear()
            _drive_locks.clear()
        self.status.configure(text=f'缓存已清理，释放 {removed / 1024 / 1024:.2f} MB')
        if failures:
            messagebox.showwarning('部分缓存未清理', '\n'.join(failures), parent=self.root)

    def change_appearance(self, event=None):
        apply_appearance(self.root, self.appearance.get())
        try:
            update_settings(self.settings_path, appearance=self.appearance.get())
        except OSError as exc:
            messagebox.showerror('界面主题', f'主题已切换，但未能保存设置：{exc}', parent=self.root)

    def finish_close(self):
        # In the integrated app the downloader shares the shell's Tk root.
        # Destroying it here would close the entire application after a
        # download if this legacy option is ever enabled.
        if self.embedded:
            self.exit_on_finish.set(False)
            self.status.config(text='下载已完成；剪辑助手仍保持打开。')
            return
        if self.cookie_temp is not None:
            self.cookie_temp.cleanup()
            self.cookie_temp = None
        self.root.destroy()

    def snapshot(self):
        rows=[]
        for index,(values,page,language,background,phone,title_layout,denoise) in enumerate(
                zip(self.rows,self.page_vars,self.language_vars,self.background_vars,self.phone_vars,self.title_layout_vars,self.denoise_vars)):
            row_values=tuple(variable.get() for variable in (*values,page,language,background,phone,title_layout,denoise))
            manual_lines=(tuple(self.title_manual_lines[index])
                          if self.title_manual_lines[index] is not None else None)
            rows.append((*row_values,self.title_font_paths[index],tuple(self.title_color_ranges[index]),manual_lines))
        return (self.bulk_text.get('1.0', 'end-1c'), tuple(rows), tuple(self.row_statuses))

    def record_edit(self):
        if self.history_paused or self.active:
            return
        current = self.snapshot()
        if current != self.last_snapshot:
            self.undo_stack.append(self.last_snapshot)
            self.undo_stack = self.undo_stack[-100:]
            self.redo_stack.clear()
            self.last_snapshot = current

    def bulk_changed(self, event=None):
        if self.bulk_text.edit_modified():
            self.record_edit()
            self.bulk_text.edit_modified(False)

    def select_all(self, event):
        if isinstance(event.widget, tk.Text):
            event.widget.tag_add('sel', '1.0', 'end-1c')
        else:
            event.widget.selection_range(0, 'end')
        return 'break'

    def restore_edit(self, redo=False):
        if self.active:
            return 'break'
        self.record_edit()
        source, target = (self.redo_stack, self.undo_stack) if redo else (self.undo_stack, self.redo_stack)
        if not source:
            return 'break'
        target.append(self.snapshot())
        bulk, rows, progress = source.pop()
        self.history_paused = True
        self.bulk_text.delete('1.0', 'end')
        self.bulk_text.insert('1.0', bulk)
        for index,(variables,page,language,background,phone,title_layout,denoise, values) in enumerate(zip(self.rows,self.page_vars,self.language_vars,self.background_vars,self.phone_vars,self.title_layout_vars,self.denoise_vars,rows)):
            for variable, value in zip((*variables,page,language,background,phone,title_layout,denoise),values[:9]):
                variable.set(value)
            self.title_font_paths[index]=values[9]
            self.title_color_ranges[index]=list(values[10])
            self.title_manual_lines[index]=(list(values[11]) if len(values)>11 and values[11] is not None else None)
            self.title_last_values[index]=variables[1].get()
        for index,value in enumerate(progress):
            self._set_row_progress(index,value)
        self.bulk_text.edit_modified(False)
        self.last_snapshot = self.snapshot()
        self.history_paused = False
        self.refresh_title_preview(self.title_preview_index)
        return 'break'

    def clear_list(self):
        if self.active:
            self.status.config(text='下载期间不能清空列表。')
            return
        self.record_edit()
        self.history_paused = True
        for variables in self.rows:
            for variable in variables:
                variable.set('')
        for index in range(len(self.title_font_paths)):
            self.title_font_paths[index]=''
            self.title_color_ranges[index]=[]
            self.title_last_values[index]=''
            self.title_manual_lines[index]=None
        # Clearing task text resets each row to the default traffic template.
        for variable in self.page_vars:
            variable.set('1')
        for variable in self.language_vars:
            variable.set(DEFAULT_LANGUAGE)
        for variable in self.phone_vars:
            variable.set('')
        for variable in self.title_layout_vars:
            variable.set('全局')
        for variable in self.denoise_vars:
            variable.set('全局')
        for variable in self.background_vars:
            variable.set(False)
        for index in range(len(self.row_statuses)):
            self._set_row_progress(index,'待下载')
        self.history_paused = False
        self.record_edit()
        self.status.config(text='列表已清空，可用 Ctrl+Z 恢复；已下载文件保留。')

    def preview_folder(self, index):
        # Typing never changes the status area or the window geometry.
        return

    def open_ig_website(self):
        import subprocess
        candidates=[Path(os.environ.get('PROGRAMFILES','C:/Program Files'))/'Google/Chrome/Application/chrome.exe',
                    Path(os.environ.get('PROGRAMFILES(X86)','C:/Program Files (x86)'))/'Google/Chrome/Application/chrome.exe',
                    Path(os.environ.get('LOCALAPPDATA',''))/'Google/Chrome/Application/chrome.exe']
        chrome=next((path for path in candidates if path.is_file()),None)
        if not chrome:
            messagebox.showerror('无法打开','未找到 Google Chrome, 请先安装谷歌浏览器.',parent=self.root);return
        # Chrome forwards the URL to its already running default profile.
        subprocess.Popen([str(chrome),'https://saveclip.app/en8'])

    def focus_ig_link(self):
        """Focus the first empty video URL field for pasting an Instagram link."""
        for row in self.rows:
            link = row[2]
            if not link.get().strip():
                link_widget = next((entry for entry in self.input_entries if str(entry.cget('textvariable')) == str(link)), None)
                if link_widget is not None:
                    link_widget.focus_set()
                self.status.config(text='请将 Instagram 链接粘贴到空白的“视频链接”栏，再点击“开始下载”。')
                return
        self.status.config(text='没有空白的视频链接栏，请先清空一行或添加任务。')

    def show_ig_help(self):
        messagebox.showinfo('Instagram 链接下载', '将 Instagram 帖子、Reels 或视频链接直接填入任一行“视频链接”栏，然后点击“开始下载”。需要登录时，请在“更多设置”中配置 Instagram Cookie。', parent=self.root)

    def open_video_composer(self):
        """Launch the video composer in its own process and window."""
        import subprocess
        script=Path(__file__).resolve().parent/'video_composer.py'
        python=Path(sys.executable)
        if getattr(sys,'frozen',False):
            command=[str(python),str(script)]
        else:
            command=[str(python),str(script)]
        if not script.is_file():
            messagebox.showerror('无法打开拼接器','找不到视频拼接器程序文件。请重新安装或解压完整的软件包。',parent=self.root)
            return
        try:
            subprocess.Popen(command,cwd=str(script.parent),close_fds=True,
                             env={**os.environ,'VIDEO_DOWNLOADER_DATA_DIR':str(script.parent)})
        except OSError as exc:
            messagebox.showerror('无法打开拼接器',str(exc),parent=self.root)

    def save_canva_url(self):
        try:
            url = validate_canva_url(self.canva_url.get())
            update_settings(self.settings_path, canva_url=url)
            self.status.config(text='Canva 工程链接已保存；页码列已准备，PNG 自动生成尚未接通。')
        except (ValueError, OSError) as exc:
            messagebox.showerror('无法保存', str(exc), parent=self.root)

    def open_canva(self):
        try:
            webbrowser.open(validate_canva_url(self.canva_url.get()))
        except ValueError as exc:
            messagebox.showerror('链接无效', str(exc), parent=self.root)

    def fill_bulk_links(self):
        if self.active:
            return
        try:
            plan = plan_link_fill(self.bulk_text.get('1.0', 'end'), [link.get() for _, _, link in self.rows])
        except ValueError as exc:
            self.status.config(text=str(exc))
            return
        tracked = hasattr(self, 'undo_stack')
        if tracked:
            self.record_edit()
            self.history_paused = True
        for index, url in plan:
            self.rows[index][2].set(url)
        self.bulk_text.delete('1.0', 'end')
        if tracked:
            self.bulk_text.edit_modified(False)
            self.history_paused = False
            self.record_edit()
        self.status.config(text=f'已按原顺序填入 {len(plan)} 行链接；同一行多个链接会分别下载，已有内容保留。')

    def paste_rich_links(self, event):
        """Preserve actual hrefs when a user pastes Google Sheets link chips."""
        widget = event.widget
        try:
            plain_text = widget.clipboard_get()
        except tk.TclError:
            plain_text = ''
        fragment = read_clipboard_html()
        matrix = clipboard_matrix(plain_text, fragment)
        field_rows = clipboard_field_rows(matrix)
        if field_rows:
            if self.apply_clipboard_rows(0, field_rows):
                return 'break'
            return 'break'
        groups = clipboard_link_groups(fragment)
        groups = [list(dict.fromkeys(group)) for group in groups]
        if not groups or not any(groups):
            return None
        if isinstance(widget, tk.Text):
            pasted = '\n'.join(' | '.join(group) for group in groups)
            selection = widget.tag_ranges('sel')
            if selection:
                widget.delete(selection[0], selection[1])
            widget.insert('insert', pasted)
            self.status.config(text='已读取表格中的真实链接地址；同一行内的多个链接会留在同一下载行。')
            return 'break'

        nonempty = [group for group in groups if group]
        if len(nonempty) != 1 or len(groups) != 1:
            self.status.config(text='检测到多行表格链接；请粘贴到上方“批量链接”区域，再点“识别并填入”。')
            return 'break'
        pasted = ' | '.join(nonempty[0])
        try:
            if widget.selection_present():
                widget.delete('sel.first', 'sel.last')
            widget.insert('insert', pasted)
            widget.icursor('insert')
        except tk.TclError:
            return None
        if len(nonempty[0]) > 1:
            self.status.config(text=f'已从表格单元格读取到 {len(nonempty[0])} 个链接；将保留在本行分别下载。')
        return 'break'

    def _paste_matrix(self, widget):
        try:
            plain_text = widget.clipboard_get()
        except tk.TclError:
            plain_text = ''
        return clipboard_matrix(plain_text, read_clipboard_html())

    def paste_column_values(self, event, start_index, field):
        """Fill a form column downward from a copied spreadsheet range."""
        if self.active:
            self.status.config(text='下载期间不能批量填入任务。')
            return 'break'
        matrix = self._paste_matrix(event.widget)
        if not matrix:
            return None
        mapped = clipboard_field_rows(matrix)
        if mapped:
            if self.apply_clipboard_rows(start_index, mapped):
                self.status.config(text=f'已按表头批量填入 {len(mapped)} 行演员、号码、文案和视频链接。')
            return 'break'
        if any(len(row) != 1 for row in matrix):
            return None
        values = []
        for row in matrix:
            cell = row[0]
            value = (' | '.join(cell['links']) if field == 'link' and cell['links']
                     else str(cell.get('text', '')).strip())
            values.append(value)
        has_rich_link = field == 'link' and any(row[0]['links'] for row in matrix)
        if len(values) == 1 and not has_rich_link:
            if field == 'title':
                cleaned = strip_title_hashtags(values[0])
                if cleaned != values[0]:
                    if self.apply_clipboard_rows(start_index, [{'title': cleaned}]):
                        self.status.config(text='已从视频标题中移除 # 后面的标签。')
                    return 'break'
            if field == 'link' and values[0] and not extract_urls(values[0]):
                self.status.config(
                    text='剪贴板只有文件名，没有链接地址。请在 Google 表格里对视频链接卡片选择“复制链接”，再粘贴。')
                return 'break'
            return None
        assignments = [{field: value} for value in values]
        if self.apply_clipboard_rows(start_index, assignments):
            if field == 'link':
                self.status.config(text=f'已将 {len(values)} 行视频链接填入；同格多个链接会留在同一行下载。')
            else:
                labels = {'name': '演员/人名', 'phone': '号码', 'title': '视频名称'}
                self.status.config(text=f'已将 {len(values)} 行{labels[field]}填入对应列。')
        return 'break'

    def apply_clipboard_rows(self, start_index, assignments):
        if self.active:
            self.status.config(text='下载期间不能批量填入任务。')
            return False
        if start_index + len(assignments) > len(self.rows):
            remaining = len(self.rows) - start_index
            self.status.config(text=f'剪贴板有 {len(assignments)} 行数据，但当前位置只剩 {remaining} 行；请分批粘贴。')
            return False
        tracked = hasattr(self, 'undo_stack')
        if tracked:
            self.record_edit()
            self.history_paused = True
        for offset, values in enumerate(assignments):
            index = start_index + offset
            if 'name' in values:
                self.rows[index][0].set(str(values['name']).strip())
            if 'phone' in values:
                self.phone_vars[index].set(str(values['phone']).strip())
                if self.phone_vars[index].get().strip():
                    self.format_phone_cell(index)
            if 'title' in values:
                self.rows[index][1].set(strip_title_hashtags(values['title']).strip())
            if 'link' in values:
                self.rows[index][2].set(str(values['link']).strip())
        if tracked:
            self.history_paused = False
            self.record_edit()
        return True

    def choose_dir(self):
        path = filedialog.askdirectory()
        if path:
            self.base.set(path)

    def choose_cookie(self):
        path = filedialog.askopenfilename(filetypes=[('Netscape Cookie 文件', '*.txt'), ('所有文件', '*')])
        if path:
            self.cookies.set(path)
            self.use_browser_login_on_download = False
            self.status.config(text='已选择登录文件：' + Path(path).name)

    def show_errors(self):
        errors = [f"第 {self.jobs[key]['row'] + 1} 行：{self.jobs[key].get('error', '')}"
                  for key in getattr(self, 'batch_keys', [])
                  if self.jobs[key]['state'] in ('失败', DENOISE_PRESERVED_STATE)]
        messagebox.showinfo('失败原因', '\n\n'.join(errors) or '没有失败任务', parent=self.root)

    def use_browser_login(self, browser):
        if self.active:
            self.status.config(text='请在本批下载结束后选择浏览器登录状态。')
            return
        try:
            from yt_dlp.cookies import extract_cookies_from_browser
            jar = extract_cookies_from_browser(browser)
            if self.cookie_temp is None:
                self.cookie_temp = tempfile.TemporaryDirectory(prefix='video-login-')
            filename = str(Path(self.cookie_temp.name) / 'cookies.txt')
            jar.save(filename)
            self.cookies.set(filename)
            # Preserve the selected browser so a failed extraction can report
            # the real error instead of silently trying unrelated profiles.
            self.use_browser_login_on_download = browser
            self.status.config(text='已读取浏览器登录状态，可重试失败任务；退出后清理临时登录文件。')
        except Exception as exc:
            detail = str(exc).strip() or type(exc).__name__
            lowered = detail.casefold()
            if 'failed to decrypt with dpapi' in lowered or '10927' in lowered:
                advice = ('Chrome 已启用 Windows/应用绑定的 Cookie 加密；yt-dlp 无法解密这类 Chrome Cookie，'
                          '退出浏览器也不能解决。请改用 Firefox 登录同一个 Google 账号，再选择“更多设置 → 使用浏览器登录状态 → Firefox”；'
                          '或者导入该账号的 Netscape 格式 Cookie 文件。')
            elif 'could not copy chrome cookie database' in lowered:
                advice = ('Chrome 正在锁定 Cookie 数据库。请退出所有 Chrome 窗口，并在任务管理器结束残留的 chrome.exe（'
                          '也可在 Chrome 设置中关闭“关闭 Google Chrome 后继续运行后台应用”），再重新选择 Chrome。'
                          '若不想关闭 Chrome，请用 Firefox/Edge 登录目标 Google 账号后选择对应浏览器，或导入该账号的 Netscape Cookie 文件。')
            else:
                advice = '请先完全退出该浏览器（包括后台进程）后重试。若仍失败，可选择其他已登录浏览器或导入你自己的 Netscape Cookie 文件。'
            messagebox.showerror(
                '无法读取浏览器登录状态',
                f'读取 {browser} 登录状态失败：\n{detail}\n\n{advice}',
                parent=self.root)

    def open_dir(self):
        try:
            path = Path(self.base.get()).expanduser().resolve()
            path.mkdir(parents=True, exist_ok=True)
            os.startfile(path)
        except Exception as exc:
            messagebox.showerror('无法打开目录', str(exc))

    def open_local_editor(self):
        from local_design import LocalEditor
        LocalEditor(self.root, self.settings_path.parent, self.base)

    def preview_page(self, index):
        from page_cache import read_pages, page_footer, format_phone, format_phone_like, page_number_for_position
        try:
            pages = read_pages(self.cache_path)
            number = int(self.page_vars[index].get())
            source_number=page_number_for_position(pages,number)
            page = pages[source_number]
            _, source_phone = page_footer(page)
            phone=source_phone
            if source_number==pages[min(pages)]:
                config_path=Path(self.settings_path).parent/'graphic-template-1.json'
                try:phone=json.loads(config_path.read_text(encoding='utf-8')).get('phone','+1(240)726-0061')
                except (OSError,ValueError,TypeError):phone='+1(240)726-0061'
            supplied = self.phone_vars[index].get().strip()
            effective = format_phone(supplied) if supplied else phone
            phone = f'原号码: {phone}；使用号码: {effective}' + ('（本行替换）' if supplied else '（默认）')
            person,title,link=self.rows[index]
            language=self.language_vars[index].get() or DEFAULT_LANGUAGE
            self.status.config(text=f'第{index+1}行: 模板语种 {language}, {phone}\n人名: {person.get()}\n标题: {title.get()}\n链接: {link.get()}')
        except (OSError, ValueError, KeyError):
            self.status.config(text='选择模板并填写号码，可预览本行引流模板效果')

    def match_person(self,index,force=False):
        if self.active:return
        if not self.rows[index][1].get().strip() and self.rows[index][2].get().strip():
            self.page_match_issues[index]=''
            return
        current=self.page_vars[index].get().strip()
        auto_value=self.auto_page_values[index]
        suggested=self.suggested_page_values[index]
        if current and not force and current not in (auto_value,suggested):return
        from page_cache import read_pages
        try:
            person=self.rows[index][0].get().strip()
            old_person=' '.join(self.auto_page_people[index].split()).casefold()
            new_person=' '.join(person.split()).casefold()
            if current and current == auto_value and old_person and old_person != new_person:
                self.page_vars[index].set('1')
                self.auto_page_values[index]=''
                self.auto_page_people[index]=''
                current='1'
                self.clear_auto_phone(index)
            pages=read_pages(self.cache_path)
            self.page_match_issues[index]=''
            if current and current != '1':
                self.page_vars[index].set('1')
                self.auto_page_values[index]=''
                self.auto_page_people[index]=''
            # Template selection is explicit; archived Canva pages are not
            # mapped to extra template numbers anymore.
        except (ValueError,OSError) as exc:self.status.config(text=str(exc))

    def load_matched_phone(self,index):
        from page_cache import read_pages,page_number_for_position,page_footer
        try:
            pages=read_pages(self.cache_path)
            position=int(self.page_vars[index].get())
            source_number=page_number_for_position(pages,position)
            _,phone=page_footer(pages[source_number])
        except (ValueError,OSError,KeyError):return
        if self.phone_source_numbers[index]!=source_number:
            # A name/title edit can finish matching after the user has already
            # typed a replacement number. Keep that explicit value when the
            # matched page changes instead of replacing it with the new page's
            # saved number.
            current_phone=self.phone_vars[index].get().strip()
            previous_auto=self.auto_phone_values[index].strip()
            has_manual_phone=bool(current_phone and current_phone!=previous_auto)
            self.phone_source_numbers[index]=source_number
            self.original_phone_values[index]=phone
            self.auto_phone_values[index]=phone
            if not has_manual_phone:
                self.phone_vars[index].set(phone)
        elif not self.phone_vars[index].get().strip() or self.phone_vars[index].get().strip()==self.auto_phone_values[index]:
            self.original_phone_values[index]=phone
            self.auto_phone_values[index]=phone
            self.phone_vars[index].set(phone)

    def format_phone_cell(self,index):
        """Apply the page library's international phone formatting after editing."""
        from page_cache import format_phone_like
        value=self.phone_vars[index].get().strip()
        if not value:return
        existing=self.auto_phone_values[index].strip()
        if not existing:
            try:
                from page_cache import read_pages,page_number_for_position,page_footer
                pages=read_pages(self.cache_path)
                position=int(self.page_vars[index].get())
                source_number=page_number_for_position(pages,position)
                _,existing=page_footer(pages[source_number])
            except (ValueError,OSError,KeyError,IndexError):
                existing=''
        formatted=format_phone_like(existing,value) if existing else format_phone_like('+1',value)
        if formatted!=value:self.phone_vars[index].set(formatted)

    def clear_auto_phone(self,index):
        if self.phone_vars[index].get().strip()==self.auto_phone_values[index]:
            self.phone_vars[index].set('')
        self.phone_source_numbers[index]=None
        self.original_phone_values[index]=''
        self.auto_phone_values[index]=''

    def schedule_person_match(self,index):
        job=self.match_jobs.pop(index,None)
        if job is not None:
            try:self.root.after_cancel(job)
            except tk.TclError:pass
        self.match_jobs[index]=self.root.after(300,lambda i=index:self._run_person_match(i))

    def _run_person_match(self,index):
        self.match_jobs.pop(index,None)
        self.match_person(index)

    def match_all_pages(self):
        for index in range(len(self.rows)):self.match_person(index,force=True)

    def refresh_page_matches(self):
        """Recheck automatic row matches after the editable page library changes."""
        if self.active:return
        for index in range(len(self.rows)):
            self.match_person(index)

    def open_page_data(self):
        try:
            from page_library import PageLibrary
            PageLibrary(self)
        except Exception as exc:
            messagebox.showerror('无法打开页面资料', str(exc), parent=self.root)

    def open_bible_editor(self):
        try:
            from bible_editor import BibleEditor
            BibleEditor(self)
        except Exception as exc:messagebox.showerror('无法打开圣经背景',str(exc),parent=self.root)

    def start(self, retry_keys=None):
        if not self.rows_ready:
            self.status.config(text='任务列表正在准备，请稍候。')
            return
        if self.active or self.translation_pending:
            return
        self.completion_actions.pack_forget()
        try:
            values = []
            for name, title, link in self.rows:
                cleaned_title = strip_title_hashtags(title.get()).strip()
                if cleaned_title != title.get():
                    title.set(cleaned_title)
                values.append((name.get(), cleaned_title, link.get()))
            count = int(self.count.get())
            templates = {}
            title_image_errors = {}
            translations_to_fetch = {}
            from page_cache import read_pages, page_design, read_style, page_number_for_position, page_footer, format_phone_like
            cached_pages = read_pages(self.cache_path)
            for index, page in enumerate(self.page_vars):
                supplied = self.supplied_phone(index)
                if not any(value.strip() for value in values[index]) and not supplied:
                    continue
                position = page.get().strip() or '1'
                try:
                    source_number = page_number_for_position(cached_pages, position)
                    _, old_phone = page_footer(cached_pages[source_number])
                    template_theme=self.theme.get()
                    if source_number==min(cached_pages):
                        config_path=Path(self.settings_path).parent/'graphic-template-1.json'
                        try:old_phone=json.loads(config_path.read_text(encoding='utf-8')).get('phone','+1(240)726-0061')
                        except (OSError,ValueError,TypeError):old_phone='+1(240)726-0061'
                    formatted = format_phone_like(old_phone, supplied) if supplied else format_phone_like(old_phone,old_phone)
                    templates[index] = page_design(cached_pages, source_number, template_theme, self.layout.get(),
                                                   read_style(self.cache_path), phone_override=formatted)
                    templates[index]['phone_input']=supplied
                    templates[index]=self._decorate_title_design(templates[index],index,values[index][1])
                    language=self.language_vars[index].get().strip() or DEFAULT_LANGUAGE
                    if language not in LANGUAGE_CODES:
                        raise ValueError(f'第 {index+1} 行：不支持“{language}”语种。')
                    target_language=LANGUAGE_CODES[language]
                    if target_language!='en':
                        translation_request,translation_metadata=build_template_translation_request(
                            templates[index],formatted)
                        cache_key=translation_cache_key(target_language,translation_request)
                        cached_translation=self.template_translation_cache.get(cache_key)
                        if cached_translation is None:
                            translations_to_fetch.setdefault(cache_key,(translation_request,target_language))
                        else:
                            templates[index]=apply_template_translation(
                                templates[index],cached_translation,translation_metadata,formatted)
                    templates[index]['selected_template_language']=language
                except ValueError as exc:
                    raise ValueError(f'第 {index + 1} 行：模板 {position} 无法使用：{exc}') from exc
            if translations_to_fetch:
                self.translation_pending=True
                self.start_button.config(state='disabled')
                self.status.config(text='正在按所选语种翻译引流模板；原有换行、字号、颜色和号码格式会保留，完成后开始生成。')
                def translate_pending_templates():
                    translated={}
                    error=''
                    try:
                        for cache_key,(request,target_language) in translations_to_fetch.items():
                            translated[cache_key]=translate_template_copy(request,target_language)
                    except Exception as exc:
                        error=str(exc)
                    self.events.put((None,'template_translation_ready',{'translations':translated,'error':error}))
                threading.Thread(target=translate_pending_templates,daemon=True).start()
                return
            if not 1 <= count <= 10:
                raise ValueError('同时下载数量必须在 1 到 10 之间')
            task_values = [row if any(value.strip() for value in row) else
                           ((f'第{i + 1}行', '', '') if self.supplied_phone(i) else row)
                           for i, row in enumerate(values)]
            if retry_keys:
                tasks = [(self.jobs[key]['row'], self.jobs[key]['name'], self.jobs[key]['url'],
                          self.jobs[key]['path'], self.jobs[key].get('link_index', 1),
                          self.jobs[key].get('link_count', 1), key) for key in retry_keys]
            else:
                tasks = [(*task, None) for task in task_rows(self.base.get(), task_values)]
            previous_stems = {}
            for key in retry_keys or ():
                previous_stems.setdefault(self.jobs[key]['row'], self.jobs[key].get('media_stem'))
            media_stems = {}
            last_generated_at = None
            task_rows_seen = dict.fromkeys(task[0] for task in tasks)
            for index in task_rows_seen:
                person, title, _ = task_values[index]
                saved_stem = previous_stems.get(index)
                if saved_stem:
                    media_stems[index] = saved_stem
                    continue
                generated_at = datetime.now()
                if last_generated_at and generated_at <= last_generated_at:
                    generated_at = last_generated_at + timedelta(microseconds=1)
                stem = media_name(person or f'第{index + 1}行', title, generated_at)
                path = next(task[3] for task in tasks if task[0] == index)
                while path.exists() and any(item.name == f'{stem}.png' or
                                             item.name.startswith(f'{stem}.') or
                                             item.name.startswith(f'{stem}-')
                                             for item in path.iterdir()):
                    generated_at += timedelta(microseconds=1)
                    stem = media_name(person or f'第{index + 1}行', title, generated_at)
                media_stems[index] = stem
                last_generated_at = generated_at
            cookie_path = Path(self.cookies.get().strip()).expanduser() if self.cookies.get().strip() else None
            has_drive_task = any((urlparse(task[2]).hostname or '').lower() in ('drive.google.com', 'docs.google.com')
                                 for task in tasks)
            if has_drive_task and cookie_path and not cookie_path.is_file():
                messagebox.showerror(
                    'Google Cookie 文件不存在',
                    f'找不到 Cookie 文件：\n{cookie_path}\n\n'
                    '请在“更多设置 → 选择 Google Cookie 文件…”重新选择有效文件，然后重试。',
                    parent=self.root)
                return
            import yt_dlp
            import gdown
            for _, _, _, path, _, _, _ in tasks:
                path.mkdir(parents=True, exist_ok=True)
            if templates:
                png_warnings=[]
                generated_png_rows=set()
                for index, _, _, path, _, _, _ in tasks:
                    if index in generated_png_rows:
                        continue
                    generated_png_rows.add(index)
                    if index not in templates:
                        continue
                    design = templates[index]
                    override={'1行':'单行','2行':'两行','3行':'三行','4行':'四行'}.get(self.title_layout_vars[index].get())
                    if override:
                        design=dict(design);design['layout']=override;design['layout_exact']=True
                    title = self.rows[index][1].get().strip()
                    output = path / f'{media_stems[index]}.png'
                    error=try_publish_title_png(
                        design,title,output,self.resolution.get(),self.cache_path.parent)
                    if error:
                        title_image_errors[index] = error
                        png_warnings.append(f'第{index+1}行图片保存失败：{error}')
                self.batch_warnings=png_warnings
            else:
                self.batch_warnings=[]
        except Exception as exc:
            messagebox.showerror('无法开始', str(exc))
            return
        quality, cookie = self.quality.get(), self.cookies.get()
        global_denoise = int(self.global_denoise.get())
        try:
            update_settings(self.settings_path, denoise_strength=global_denoise)
        except OSError:
            pass
        browser_auth = getattr(self, 'use_browser_login_on_download', True)
        if not retry_keys:
            with _drive_guard:
                _batch_download_cache.clear()
                _batch_download_locks.clear()
                _drive_completed.clear()
                _drive_locks.clear()
        self.active = True
        self.start_button.config(state='disabled')
        self.extract_button.config(state='disabled')
        # Each job already owns an immutable snapshot of its row and settings.
        # Leave the form widgets mapped and enabled while workers run; toggling
        # every cell disabled/enabled at batch boundaries caused the whole
        # twelve-row form to repaint like a page refresh.
        batch = []
        self.batch_keys = []
        for row_index, name, url, path, link_index, link_count, prior_key in tasks:
            key = uuid.uuid4().hex
            event = threading.Event()
            override = self.denoise_vars[row_index].get().strip()
            strength = int(override[:-1]) if override.endswith('%') else global_denoise
            previous_job = self.jobs.get(prior_key) if prior_key else None
            retry_denoise_files = (list(previous_job.get('denoise_failed_files') or [])
                                   if previous_job and previous_job.get('state') == DENOISE_PRESERVED_STATE else [])
            self.jobs[key] = {'row': row_index, 'name': name, 'url': url, 'path': path,
                              'media_stem': media_stems[row_index], 'cancel': event, 'state': '排队中',
                              'link_index': link_index, 'link_count': link_count,
                              'title_error': title_image_errors.get(row_index),
                              'denoise_strength': strength, 'denoise_failed_files': [],
                              'retry_denoise_files': retry_denoise_files}
            self.batch_keys.append(key)
            initial_progress = (f'0% · 链接 {link_index}/{link_count} 排队中'
                                if link_count > 1 else '0% · 排队中')
            self._set_row_progress(row_index,initial_progress)
            batch.append((key, url, event, (path, quality, cookie, browser_auth, strength,
                                             retry_denoise_files)))
        def run_batch():
            with ThreadPoolExecutor(max_workers=count) as executor:
                groups, standalone = group_download_jobs(batch)
                futures = [executor.submit(self._download_group, group) for group in groups]
                futures.extend(executor.submit(self.download, *job) for job in standalone)
                for future in futures:
                    future.result()
            self.events.put((None, 'batch_done', ''))
        threading.Thread(target=run_batch, daemon=True).start()

    def download(self, key, url, cancel, settings):
        return self._download_uncached(key, url, cancel, settings)

    def _download_group(self, batch):
        """Download each link once, then denoise its audio when requested."""
        leader_key, url, cancel, leader_settings = batch[0]
        keys = [job[0] for job in batch]
        output_folders = {job[0]: Path(job[3][0]) for job in batch}
        marker_paths = {}
        retry_sources = []
        for _key, _, _, settings in batch:
            for item in settings[5] if len(settings) > 5 else ():
                source = Path(item)
                if source not in retry_sources:
                    retry_sources.append(source)

        try:
            for key in keys:
                job = self.jobs.get(key, {})
                folder = output_folders[key]
                link_count = int(job.get('link_count', 1) or 1)
                link_index = int(job.get('link_index', 1) or 1)
                marker_label = f'视频{link_index}' if link_count > 1 else '视频'
                marker_paths[key] = folder / f'{marker_label}-下载处理中.txt'
            update_processing_markers(marker_paths, '准备下载', '正在连接并获取视频。')
            base = Path(leader_settings[0]).parent
            base.mkdir(parents=True, exist_ok=True)
            quality, cookie, browser_auth = leader_settings[1:4]
            strengths = {}
            for job in batch:
                settings = job[3]
                strength = int(settings[4]) if len(settings) > 4 else 0
                strengths.setdefault(strength, []).append(job)

            # Keep processing folders out of the user's download directory so
            # interrupted work cannot look like a completed download.
            with tempfile.TemporaryDirectory(prefix='clipassistant-batch-') as temporary:
                work_root = Path(temporary)
                if retry_sources:
                    sources_by_name = {}
                    expected_names = {source.name.casefold() for source in retry_sources}
                    for source in retry_sources:
                        if source.is_file():
                            sources_by_name.setdefault(source.name.casefold(), source)
                    missing = sorted(expected_names - set(sources_by_name))
                    if missing:
                        raise RuntimeError('待重试降噪的视频已移动或删除：\n' + '\n'.join(missing))
                    raw_sources = []
                    for index, source in enumerate(sources_by_name.values(), start=1):
                        pristine = work_root / 'source' / f'{index:04d}' / source.name
                        pristine.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source, pristine)
                        raw_sources.append(pristine)
                else:
                    raw_folder = work_root / 'source'
                    download_temp = work_root / 'download'
                    raw_folder.mkdir()
                    download_temp.mkdir()
                    self._download(leader_key, url, cancel,
                                   (download_temp, quality, cookie, raw_folder, browser_auth,
                                    0, keys, marker_paths))
                    raw_sources = local_video_files(raw_folder)
                    if not raw_sources:
                        raise RuntimeError('下载没有生成可处理的视频文件。')

                # Publish the downloaded source as soon as it is complete. Keep
                # it visible while denoising, then atomically replace it with
                # the finished file below.
                update_processing_markers(marker_paths, '下载完成', '原视频已下载，正在显示到目标文件夹。')
                raw_published = {}
                for key in keys:
                    folder = output_folders[key]
                    job = self.jobs[key]
                    link_prefix = (f'视频{job.get("link_index", 1)}-'
                                   if job.get('link_count', 1) > 1 else '')
                    for source in raw_sources:
                        raw_name = f'{link_prefix}{source.stem}{source.suffix}'
                        raw_published[(key, source.name.casefold())] = replace_published_file(
                            source, folder, raw_name)

                from core.denoise import denoise_video
                terminal_keys = set()
                for strength, strength_batch in strengths.items():
                    strength_keys = [job[0] for job in strength_batch]
                    strength_markers = {key: marker_paths[key] for key in strength_keys
                                        if key in marker_paths}
                    result_files = {}
                    denoise_errors = {}
                    for index, source in enumerate(raw_sources, start=1):
                        if cancel.is_set():
                            raise RuntimeError('任务已取消')
                        if strength > 0:
                            source_work = work_root / f'process-{strength}' / f'{index:04d}' / source.name
                            source_work.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(source, source_work)
                            output = source_work
                        else:
                            output = source

                        # Keep the downloaded video stream and original format;
                        # only denoise its audio when the selected strength is on.
                        if strength > 0:
                            update_processing_markers(
                                strength_markers, '降噪中',
                                f'原视频已显示；正在处理视频 {index}/{len(raw_sources)}（{strength}%）。')
                            for key in strength_keys:
                                self.events.put((key, '处理中', f'降噪 {index}/{len(raw_sources)} · {strength}%'))
                            def denoise_progress(detail, i=index, n=len(raw_sources),
                                                 group_keys=tuple(strength_keys), markers=strength_markers):
                                update_processing_markers(markers, '降噪中', f'视频 {i}/{n} · {detail}')
                                for group_key in group_keys:
                                    self.events.put((group_key, '处理中', f'降噪 {i}/{n} · {detail}'))
                            try:
                                output = denoise_video(
                                    output,
                                    strength_percent=strength,
                                    resource_dir=self.resource_dir,
                                    output_audio_bitrate='128k',
                                    output_sample_rate=44100,
                                    output_channels=2,
                                    progress=denoise_progress,
                                    cancel=cancel,
                                )
                            except Exception as exc:
                                if cancel.is_set():
                                    raise
                                denoise_errors[source.name.casefold()] = str(exc)
                        result_files[source.name.casefold()] = (source, output)

                    for key, _, _, _settings in strength_batch:
                        folder = output_folders[key]
                        self.events.put((key, '处理中', '正在保存下载视频与降噪结果'))
                        failed_denoise_files = []
                        copy_errors = []
                        for source in raw_sources:
                            _raw, output = result_files[source.name.casefold()]
                            job = self.jobs[key]
                            link_prefix = (f'视频{job.get("link_index", 1)}-'
                                           if job.get('link_count', 1) > 1 else '')
                            output_name = f'{link_prefix}{Path(source.name).stem}{output.suffix}'
                            try:
                                already_published = (strength == 0 and
                                                     output.resolve() == source.resolve())
                                published = (raw_published.get((key, source.name.casefold()))
                                             if already_published else
                                             replace_published_file(output, folder, output_name))
                                if published is None:
                                    published = folder / safe_video_filename(output_name)
                                if output.suffix.casefold() != source.suffix.casefold():
                                    old_source = folder / video_output_filename(f'{link_prefix}{source.name}')
                                    if old_source != published and old_source.is_file():
                                        old_source.unlink()
                                if source.name.casefold() in denoise_errors:
                                    failed_denoise_files.append(str(published))
                            except OSError as exc:
                                copy_errors.append(f'{source.name}：{exc}')
                        self.jobs[key]['denoise_failed_files'] = failed_denoise_files
                        if copy_errors:
                            detail = '复制同一链接的处理结果失败：\n' + '\n'.join(copy_errors)
                            self.events.put((key, '失败', detail))
                        elif denoise_errors:
                            details = '\n'.join(
                                f'{Path(name).name}：保留原视频；降噪错误：{error}'
                                for name, error in denoise_errors.items())
                            self.events.put((key, DENOISE_PRESERVED_STATE,
                                             f'降噪失败，已保留可用视频版本：\n{details}'))
                        else:
                            if retry_sources:
                                label = '已重试降噪'
                            elif strength == 0:
                                label = '已下载原视频'
                            elif len(strength_batch) > 1:
                                label = '同链接已复用降噪结果'
                            else:
                                label = '已下载并降噪'
                            self.events.put((key, '完成', f'100% · {len(raw_sources)} 个视频{label}'))
                        terminal_keys.add(key)
            return True
        except Exception as exc:
            state = '已取消' if cancel.is_set() else '失败'
            for key in keys:
                if key not in locals().get('terminal_keys', set()):
                    self.events.put((key, state, str(exc)))
            return False
        finally:
            for path in marker_paths.values():
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass

    def _download_uncached(self, key, url, cancel, settings, produced_outputs=None):
        folder, quality, cookie = settings[:3]
        browser_auth = len(settings) > 3 and settings[3]
        strength = int(settings[4]) if len(settings) > 4 else 0
        retry_denoise_files = [Path(item) for item in settings[5]] if len(settings) > 5 else []
        if not url:
            title_error = self.jobs.get(key, {}).get('title_error')
            if cancel.is_set():
                self.events.put((key, '已取消', '已取消'))
            elif title_error:
                self.events.put((key, '失败', f'标题图生成失败：{title_error}'))
            else:
                self.events.put((key, '完成', '标题 PNG 已生成'))
            return
        try:
            folder = Path(folder)
            folder.mkdir(parents=True, exist_ok=True)
            existing = {item.resolve() for item in folder.iterdir() if item.is_file()}
            # Isolate unfinished work in the system temp area; published files
            # are copied into the row's person-title folder on completion.
            with tempfile.TemporaryDirectory(prefix='clipassistant-task-') as temporary:
                try:
                    if retry_denoise_files:
                        sources = [item for item in retry_denoise_files if item.is_file()]
                        if len(sources) != len(retry_denoise_files):
                            raise RuntimeError('待重试降噪的原视频已移动或删除，无法重试。')
                    else:
                        self._download(key, url, cancel,
                                       (Path(temporary), quality, cookie, folder, browser_auth, strength))
                        temporary_path = Path(temporary).resolve()
                        sources = [item for item in local_video_files(folder)
                                   if temporary_path not in item.resolve().parents
                                   and item.resolve() not in existing]
                    output_files = []
                    denoise_failures = []
                    from core.denoise import denoise_video
                    for index, source in enumerate(sources, start=1):
                        if cancel.is_set():
                            raise RuntimeError('任务已取消')
                        output = source
                        if strength > 0:
                            self.events.put((key, '处理中', f'降噪 {index}/{len(sources)} · {strength}%'))
                            try:
                                output = denoise_video(
                                    output,
                                    strength_percent=strength,
                                    resource_dir=self.resource_dir,
                                    progress=lambda detail, i=index, n=len(sources):
                                        self.events.put((key, '处理中', f'降噪 {i}/{n} · {detail}')),
                                    cancel=cancel,
                                )
                            except Exception as exc:
                                if cancel.is_set():
                                    raise
                                denoise_failures.append((source, str(exc)))
                                output = source
                        output_files.append(output)
                    if denoise_failures:
                        failed_sources = [str(source) for source, _ in denoise_failures if source.is_file()]
                        self.jobs[key]['denoise_failed_files'] = failed_sources
                        details = '\n'.join(f'{source.name}：{error}' for source, error in denoise_failures)
                        self.events.put((key, DENOISE_PRESERVED_STATE,
                                         f'降噪失败，已保留视频：\n{details}'))
                        return False
                    self.jobs[key]['denoise_failed_files'] = []
                    if produced_outputs is not None:
                        produced_outputs.extend(output_files)
                    label = '已重试降噪' if retry_denoise_files else '已下载并处理'
                    self.events.put((key, '完成', f'100% · {len(output_files)} 个视频{label}'))
                except Exception as exc:
                    # If final publishing fails, recover completed videos from the
                    # per-task temp directory before it is removed.
                    recovered = []
                    sources = local_video_files(temporary)
                    for candidate in sources:
                        try:
                            output_name = video_output_filename(candidate.name)
                            saved = publish_file(candidate, folder, output_name)
                            if saved:
                                recovered.append(saved)
                        except OSError:
                            continue
                    if recovered:
                        locations = '\n'.join(str(item) for item in recovered)
                        raise RuntimeError(f'{exc}\n下载的视频已保存到：\n{locations}') from exc
                    raise
        except Exception as exc:
            self.events.put((key, '已取消' if cancel.is_set() else '失败', str(exc)))
            return False
        return True

    def _download(self, key, url, cancel, settings):
        progress_keys = settings[6] if len(settings) > 6 and isinstance(settings[6], (list, tuple)) else (key,)
        marker_paths = settings[7] if len(settings) > 7 else None
        last_marker_payload = None
        last_marker_write = 0.0
        def update(state, detail=''):
            nonlocal last_marker_payload, last_marker_write
            for event_key in progress_keys:
                self.events.put((event_key, state, detail))
            payload = (state, detail)
            now = time.monotonic()
            if (marker_paths and payload != last_marker_payload and
                    (state != '下载中' or now - last_marker_write >= 0.5)):
                update_processing_markers(marker_paths, state, detail)
                last_marker_payload = payload
                last_marker_write = now
        def check():
            if cancel.is_set():
                raise RuntimeError('任务已取消')
        path, quality, cookie, folder = settings[:4]
        browser_auth = len(settings) > 4 and settings[4]
        try:
            check()
            update('解析中')
            url = unwrap(url)
            host = urlparse(url).hostname
            from website_download import is_tiktok,download_tiktok
            if is_tiktok(url):
                update('解析中','Tikdown 无水印视频')
                def website_progress(done,total):
                    check()
                    if done > 2 * 1024 * 1024 * 1024:
                        raise RuntimeError('视频超过单文件 2 GiB 下载上限')
                    update('下载中',f'{min(99,int(done*100/total))}%' if total else f'{done/1048576:.1f} MB')
                import hashlib
                identity=re.search(r'/video/(\d+)',urlparse(url).path)
                filename=f"TikTok-{identity.group(1) if identity else hashlib.sha256(url.encode()).hexdigest()[:16]}.mp4"
                output_name=video_output_filename(filename)
                if (folder/output_name).is_file():
                    update('下载完成','100% · 同名已跳过');return
                file=download_tiktok(url,path/filename,cancel,website_progress)
                check()
                saved=publish_file(file,folder,output_name)
                update('下载完成','100%' if saved else '100% · 同名已跳过')
                return
            is_instagram = host and (host.lower() == 'instagram.com' or host.lower().endswith('.instagram.com'))
            if host not in ('drive.google.com', 'docs.google.com') and not is_instagram:
                # Resolve wrappers without contacting local or private destinations.
                url = checked_public_redirects(url)
            check()
            host = urlparse(url).hostname
            if host in ('drive.google.com', 'docs.google.com'):
                import gdown
                is_folder = '/folders/' in urlparse(url).path
                if is_folder:
                    update('解析中', '正在读取云端文件夹')
                    auth = drive_auth_options(cookie, path)
                    listing = drive_download_with_auth_retry(
                        gdown.download_folder, cookie=cookie, temporary=path,
                        browser_auth=browser_auth,
                        retry_args={'stop_event': cancel,
                            'on_retry': lambda attempt, error: update('下载中', f'文件夹重试 {attempt}/2 · {type(error).__name__}')},
                        url=url, output=str(path), skip_download=True, quiet=True,
                        timeout=(20, 120), **auth)
                    extensions = VIDEO_SUFFIXES
                    items = sorted(((f'https://drive.google.com/uc?id={item.id}', Path(item.path).name)
                                    for item in listing if Path(item.path).suffix.lower() in extensions
                                    or not Path(item.path).suffix),
                                   key=lambda item: item[1].casefold())
                    if not items:
                        raise RuntimeError('云端文件夹中没有找到可识别的视频文件')
                    if len(items)>500:
                        raise RuntimeError('云端文件夹视频超过 500 个的单批处理上限')
                else:
                    items = [(url, None)]
                check()
                errors = []
                skipped = 0
                downloaded_bytes = 0
                batch_limit = 10 * 1024 * 1024 * 1024
                for index, (file_url, original_name) in enumerate(items):
                    check()
                    filename = safe_video_filename(original_name) if original_name else '该视频'
                    def progress(done, total):
                        check()
                        if downloaded_bytes + done > batch_limit:
                            raise RuntimeError('本批视频超过 10 GiB 总下载上限')
                        suffix = f' · 视频 {index + 1}/{len(items)}' if is_folder else ''
                        update('下载中', (f'{min(99, int(done * 100 / total))}%' if total else '—%（总大小未知）') + suffix)
                    def retry_status(attempt, error):
                        check()
                        update('下载中', f'重试 {attempt}/2 · {type(error).__name__}')
                    def waiting_status():
                        update('下载中', '等待同一链接的另一个任务完成，避免重复下载…')
                    update('下载中', f'0% · 视频 {index + 1}/{len(items)}' if is_folder else '0%')
                    try:
                        if drive_item(file_url, original_name, path, folder, cancel, progress, cookie,
                                      on_retry=retry_status, on_wait=waiting_status,
                                      max_bytes=min(2 * 1024 * 1024 * 1024,batch_limit-downloaded_bytes),
                                      browser_auth=browser_auth,
                                      ffprobe=self.resource_dir / 'ffmpeg' / 'ffprobe.exe'):
                            skipped += 1
                        else:
                            output_name=video_output_filename(filename)
                            saved_path = folder / output_name
                            if saved_path.is_file():downloaded_bytes += saved_path.stat().st_size
                    except Exception as exc:
                        check()
                        errors.append(f'{filename}：{exc}')
                if errors:
                    raise RuntimeError(f'成功 {len(items) - skipped - len(errors)} 个，已存在跳过 {skipped} 个，失败 {len(errors)} 个。\n' + '\n'.join(errors))
                detail = f'100% · {len(items)} 个视频' if is_folder else '100%'
                if skipped:
                    detail += f'（跳过 {skipped}）'
                update('下载完成', detail)
            else:
                import yt_dlp
                def hook(data):
                    check()
                    if data['status'] == 'downloading':
                        total = data.get('total_bytes') or data.get('total_bytes_estimate')
                        done = data.get('downloaded_bytes', 0)
                        if done > 2 * 1024 * 1024 * 1024:
                            raise RuntimeError('视频超过单文件 2 GiB 下载上限')
                        detail = f'{min(99, int(done * 100 / total))}%' if total else '—%（总大小未知）'
                        update('下载中', detail)
                    elif data['status'] == 'finished':
                        update('处理中', '100% · 下载完成，准备后处理')
                # Download one ready-to-play source stream. Do not download
                # separate audio/video streams that require an FFmpeg merge;
                # optional audio denoising happens after the download returns.
                opts = {'outtmpl': str(path / '%(title).150B [%(id)s].%(ext)s'), 'format': 'best', 'noplaylist': True, 'windowsfilenames': True, 'overwrites': False, 'continuedl': True, 'retries': 3, 'socket_timeout': 30, 'max_filesize': 2 * 1024 * 1024 * 1024, 'progress_hooks': [hook], 'quiet': True, 'no_warnings': True}
                if cookie:
                    opts['cookiefile'] = cookie
                with yt_dlp.YoutubeDL(opts) as downloader:
                    result_code = downloader.download([url])
                    if result_code:
                        raise RuntimeError('视频下载失败')
                check()
                files = local_video_files(path)
                if not files:
                    raise RuntimeError('未获得视频文件')
                saved = [publish_file(file, folder,
                                      video_output_filename(file.name))
                         for index, file in enumerate(files)]
                update('下载完成', '100%' if any(saved) else '100% · 同名已跳过')
        except Exception as exc:
            raise RuntimeError(str(exc)) from exc

    def cancel(self):
        for key in getattr(self, 'batch_keys', []):
            if self.jobs[key]['state'] not in ('完成', '失败', '已取消', DENOISE_PRESERVED_STATE):
                self.jobs[key]['cancel'].set()

    def retry(self):
        keys = [key for key in getattr(self, 'batch_keys', [])
                if self.jobs[key]['state'] in ('失败', DENOISE_PRESERVED_STATE)]
        if keys and not self.active:
            self.start(keys)

    def poll(self):
        try:
            while True:
                key, state, detail = self.events.get_nowait()
                if state == 'template_translation_ready':
                    payload=detail if isinstance(detail,dict) else {}
                    translated=payload.get('translations',{})
                    if isinstance(translated,dict):
                        self.template_translation_cache.update(
                            {cache_key:value for cache_key,value in translated.items()
                             if isinstance(cache_key,str) and isinstance(value,dict)})
                        try:
                            save_translation_cache(self.template_translation_cache_path,
                                                   self.template_translation_cache)
                        except OSError as exc:
                            self.status.config(text=f'翻译已完成，但翻译缓存未能写入：{exc}')
                    self.translation_pending=False
                    self.start_button.config(state='normal')
                    translation_error=str(payload.get('error') or '').strip()
                    if translation_error:
                        self.status.config(text=f'引流模板翻译失败，尚未开始下载：{translation_error}')
                        messagebox.showerror('引流模板翻译失败',translation_error,parent=self.root)
                    else:
                        self.status.config(text='引流模板翻译完成，正在生成标题图并开始任务。')
                        self.root.after_idle(self.start)
                    continue
                if key is None:
                    self.active = False
                    self.start_button.config(state='normal')
                    self.extract_button.config(state='normal')
                    if not self.history_paused:
                        self.last_snapshot = self.snapshot()
                    resolved_states = ('完成', DENOISE_PRESERVED_STATE)
                    all_resolved = all(self.jobs[key]['state'] in resolved_states for key in self.batch_keys)
                    denoise_failed = [key for key in self.batch_keys
                                      if self.jobs[key]['state'] == DENOISE_PRESERVED_STATE]
                    if all_resolved and denoise_failed:
                        if not self.embedded:
                            self.root.deiconify()
                            self.root.lift()
                        summary=[]
                        if denoise_failed:
                            summary.append(f'{len(denoise_failed)} 项降噪失败，已保留对应视频版本')
                        self.status.config(text='下载处理已结束；'+'；'.join(summary)+'。可查看失败原因或重试。')
                    elif all_resolved:
                        if self.exit_on_finish.get():
                            if self.embedded:
                                self.exit_on_finish.set(False)
                                self.status.config(text='全部视频已保存；剪辑助手仍保持打开。')
                            else:
                                self.status.config(text='全部视频已保存，软件即将自动退出。')
                                self.start_button.config(state='disabled')
                                self.root.after(1500, self.finish_close)
                        else:
                            if not self.embedded:
                                self.root.deiconify()
                                self.root.lift()
                            destination = Path(self.base.get()).expanduser().resolve()
                            has_downloads=any(self.jobs[key].get('url') for key in self.batch_keys)
                            status_text=(f'全部视频已保存到：{destination}\n各行视频位于对应的“人名-视频名称”子文件夹中。'
                                         if has_downloads else f'引流标题图 PNG 已生成到各行的“人名-视频名称”子文件夹中：{destination}')
                            if has_downloads:
                                status_text += '\n每行对应的引流标题图 PNG 也保存在同一子文件夹中。'
                            warnings=getattr(self,'batch_warnings',[])
                            if warnings:
                                status_text+='\n图片保存失败（视频下载已继续）：\n'+'\n'.join(warnings)
                            self.status.config(text=status_text)
                    else:
                        if not self.embedded:
                            self.root.deiconify()
                            self.root.lift()
                        status_text='有下载失败或取消任务，窗口保留。可查看失败原因或重试。'
                        if denoise_failed:
                            status_text+=f'另有 {len(denoise_failed)} 项降噪失败，已保留对应视频版本。'
                        warnings=getattr(self,'batch_warnings',[])
                        if warnings:
                            status_text+='\n标题图保存失败（视频下载已继续）：\n'+'\n'.join(warnings)
                        self.status.config(text=status_text)
                    if any(self.jobs[key].get('url') for key in self.batch_keys) and (all_resolved or any(
                            self.jobs[key]['state'] in ('完成', DENOISE_PRESERVED_STATE)
                            for key in self.batch_keys)):
                        self.completion_actions.pack(side='right', padx=(8, 0))
                else:
                    self.jobs[key]['state'] = state
                    if state in ('失败', DENOISE_PRESERVED_STATE):
                        self.jobs[key]['error'] = detail
                    label = (DENOISE_ROW_LABEL if state == DENOISE_PRESERVED_STATE else
                             (f'{detail} · {state}' if state in ('下载中', '下载完成', '处理中', '完成') else state))
                    job = self.jobs[key]
                    if job.get('link_count', 1) > 1:
                        row_jobs = [self.jobs[item] for item in self.batch_keys
                                    if self.jobs[item].get('row') == job.get('row')]
                        if state in ('完成', '失败', '已取消', DENOISE_PRESERVED_STATE):
                            resolved = sum(item.get('state') in
                                           ('完成', '失败', '已取消', DENOISE_PRESERVED_STATE)
                                           for item in row_jobs)
                            label = f'{resolved}/{job["link_count"]} 个链接已处理'
                        else:
                            label = f'链接 {job["link_index"]}/{job["link_count"]} · {label}'
                    self._set_row_progress(self.jobs[key]['row'],label)
        except queue.Empty:
            pass
        if not self._stopped:
            self._poll_id = self.root.after(100 if self.active else 350, self.poll)

    def close(self):
        if self.embedded:
            # The shell owns the shared Tk root and coordinates shutdown with
            # the editor and cutout workers. An embedded child must not tear
            # down its host on its own.
            return
        if self.active and not messagebox.askyesno('退出', '仍有下载任务，退出会中断下载。确定退出？'):
            return
        if getattr(self, 'minimize_guard', None):
            self.minimize_guard.uninstall()
        self.hide_title_preview()
        if self.cookie_temp is not None:
            self.cookie_temp.cleanup()
        os._exit(0)


if __name__ == '__main__':
    if os.name == 'nt':
        import ctypes
        # Give Windows a stable application identity so the taskbar uses this app's icon.
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('剪辑助手.Desktop.1')
    root = tk.Tk()
    # Keep the startup window hidden until its fixed 12-row table is ready.
    root.withdraw()
    if '--self-test' in sys.argv:
        import yt_dlp
        import gdown
        import website_download
        from page_library import PageLibrary
        instance = App(root)
        deadline=time.monotonic()+5
        while not instance.rows_ready and time.monotonic()<deadline:
            root.update()
            time.sleep(.005)
        assert len(instance.rows) == 12
        assert all(len(row) == 3 for row in instance.rows)
        assert all(entry.cget('justify') == 'left' for entry in instance.input_entries)
        assert 1 <= int(instance.count.get()) <= 10
        root.update()
        assert len(instance.progress_labels) == 12
        assert not hasattr(instance, 'row_scrollbar')
        geometry=(root.winfo_reqwidth(),root.winfo_reqheight())
        instance.rows[0][0].set('Test person');instance.rows[0][1].set('Long title '*40)
        instance.preview_folder(0);root.update()
        assert geometry==(root.winfo_reqwidth(),root.winfo_reqheight())
        assert not root.attributes('-topmost')
        instance.rows[0][1].set('3 Quiet Signs Holy Spirit Is With You')
        instance.show_title_preview(0);root.update()
        assert instance.title_preview_photo is not None, instance.title_preview_image_label.cget('text')
        assert '2 行标题' in instance.title_preview_heading.cget('text'), instance.title_preview_heading.cget('text')
        instance.title_layout_vars[0].set('3行');instance.show_title_preview(0);root.update()
        assert '3 行标题' in instance.title_preview_heading.cget('text')
        assert len(__import__('local_design').replace_title(instance.title_preview_design(0),instance.rows[0][1].get())['lines'])==3
        instance.title_layout_vars[0].set('全局');root.update()
        instance.title_preview_manual_text.delete('1.0','end')
        instance.title_preview_manual_text.insert('1.0','3 Quiet\nSigns Holy Spirit\nIs With You')
        instance._title_manual_lines_changed()
        instance.show_title_preview(0);root.update()
        manual_design=__import__('local_design').replace_title(
            instance._decorate_title_design(instance.title_preview_design(0),0,instance.rows[0][1].get()),
            instance.rows[0][1].get())
        assert [''.join(run['text'] for run in line['runs']) for line in manual_design['lines']]==[
            '3 Quiet','Signs Holy Spirit','Is With You']
        instance._reset_title_manual_lines();instance.show_title_preview(0);root.update()
        assert instance.title_manual_lines[0] is None
        instance.hide_title_preview()
        page_library=PageLibrary(instance)
        root.update()
        assert page_library.numbers
        page_library.window.destroy()
        root.destroy()
        Path(sys.argv[-1]).write_text('GUI, page data, and bundled download components OK', encoding='utf-8')
        sys.exit(0)
    app = App(root)
    root.update_idletasks()
    root.deiconify()
    root.update_idletasks()
    if os.name == 'nt':
        try:
            set_windows_window_app_id(root.winfo_id(), '剪辑助手.Desktop.1')
            set_windows_window_icon(root.winfo_id(), Path(__file__).resolve().parent / 'assets' / 'download.ico')
            app.minimize_guard = ManualMinimizeOnly(root)
        except Exception as exc:
            print(f'Could not finish native window setup: {exc}', file=sys.stderr)
    # The native launcher owns the startup mutex before loading Python.
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenEventW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.OpenEventW.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        handle = kernel.OpenEventW(0x100000, False, 'Local\\VideoDownloadAssistant.ShowWindow.v2')
        def check_show_request():
            if handle and kernel.WaitForSingleObject(handle, 0) == 0:
                root.deiconify()
                root.lift()
                root.focus_force()
            root.after(150, check_show_request)
        root.after(150, check_show_request)
    root.mainloop()


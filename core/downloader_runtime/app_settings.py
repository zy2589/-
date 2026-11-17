"""Persistent downloader settings and appearance."""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from desktop_ui import PALETTES, apply_appearance


def settings_location():
    configured = os.environ.get('VIDEO_DOWNLOADER_DATA_DIR')
    if configured:
        return Path(configured) / 'settings.json'
    directory = Path(__file__).parent
    if getattr(sys, 'frozen', False):
        directory = Path(sys.executable).parent
        if directory.name.casefold() in ('runtime', '_internal'):
            directory = directory.parent
    return directory / 'settings.json'


def global_template_fallback_path():
    """Store only the shared visual style in writable per-user app data if Documents is blocked."""
    local_app_data = os.environ.get('LOCALAPPDATA')
    if not local_app_data:
        return None
    return Path(local_app_data) / 'ClipAssistant' / 'Downloader' / 'global-template.json'


def canva_page_cache_fallback_path():
    """Store the private page cache in writable per-user data when Documents is protected."""
    local_app_data = os.environ.get('LOCALAPPDATA')
    if not local_app_data:
        return None
    return Path(local_app_data) / 'ClipAssistant' / 'Downloader' / 'canva-page-audit.json'


def seed_user_data(data_directory, bundle_directory):
    """Seed bundled defaults and user-approved initial preferences once."""
    data_directory=Path(data_directory)
    bundle_directory=Path(bundle_directory)
    if data_directory.resolve()==bundle_directory.resolve():return
    data_directory.mkdir(parents=True,exist_ok=True)
    names=('settings.json','canva-page-audit.json','global-template.json','graphic-template-1.json',
           'custom-colors.json','local_templates','bible_backgrounds','bible_presets')
    user_seed=bundle_directory/'user-seed'
    for name in names:
        preferred=user_seed/name
        source=preferred if preferred.exists() else bundle_directory/name
        target=data_directory/name
        if not source.exists() or target.exists():continue
        try:
            if source.is_dir():shutil.copytree(source,target)
            elif source.is_file():shutil.copy2(source,target)
        except PermissionError:
            if name != 'global-template.json':raise
            fallback=global_template_fallback_path()
            if fallback is None:raise
            fallback.parent.mkdir(parents=True,exist_ok=True)
            if not fallback.exists():shutil.copy2(source,fallback)


def rebase_local_fonts(data_directory, bundle_directory):
    """Move template font references off removed downloader folders."""
    data_directory=Path(data_directory)
    bundled_fonts=Path(bundle_directory)/'fonts'
    local_fonts=data_directory/'fonts'
    if not data_directory.is_dir():return

    def update(value):
        changed=False
        if isinstance(value,dict):
            for key,item in list(value.items()):
                if key in ('font_path','footer_font_path') and isinstance(item,str) and item.strip():
                    old=Path(item).expanduser()
                    bundled=bundled_fonts/old.name
                    if bundled.is_file() and (old.is_absolute() or not old.is_file()):
                        # Keep persisted templates independent from PyInstaller's
                        # per-launch extraction directory. local_design resolves
                        # bundled font names inside the application at runtime.
                        value[key]=old.name
                        changed=True
                    elif old.is_file() and old.resolve().parent != local_fonts.resolve():
                        local_fonts.mkdir(parents=True,exist_ok=True)
                        target=local_fonts/old.name
                        if not target.exists():shutil.copy2(old,target)
                        value[key]=str(target.resolve())
                        changed=True
                    elif not old.is_file() and old.is_absolute():
                        value[key]=''
                        changed=True
                else:
                    changed=update(item) or changed
        elif isinstance(value,list):
            for item in value:changed=update(item) or changed
        return changed

    for config in data_directory.rglob('*.json'):
        if config.is_symlink():continue
        try:
            value=json.loads(config.read_text(encoding='utf-8'))
            if update(value):
                temporary=config.with_suffix(config.suffix+'.tmp')
                temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
                os.replace(temporary,config)
        except (OSError,ValueError):
            continue


def read_settings(path):
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def update_settings(path, **changes):
    path = Path(path)
    with path.with_suffix('.lock').open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            _update_settings(path, changes)
        finally:
            if os.name == 'nt':
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def _update_settings(path, changes):
    path = Path(path)
    data = read_settings(path)
    data.update(changes)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         delete=False, suffix='.tmp') as output:
            temporary = Path(output.name)
            json.dump(data, output, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)



def sync_appearance(app):
    value = read_settings(app.settings_path).get("appearance", "浅色")
    if value in PALETTES and value != app.appearance.get():
        app.appearance.set(value)
        apply_appearance(app.root, value)
    app.root.after(1000, lambda: sync_appearance(app))

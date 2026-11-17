import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


RUNTIME = Path(__file__).resolve().parents[1] / 'core' / 'downloader_runtime'
sys.path.insert(0, str(RUNTIME))

import app_settings
import page_cache


class DownloaderTemplateFallbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.local_app_data = self.root / 'LocalAppData'
        self.documents = self.root / 'Documents' / 'DownloadSettings'
        self.bundle = self.root / 'bundle'
        self.documents.mkdir(parents=True)
        self.bundle.mkdir()
        self.env = patch.dict(os.environ, {'LOCALAPPDATA': str(self.local_app_data)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_default_template_seeding_falls_back_when_documents_denies_write(self):
        default = {'backgroundEnabled': True, 'lines': [{'size': 52, 'runs': []}]}
        source = self.bundle / 'global-template.json'
        source.write_text(__import__('json').dumps(default), encoding='utf-8')
        target = self.documents / 'global-template.json'
        fallback = app_settings.global_template_fallback_path()
        real_copy = shutil.copy2

        def deny_documents_template(src, dst, *args, **kwargs):
            if Path(dst) == target:
                raise PermissionError(13, 'simulated protected-folder denial', str(target))
            return real_copy(src, dst, *args, **kwargs)

        with patch.object(app_settings.shutil, 'copy2', side_effect=deny_documents_template):
            app_settings.seed_user_data(self.documents, self.bundle)

        self.assertFalse(target.exists())
        self.assertTrue(fallback.is_file())
        self.assertEqual(page_cache.read_style(self.documents / 'settings.json'), default)

    def test_template_edits_persist_to_fallback_after_write_denial(self):
        target = self.documents / 'global-template.json'
        target.write_text('{"backgroundEnabled": false}', encoding='utf-8')
        old_time = 1_700_000_000_000_000_000
        os.utime(target, ns=(old_time, old_time))
        fallback = app_settings.global_template_fallback_path()
        real_write = page_cache.write_cache
        saved = {'backgroundEnabled': True, 'lines': [{'runs': [
            {'text': 'WELCOME', 'color': '#0088ff'}]}]}

        def deny_documents_template(path, data):
            if Path(path) == target:
                raise PermissionError(13, 'simulated protected-folder denial', str(target))
            return real_write(path, data)

        with patch.object(page_cache, 'write_cache', side_effect=deny_documents_template):
            page_cache.save_style(self.documents / 'settings.json', saved)

        self.assertTrue(fallback.is_file())
        self.assertEqual(page_cache.read_style(self.documents / 'settings.json')['custom_colors'],
                         {'WELCOME': '#0088ff'})

    def test_missing_canva_cache_recovers_template_one_from_local_audit(self):
        audit = self.documents / 'Canva本地页面信息.html'
        audit.write_text(
            '<article id="template-1"><h2>模板 1</h2><pre>'
            'Message us on Whats/App at\n+1(205)671-4976\nLINK IN MY BIO'
            '</pre></article><article id="template-3"><pre>other page</pre></article>',
            encoding='utf-8',
        )
        cache = self.documents / 'canva-page-audit.json'

        pages = page_cache.read_pages(cache)

        self.assertEqual(list(pages), [1])
        footer, phone = page_cache.page_footer(pages[1])
        self.assertIn('LINK IN MY BIO', footer)
        self.assertEqual(phone, '+1(205)671-4976')
        self.assertTrue(cache.is_file())

    def test_missing_canva_cache_uses_writable_fallback_when_documents_blocks_replace(self):
        audit = self.documents / 'Canva本地页面信息.html'
        audit.write_text(
            '<article id="template-1"><pre>Message us on Whats/App at\n'
            '+1(205)671-4976\nLINK IN MY BIO</pre></article>',
            encoding='utf-8',
        )
        cache = self.documents / 'canva-page-audit.json'
        fallback = app_settings.canva_page_cache_fallback_path()
        original_replace = Path.replace

        def deny_documents_replace(source, target):
            if Path(target) == cache:
                raise PermissionError(13, 'simulated protected-folder rename denial', str(target))
            return original_replace(source, target)

        with patch.object(Path, 'replace', new=deny_documents_replace):
            pages = page_cache.read_pages(cache)

        self.assertEqual(page_cache.page_footer(pages[1])[1], '+1(205)671-4976')
        self.assertFalse(cache.exists())
        self.assertTrue(fallback.is_file())
        self.assertEqual(page_cache.resolved_cache_path(cache), fallback)
        self.assertEqual(sorted(page_cache.read_pages(cache)), [1])


if __name__ == '__main__':
    unittest.main()

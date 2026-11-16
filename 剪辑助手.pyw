import sys


# Keep development launches from scattering __pycache__ folders in the project.
sys.dont_write_bytecode = True

from core.ui import ClipAssistant


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        from pathlib import Path
        import time

        try:
            marker = Path(sys.argv[sys.argv.index("--self-test") + 1])
        except IndexError:
            raise SystemExit("--self-test requires a result-file path")

        app = ClipAssistant()
        app._startup_window_revealed = True
        app.root.withdraw()
        deadline = time.monotonic() + 45

        def finish_self_test(ok, detail):
            try:
                app._finish_shutdown()
            except Exception as exc:
                ok = False
                detail = f"{detail}; shutdown: {exc!r}"
                try:
                    if app.root.winfo_exists():
                        app.root.destroy()
                except Exception:
                    pass
            marker.write_text(("PASS: " if ok else "FAIL: ") + detail, encoding="utf-8")

        def check_download_page():
            downloader = app.downloader_app
            if downloader is not None and downloader.rows_ready:
                try:
                    assert len(downloader.rows) == 12, len(downloader.rows)
                    assert len(downloader.progress_labels) == 12, len(downloader.progress_labels)
                    assert all(len(row) == 3 for row in downloader.rows)
                except Exception as exc:
                    finish_self_test(False, f"download page assertions: {exc!r}")
                else:
                    finish_self_test(True, "main window, dynamic downloader load, and 12-row table OK")
                return
            if app.downloader_import_error is not None:
                finish_self_test(False, f"downloader import: {app.downloader_import_error!r}")
                return
            if time.monotonic() >= deadline:
                finish_self_test(False, "timed out waiting for the downloader table")
                return
            app.root.after(50, check_download_page)

        app.root.after(50, check_download_page)
        app.run()
        if not marker.is_file() or not marker.read_text(encoding="utf-8").startswith("PASS:"):
            raise SystemExit(1)
        raise SystemExit(0)

    ClipAssistant().run()

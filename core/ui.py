from __future__ import annotations

import json
import ctypes
import importlib.util
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
import uuid
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

try:
    from tkinterdnd2 import TkinterDnD
except ImportError:
    TkinterDnD = None

from .pipeline import DownloadTask, run_task
from .downloader_runtime.desktop_ui import apply_appearance
from .embedded_editor import EmbeddedEditor


COLORS = {
    "bg": "#111213",
    "sidebar": "#151618",
    "panel": "#1B1C1E",
    "input": "#18191B",
    "border": "#404247",
    "text": "#EFF0F1",
    "muted": "#A0A3A8",
    "accent": "#68A9A2",
    "accent_hover": "#80BCB5",
    "soft": "#252629",
    "warning": "#C8A86E",
    "error": "#C66F73",
}
CUTOUT_PAGE_COUNT = 2


def resource_root() -> Path:
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return root / "resources"


def bundle_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def data_root() -> Path:
    profile = Path(os.environ.get("USERPROFILE") or Path.home())
    path = profile / "Documents" / "ChatGPT" / "剪辑助手" / "用户数据"
    path.mkdir(parents=True, exist_ok=True)
    return path


class ClipAssistant:
    def __init__(self) -> None:
        self._set_app_user_model_id()
        self.root = TkinterDnD.Tk() if TkinterDnD else tk.Tk()
        # Keep the native window unmapped until the first page has finished
        # constructing its fixed task rows. Mapping an empty shell and then
        # filling it made startup look like a page refresh.
        self.root.withdraw()
        self._startup_window_revealed = False
        self._startup_window_started_at = time.monotonic()
        self._page_transition_generation = 0
        self.root.title("剪辑助手")
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        self.window_ratio = 1.68
        available_width = max(820, screen_width - 80)
        available_height = max(488, screen_height - 100)
        initial_width = min(1616, available_width, round(available_height * self.window_ratio))
        initial_width = max(820, initial_width)
        initial_height = round(initial_width / self.window_ratio)
        self.root.geometry(f"{initial_width}x{initial_height}")
        self.root.minsize(820, round(820 / self.window_ratio))
        # The download workspace is the app's landing page and stays above
        # other windows while active. Other workspaces clear this flag in
        # _show_page so the editor/cutout do not unexpectedly pin the app.
        try:
            self.root.attributes("-topmost", True)
        except tk.TclError:
            pass
        self._download_topmost_active = True
        # Keep the preferred ratio only for the initial window size. A hard
        # WM aspect/max-size constraint prevents Windows from maximizing to
        # the full monitor work area and leaves visible strips around the app.
        # The page layouts are responsive, so let the window manager own the
        # maximized bounds.
        self.root.configure(bg=COLORS["bg"])
        self.root.option_add("*Font", ("Microsoft YaHei UI", 10))
        self._set_dark_dwm_border(self.root.winfo_id())

        self.bundle_dir = bundle_root()
        self.resource_dir = resource_root()
        icon_png = self.bundle_dir / "assets" / "剪辑助手图标-128.png"
        icon_ico = self.bundle_dir / "assets" / "剪辑助手.ico"
        try:
            self.icon_photo = tk.PhotoImage(file=str(icon_png))
            self.root.iconphoto(True, self.icon_photo)
        except tk.TclError:
            self.icon_photo = None
        if icon_ico.is_file():
            try:
                self.root.iconbitmap(str(icon_ico))
            except tk.TclError:
                pass
        self._set_native_app_icon(icon_ico)
        self.settings_path = data_root() / "settings.json"
        self.support_root = data_root() / "编辑器数据"
        self.support_root.mkdir(parents=True, exist_ok=True)
        self.application_dir = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent
        self.editor_engine_dir = self.application_dir / "剪辑助手内核"
        if not getattr(sys, "frozen", False):
            # The source launcher lives in the repository, while the complete
            # WebView2/Node editor kernel is staged beside the packaged app.
            # Prefer that kernel (or an installed copy) so `运行剪辑助手.bat`
            # can still open the editor without pointing at a nonexistent
            # `<repository>\剪辑助手内核` directory.
            local_app_data = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
            candidates = (
                self.application_dir / "release" / "剪辑助手" / "剪辑助手内核",
                self.application_dir / ".build" / "剪辑助手内核",
                local_app_data / "Programs" / "剪辑助手" / "剪辑助手内核",
            )
            required = (
                Path("runtime") / "node" / "node.exe",
                Path("剪辑助手.WebView.dll"),
                Path("Modules") / "剪辑助手" / "剪辑界面" / "src" / "bootstrap.mjs",
            )
            for candidate in candidates:
                if all((candidate / relative).is_file() for relative in required):
                    self.editor_engine_dir = candidate
                    break
        self.embedded_editor: EmbeddedEditor | None = None
        self.embedded_editor_frame = None
        self.editor_embed_error = None
        self.user_settings = self._read_settings()
        self.default_output = self.user_settings.get("output", str(Path.home() / "Downloads"))
        try:
            self.default_strength = max(0, min(100, int(self.user_settings.get("strength", 30))))
        except (TypeError, ValueError):
            self.default_strength = 30
        self.default_theme = self.user_settings.get("theme", "白天")
        self.events: queue.Queue = queue.Queue()
        self.tasks: list[dict] = []
        self.cutout_semaphore = threading.Semaphore(2)
        self.next_task_id = 1
        self.processing = False
        self.cancel_event: threading.Event | None = None
        self.close_after_processing = False
        self.matting_window = None
        self.matting_windows: list[object] = []
        self.cutout_tasks: list[dict] = []
        self.cutout_pages: list[dict] = []
        self.current_cutout_page = 0
        self.cutout_page_built = False
        self.cutout_loading = False
        self.downloader_app = None
        self.download_host = None
        self.download_loading = False
        self.downloader_importing = False
        self.downloader_import_ready = False
        self.downloader_module = None
        self.downloader_import_error = None
        self.rotoscope_module = None
        self.rotoscope_importing = False
        self.rotoscope_import_ready = False
        self.rotoscope_import_error = None
        self.cutout_prewarm_requested = False
        self.cutout_open_pending = False
        self.current_page = "download"
        self.media_paths: list[str] = []
        self.preview_photo = None
        self.selected_media: str | None = None

        ffmpeg_dir = self.resource_dir / "ffmpeg"
        os.environ["PATH"] = str(ffmpeg_dir) + os.pathsep + os.environ.get("PATH", "")
        self._configure_styles()
        self._build_shell()
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.after(100, self._poll_events)

    def _configure_styles(self) -> None:
        style = ttk.Style(self.root)
        style.theme_use("clam")
        apply_appearance(self.root, "深色")
        style.configure("TFrame", background=COLORS["bg"])
        style.configure("Panel.TFrame", background=COLORS["panel"])
        style.configure("TLabel", background=COLORS["bg"], foreground=COLORS["text"])
        style.configure("Panel.TLabel", background=COLORS["panel"], foreground=COLORS["text"])
        style.configure("Muted.TLabel", background=COLORS["bg"], foreground=COLORS["muted"])
        style.configure("PanelMuted.TLabel", background=COLORS["panel"], foreground=COLORS["muted"])
        style.configure(
            "Treeview", background=COLORS["panel"], fieldbackground=COLORS["panel"],
            foreground=COLORS["text"], borderwidth=0, rowheight=34,
            font=("Microsoft YaHei UI", 10),
        )
        style.configure(
            "Treeview.Heading", background=COLORS["soft"], foreground=COLORS["muted"],
            borderwidth=0, font=("Microsoft YaHei UI", 10, "bold"), padding=(8, 8),
        )
        style.map("Treeview", background=[("selected", "#3A4647")], foreground=[("selected", "#FFFFFF")])
        style.configure(
            "Horizontal.TProgressbar", background=COLORS["accent"], troughcolor=COLORS["soft"],
            bordercolor=COLORS["soft"], lightcolor=COLORS["accent"], darkcolor=COLORS["accent"],
        )
        style.configure("TButton", padding=(8, 3), font=("Microsoft YaHei UI", 10))
        style.configure("Primary.TButton", padding=(9, 3), font=("Microsoft YaHei UI", 10, "bold"))
        style.configure("Nav.TButton", background=COLORS["sidebar"], foreground=COLORS["muted"],
                        anchor="w", padding=(14, 8), font=("Microsoft YaHei UI", 10, "bold"))
        style.map("Nav.TButton", background=[("pressed", COLORS["soft"]),
                                              ("active", COLORS["soft"]),
                                              ("!disabled", COLORS["sidebar"])],
                  foreground=[("disabled", COLORS["muted"]),
                              ("active", COLORS["text"]),
                              ("!disabled", COLORS["muted"])])
        style.configure("NavSelected.TButton", background="#ECEEEF", foreground="#17191C",
                        anchor="w", padding=(12, 7), font=("Microsoft YaHei UI", 10, "bold"))
        style.map("NavSelected.TButton", background=[("disabled", "#BFC2C6"),
                                                      ("pressed", "#C7CACE"),
                                                      ("active", "#FFFFFF"),
                                                      ("!disabled", "#ECEEEF")],
                  foreground=[("disabled", "#66676A"),
                              ("!disabled", "#17181A")])
        style.layout("NavSelected.TButton", style.layout("Primary.TButton"))
        style.layout("Cutout.TButton", style.layout("TButton"))
        style.layout("CutoutSelected.TButton", style.layout("Primary.TButton"))
        style.configure("Cutout.TButton", background=COLORS["soft"], foreground=COLORS["text"],
                        padding=(8, 4), font=("Microsoft YaHei UI", 10, "bold"))
        style.map("Cutout.TButton", background=[("pressed", COLORS["border"]),
                                                 ("active", COLORS["panel"]),
                                                 ("!disabled", COLORS["soft"])],
                  foreground=[("disabled", COLORS["muted"]),
                              ("!disabled", COLORS["text"])])
        style.configure("CutoutSelected.TButton", background="#ECEEEF", foreground="#17191C",
                        bordercolor="#ECEEEF", lightcolor="#ECEEEF", darkcolor="#ECEEEF",
                        relief="flat", padding=(7, 3), font=("Microsoft YaHei UI", 10, "bold"))
        style.map("CutoutSelected.TButton", background=[("pressed", "#354746"),
                                                         ("active", "#FFFFFF"),
                                                         ("!disabled", "#ECEEEF")],
                  bordercolor=[("!disabled", "#ECEEEF")],
                  foreground=[("!disabled", "#17191C")])
        style.layout("CutoutAction.TButton", style.layout("TButton"))
        style.configure("CutoutAction.TButton", background=COLORS["soft"], foreground=COLORS["accent_hover"],
                        bordercolor=COLORS["border"], lightcolor=COLORS["soft"], darkcolor=COLORS["soft"],
                        relief="flat", padding=(10, 4), font=("Microsoft YaHei UI", 10, "bold"))
        style.map("CutoutAction.TButton", background=[("pressed", "#343A3A"),
                                                       ("active", "#303536"),
                                                       ("!disabled", COLORS["soft"])],
                  foreground=[("!disabled", COLORS["accent_hover"])],
                  bordercolor=[("active", COLORS["border"]), ("!disabled", COLORS["border"])])
        style.configure("TCombobox", fieldbackground=COLORS["input"], background=COLORS["soft"], foreground=COLORS["text"], arrowcolor=COLORS["text"])
        style.map("TCombobox", fieldbackground=[("readonly", COLORS["input"])], foreground=[("readonly", COLORS["text"])])

    def _set_native_app_icon(self, icon_path: Path) -> None:
        if os.name != "nt" or not icon_path.is_file():
            return
        try:
            import ctypes
            from ctypes import wintypes
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.LoadImageW.argtypes = (wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
                                          ctypes.c_int, ctypes.c_int, wintypes.UINT)
            user32.LoadImageW.restype = wintypes.HANDLE
            user32.SendMessageW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
            user32.SendMessageW.restype = wintypes.LRESULT
            image = user32.LoadImageW(None, str(icon_path), 1, 0, 0, 0x0010 | 0x0040)
            if not image:
                return
            self._native_icon_handle = image
            self.root.update_idletasks()
            hwnd = wintypes.HWND(self.root.winfo_id())
            user32.SendMessageW(hwnd, 0x0080, 0, image)
            user32.SendMessageW(hwnd, 0x0080, 1, image)
        except (AttributeError, OSError, tk.TclError):
            self._native_icon_handle = None

    @staticmethod
    def _set_dark_dwm_border(hwnd) -> None:
        """Keep the Windows 11 non-client outline dark when the window is maximized."""
        if os.name != "nt":
            return
        try:
            import ctypes
            from ctypes import wintypes
            dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
            dwmapi.DwmSetWindowAttribute.argtypes = (
                wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
            )
            dwmapi.DwmSetWindowAttribute.restype = ctypes.c_long
            # DWMWA_BORDER_COLOR uses COLORREF (0x00BBGGRR).
            dark = ctypes.c_uint(0x00131211)
            dwmapi.DwmSetWindowAttribute(wintypes.HWND(hwnd), 34,
                                          ctypes.byref(dark), ctypes.sizeof(dark))
        except (AttributeError, OSError, TypeError, ValueError):
            pass

    @staticmethod
    def _set_app_user_model_id() -> None:
        if os.name != "nt":
            return
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("剪辑助手.Desktop.1")
        except (AttributeError, OSError):
            pass


    def _read_settings(self) -> dict:
        try:
            value = json.loads(self.settings_path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_settings(self):
        self.user_settings["output"] = self.output_var.get().strip()
        self.user_settings["strength"] = int(self.global_strength.get())
        self.user_settings["theme"] = self.theme_var.get()
        self.settings_path.write_text(json.dumps(self.user_settings, ensure_ascii=False, indent=2), encoding="utf-8")

    def _button(self, parent, text, command, primary=False, width=None):
        return ttk.Button(
            parent, text=text, command=command, width=width,
            style="Primary.TButton" if primary else "TButton",
            cursor="hand2",
        )

    def _label(self, parent, text, muted=False, size=10, bold=False, **kwargs):
        size = max(10, size)
        return tk.Label(
            parent,
            text=text,
            bg=kwargs.pop("bg", COLORS["bg"]),
            fg=COLORS["muted"] if muted else COLORS["text"],
            font=("Microsoft YaHei UI", size, "bold" if bold else "normal"),
            **kwargs,
        )

    def _entry(self, parent, variable, **kwargs):
        return tk.Entry(
            parent, textvariable=variable, bg=COLORS["input"], fg=COLORS["text"],
            insertbackground=COLORS["text"], relief="flat", highlightthickness=1,
            highlightbackground=COLORS["border"], highlightcolor=COLORS["border"],
            font=("Microsoft YaHei UI", 11), **kwargs,
        )

    def _build_shell(self) -> None:
        self.root.grid_rowconfigure(0, weight=1)
        self.root.grid_columnconfigure(2, weight=1)
        self.sidebar = tk.Frame(self.root, bg=COLORS["sidebar"], width=210)
        self.sidebar.grid(row=0, column=0, sticky="nsew")
        self.sidebar.grid_propagate(False)
        self.shell_divider = tk.Frame(self.root, bg="#3D3D41", width=2)
        self.shell_divider.grid(row=0, column=1, sticky="ns")

        brand = tk.Frame(self.sidebar, bg=COLORS["sidebar"], padx=22, pady=24)
        brand.pack(fill="x")
        logo = tk.Frame(brand, bg=COLORS["sidebar"], width=38, height=38)
        logo.pack(side="left")
        logo.pack_propagate(False)
        if self.icon_photo is not None:
            self.brand_icon = self.icon_photo.subsample(4, 4)
            tk.Label(logo, image=self.brand_icon, bg=COLORS["sidebar"], bd=0).pack(expand=True)
        else:
            tk.Label(logo, text="剪", bg=COLORS["accent"], fg="#0D1914",
                     font=("Microsoft YaHei UI", 16, "bold")).pack(expand=True)
        tk.Label(brand, text="剪辑助手", bg=COLORS["sidebar"], fg=COLORS["text"],
                 font=("Microsoft YaHei UI", 15, "bold")).pack(side="left", padx=(10, 0))

        self.nav_download = self._nav_button(self.sidebar, "下载区域", self.show_download)
        self.nav_download.pack(fill="x", padx=12, pady=(18, 5))
        self.nav_projects = self._nav_button(self.sidebar, "剪辑区域", self.show_projects)
        self.nav_projects.pack(fill="x", padx=12, pady=5)
        self.nav_cutout = self._nav_button(self.sidebar, "抠图区域", self.open_cutout)
        self.nav_cutout.pack(fill="x", padx=12, pady=5)
        tk.Frame(self.sidebar, bg=COLORS["sidebar"]).pack(fill="both", expand=True)
        tk.Label(self.sidebar, text="本机处理", bg=COLORS["sidebar"], fg=COLORS["muted"],
                 font=("Microsoft YaHei UI", 10)).pack(anchor="w", padx=24, pady=20)

        self.main = tk.Frame(self.root, bg=COLORS["bg"])
        self.main.grid(row=0, column=2, sticky="nsew")
        self.main.grid_rowconfigure(0, weight=1)
        self.main.grid_columnconfigure(0, weight=1)
        self.page_stage = tk.Frame(self.main, bg=COLORS["bg"])
        self.page_stage.grid(row=0, column=0, sticky="nsew")
        self.page_stage.grid_rowconfigure(0, weight=1)
        self.page_stage.grid_columnconfigure(0, weight=1)
        self.page_frames = {
            "download": tk.Frame(self.page_stage, bg=COLORS["bg"], padx=4, pady=4),
            "projects": tk.Frame(self.page_stage, bg=COLORS["bg"]),
            "cutout": tk.Frame(self.page_stage, bg=COLORS["bg"], padx=12, pady=8),
        }
        for frame in self.page_frames.values():
            frame.grid(row=0, column=0, sticky="nsew")
        self.page_body = self.page_frames["download"]
        self.page_body.tkraise()
        self.root.update_idletasks()
        self.show_download()
        self.root.after_idle(self._reveal_startup_window_when_ready)
        # Prepare the cutout workspace behind the landing page so the first
        # visit does not reveal an empty shell while its widgets are built.
        self.root.after(600, self._prewarm_cutout_workspace)

    def _nav_button(self, parent, text, command):
        return ttk.Button(parent, text=text, command=command, style="Nav.TButton", cursor="hand2")

    def _activate_nav(self, active):
        for button in (self.nav_download, self.nav_projects, self.nav_cutout):
            button.configure(style="Nav.TButton")
        active.configure(style="NavSelected.TButton")

    def _clear_body(self):
        for child in self.page_body.winfo_children():
            if child is getattr(self, "download_host", None):
                child.grid_remove()
                continue
            child.destroy()

    def _show_page(self, name: str, nav) -> None:
        target = self.page_frames[name]
        page_changed = self.current_page != name
        if name != "cutout":
            self.cutout_open_pending = False
        # All area frames stay mapped for the lifetime of the shell. Switching
        # only changes their stacking order, so returning to a page reuses its
        # existing widgets and media/WebView state instead of remapping and
        # repainting the full surface.
        if name != "projects" and self.embedded_editor and self.embedded_editor.is_running():
            # Release editor keyboard focus while its native child stays alive
            # behind the selected page.
            try:
                nav.focus_set()
            except tk.TclError:
                pass
        self.page_body = target
        self.current_page = name
        self._activate_nav(nav)
        if self.downloader_app:
            if name != "download":
                self.downloader_app.hide_title_preview()
            self.downloader_app.set_view_active(name == "download")
        for index, item in enumerate(self.cutout_pages):
            editor = item.get("editor")
            if editor is not None:
                editor.set_background_active(name == "cutout" and index == self.current_cutout_page)
        # Finish view state and popup cleanup before exposing the destination
        # frame; this avoids painting an intermediate, partially updated page.
        if page_changed:
            target.tkraise()
            # Let Tk coalesce its normal paint work. Forcing update_idletasks()
            # here synchronously repaints the whole widget tree between the
            # Tk page restack and the native WebView2 child surface, exposing
            # an intermediate frame as a visible flash.
            self._queue_download_topmost(name == "download")

    def _queue_download_topmost(self, active: bool) -> None:
        """Apply the download-only z-order after the current page paint settles."""
        self._page_transition_generation += 1
        generation = self._page_transition_generation

        def apply_if_current():
            if generation != self._page_transition_generation:
                return
            try:
                self._set_download_topmost(active)
            except (OSError, AttributeError, tk.TclError):
                pass

        try:
            self.root.after_idle(apply_if_current)
        except tk.TclError:
            pass

    def _reveal_startup_window_when_ready(self):
        """Show one fully built landing page instead of exposing row-by-row setup."""
        try:
            if self._startup_window_revealed or not self.root.winfo_exists():
                return
            app = self.downloader_app
            loading = bool(self.download_loading or self.downloader_importing)
            rows_ready = bool(app and (app.rows_ready or len(app.rows) >= 12))
            timed_out = time.monotonic() - self._startup_window_started_at >= 25
            if not rows_ready and (loading or app is not None) and not timed_out:
                self.root.after(20, self._reveal_startup_window_when_ready)
                return
            self._startup_window_revealed = True
            self.root.deiconify()
        except tk.TclError:
            return

    def _set_download_topmost(self, active: bool) -> None:
        """Change only the window z-order, without forcing a Tk/WebView repaint."""
        active = bool(active)
        if getattr(self, "_download_topmost_active", None) == active:
            return
        if os.name == "nt":
            from ctypes import wintypes

            user32 = ctypes.WinDLL("user32", use_last_error=True)
            get_ancestor = user32.GetAncestor
            get_ancestor.argtypes = (wintypes.HWND, wintypes.UINT)
            get_ancestor.restype = wintypes.HWND
            set_window_pos = user32.SetWindowPos
            set_window_pos.argtypes = (
                wintypes.HWND, wintypes.HWND,
                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                wintypes.UINT,
            )
            set_window_pos.restype = wintypes.BOOL
            widget_hwnd = wintypes.HWND(self.root.winfo_id())
            # Tk's winfo_id can be the client HWND. Topmost belongs to the
            # real top-level window; changing the client HWND only restacks
            # the page surface and leaves the whole app pinned on top.
            hwnd = get_ancestor(widget_hwnd, 2)  # GA_ROOT
            if not hwnd:
                raise ctypes.WinError(ctypes.get_last_error())
            insert_after = ctypes.c_void_p(-1 if active else -2)  # HWND_TOPMOST / HWND_NOTOPMOST
            # This operation only changes Z order. The client pixels are
            # already current after tkraise(); asking Windows to repaint the
            # entire parent here creates the visible flash during navigation.
            flags = 0x0001 | 0x0002 | 0x0008 | 0x0010 | 0x0200  # NOSIZE | NOMOVE | NOREDRAW | NOACTIVATE | NOOWNERZORDER
            if not set_window_pos(hwnd, insert_after, 0, 0, 0, 0, flags):
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            self.root.attributes("-topmost", active)
        self._download_topmost_active = active

    def _card(self, parent, **kwargs):
        return tk.Frame(
            parent, bg=COLORS["panel"], highlightbackground=COLORS["border"],
            highlightthickness=1, padx=18, pady=16, **kwargs,
        )

    def show_download(self):
        if self.downloader_app and not self.downloader_app._stopped:
            self._show_page("download", self.nav_download)
            return
        self._show_original_downloader()
        return

    def _show_original_downloader(self):
        self._show_page("download", self.nav_download)
        if self.downloader_app and not self.downloader_app._stopped:
            return
        if self.download_loading:
            return
        page = self.page_frames["download"]
        for child in page.winfo_children():
            child.destroy()
        loading = self._label(page, "正在打开视频下载…", muted=True)
        loading.place(relx=0.5, rely=0.5, anchor="center")
        self.download_loading = True
        self.root.after(30, self._load_original_downloader)

    def _load_original_downloader(self):
        if self.downloader_module is not None:
            self._mount_original_downloader()
            return
        if self.downloader_import_error is not None:
            self.download_loading = False
            self._show_downloader_error(self.downloader_import_error)
            return
        if self.downloader_importing:
            self.root.after(30, self._poll_downloader_import)
            return
        try:
            runtime_dir = self.bundle_dir / "core" / "downloader_runtime"
            if not runtime_dir.is_dir():
                raise FileNotFoundError(f"内置下载器组件缺失：{runtime_dir}")
            if str(runtime_dir) not in sys.path:
                sys.path.insert(0, str(runtime_dir))
            os.environ["VIDEO_DOWNLOADER_DATA_DIR"] = str(data_root() / "下载设置")
            self.downloader_importing = True
            self.downloader_import_ready = False
            self.downloader_import_error = None

            def import_module():
                try:
                    module_spec = importlib.util.spec_from_file_location(
                        "clipassistant_downloader", runtime_dir / "app.py"
                    )
                    if module_spec is None or module_spec.loader is None:
                        raise ImportError("无法载入内置下载器")
                    module = importlib.util.module_from_spec(module_spec)
                    sys.modules[module_spec.name] = module
                    module_spec.loader.exec_module(module)
                    self.downloader_module = module
                except Exception as exc:
                    self.downloader_import_error = exc
                finally:
                    self.downloader_import_ready = True
            threading.Thread(target=import_module, name="downloader-module-load", daemon=True).start()
            self.root.after(30, self._poll_downloader_import)
        except Exception as exc:
            self.download_loading = False
            self._show_downloader_error(exc)

    def _poll_downloader_import(self):
        if not self.root.winfo_exists():
            return
        if not self.downloader_import_ready:
            self.root.after(30, self._poll_downloader_import)
            return
        self.downloader_importing = False
        self.downloader_import_ready = False
        if self.downloader_import_error is not None:
            error = self.downloader_import_error
            self.downloader_import_error = None
            self.download_loading = False
            if self.current_page == "download":
                self._show_downloader_error(error)
            return
        if self.current_page == "download":
            self._mount_original_downloader()
        else:
            self.download_loading = False

    def _mount_original_downloader(self):
        if self.current_page != "download" or self.downloader_module is None:
            self.download_loading = False
            return
        try:
            page = self.page_frames["download"]
            for child in page.winfo_children():
                child.destroy()
            host = tk.Frame(page, bg=COLORS["bg"], bd=0, highlightthickness=0)
            host.pack(fill="both", expand=True)
            self.download_host = host
            self.downloader_app = self.downloader_module.App(
                self.root,
                host=host,
                resource_dir=self.resource_dir,
                editor_callback=self.show_projects,
                cutout_callback=self.open_cutout,
            )
        except Exception as exc:
            self._show_downloader_error(exc)
        finally:
            self.download_loading = False

    def _show_downloader_error(self, error):
        if self.current_page != "download":
            return
        page = self.page_frames["download"]
        for child in page.winfo_children():
            child.destroy()
        self._label(page, f"视频下载页面打开失败：{error}", muted=True,
                    wraplength=640, justify="left").place(relx=0.04, rely=0.06, anchor="nw")
        self.root.after_idle(self._reveal_startup_window_when_ready)

    def _close_downloader_view(self):
        if self.downloader_app:
            self.downloader_app.destroy_embedded()
            self.downloader_app = None

    def _field(self, parent, label, variable, row, column, colspan=1):
        box = tk.Frame(parent, bg=COLORS["panel"])
        box.grid(row=row, column=column, columnspan=colspan, sticky="ew", padx=(0 if column == 0 else 10, 0), pady=(0, 10))
        box.grid_columnconfigure(0, weight=1)
        self._label(box, label, muted=True, size=9, bg=COLORS["panel"]).pack(anchor="w", pady=(0, 5))
        self._entry(box, variable).pack(fill="x")

    def _update_strength_labels(self, _value=None):
        if hasattr(self, "global_strength_label"):
            value = self.global_strength.get()
            self.global_strength_label.configure(text=f"{value}%")
            self.default_strength = value
            if hasattr(self, "task_tree") and self.task_tree.winfo_exists():
                for item in self.tasks:
                    if item["task"].strength_mode == "全局" and self.task_tree.exists(item["id"]):
                        task = item["task"]
                        self.task_tree.item(item["id"], values=(task.name, task.title, f"全局 {value}%", item["state"]))

    def _update_task_strength_label(self, _value=None):
        if hasattr(self, "task_strength_label"):
            self.task_strength_label.configure(text=f"{self.task_strength.get()}%")

    def _toggle_task_strength(self):
        self.task_scale.configure(state="normal" if self.individual_strength.get() else "disabled")

    def choose_output(self):
        chosen = filedialog.askdirectory(parent=self.root, initialdir=self.output_var.get() or str(Path.home()))
        if chosen:
            self.output_var.set(chosen)
            self.default_output = chosen

    def add_task(self):
        try:
            task = DownloadTask(
                number=self.number_var.get().strip(),
                name=self.name_var.get().strip(),
                title=self.title_var.get().strip(),
                promotion=self.promotion_text.get("1.0", "end").strip(),
                url=self.url_var.get().strip(),
                output_root=self.output_var.get().strip(),
                theme=self.theme_var.get(),
                strength_mode="单条" if self.individual_strength.get() else "全局",
                strength_percent=self.task_strength.get() if self.individual_strength.get() else None,
            )
            task.folder_name
            if not task.name or not task.title:
                raise ValueError("请填写名称和视频标题")
            if task.url and not task.url.lower().startswith(("http://", "https://")):
                raise ValueError("视频链接需要以 http:// 或 https:// 开头")
            Path(task.output_root).expanduser().mkdir(parents=True, exist_ok=True)
        except (OSError, ValueError) as exc:
            messagebox.showwarning("信息不完整", str(exc), parent=self.root)
            return

        strength_text = f"单条 {task.strength_percent}%" if task.strength_mode == "单条" else f"全局 {self.global_strength.get()}%"
        item_id = str(uuid.uuid4())
        self.tasks.append({"id": item_id, "task": task, "state": "待处理", "outputs": [], "error": ""})
        self.task_tree.insert("", "end", iid=item_id, values=(task.name, task.title, strength_text, "待处理"))
        self.number_var.set("")
        self.name_var.set("")
        self.title_var.set("")
        self.url_var.set("")
        self.promotion_text.delete("1.0", "end")
        self.status_var.set(f"已加入 {len(self.tasks)} 项")
        self.completion_actions.grid_remove()

    def remove_selected(self):
        if self.processing:
            return
        selected = set(self.task_tree.selection())
        self.tasks = [item for item in self.tasks if item["id"] not in selected]
        for item_id in selected:
            if self.task_tree.exists(item_id):
                self.task_tree.delete(item_id)

    def start_processing(self):
        if self.processing:
            return
        pending = [item for item in self.tasks if item["state"] == "待处理"]
        if not pending:
            messagebox.showinfo("处理列表", "请先加入要下载的视频。", parent=self.root)
            return
        self.completion_actions.grid_remove()
        self.processing = True
        self.cancel_event = threading.Event()
        self.start_button.configure(state="disabled")
        self.progressbar.configure(value=0, maximum=max(1, len(pending)))
        self.completed_in_run = 0
        global_strength = int(self.global_strength.get())
        try:
            self._save_settings()
        except OSError:
            pass

        def work():
            successes = 0
            for item in pending:
                if self.cancel_event.is_set():
                    break
                task = item["task"]
                self.events.put(("state", item["id"], "下载中", ""))

                def progress(message, task_id=item["id"]):
                    self.events.put(("progress", task_id, message))

                try:
                    outputs = run_task(
                        task,
                        global_strength_percent=global_strength,
                        resource_dir=self.resource_dir,
                        progress=progress,
                        cancel=self.cancel_event,
                    )
                    self.events.put(("state", item["id"], "完成", outputs))
                    successes += 1
                except Exception as exc:
                    self.events.put(("state", item["id"], "失败", str(exc)))
            self.events.put(("batch_done", successes, len(pending), self.cancel_event.is_set()))

        threading.Thread(target=work, daemon=True).start()

    def cancel_processing(self):
        if self.processing and self.cancel_event:
            self.cancel_event.set()
            self.status_var.set("正在取消当前任务…")

    def _poll_events(self):
        try:
            while True:
                event = self.events.get_nowait()
                if event[0] == "progress":
                    _, task_id, message = event
                    self.status_var.set(message)
                elif event[0] == "state":
                    _, task_id, state, detail = event
                    item = next((row for row in self.tasks if row["id"] == task_id), None)
                    if item:
                        item["state"] = state
                        if state == "完成":
                            item["outputs"] = detail
                            self.completed_in_run += 1
                            self.progressbar.configure(value=self.completed_in_run)
                        elif state == "失败":
                            item["error"] = detail
                            self.completed_in_run += 1
                            self.progressbar.configure(value=self.completed_in_run)
                        task = item["task"]
                        strength = f"单条 {task.strength_percent}%" if task.strength_mode == "单条" else f"全局 {self.global_strength.get()}%"
                        self.task_tree.item(task_id, values=(task.name, task.title, strength, state))
                        if state == "失败":
                            self.status_var.set(f"任务失败：{detail}")
                elif event[0] == "batch_done":
                    _, successes, total, canceled = event
                    self.processing = False
                    self.start_button.configure(state="normal")
                    self.progressbar.configure(value=successes)
                    failed = [item for item in self.tasks if item["state"] == "失败"]
                    if canceled:
                        self.status_var.set("任务已取消；已完成的本地文件保留。")
                    elif failed:
                        self.status_var.set(f"{successes}/{total} 项完成；失败项可检查后重试。")
                    else:
                        self.status_var.set("下载和降噪完成。请选择下一步功能。")
                        self.completion_actions.grid()
                    if self.close_after_processing:
                        self.close_after_processing = False
                        self._request_editor_close()
                        return
                elif event[0] == "export_done":
                    _, target, error = event
                    self.export_button.configure(state="normal")
                    if error:
                        if hasattr(self, "editor_status_var"):
                            self.editor_status_var.set("导出失败")
                        messagebox.showerror("导出失败", error, parent=self.root)
                    else:
                        if hasattr(self, "editor_status_var"):
                            self.editor_status_var.set("片段已导出到本机。")
                        messagebox.showinfo("导出完成", f"片段已保存到本机：\n{target}", parent=self.root)
        except queue.Empty:
            pass
        self.root.after(100, self._poll_events)

    def show_projects(self):
        self._open_editor_workspace(self.nav_projects, "edit")

    def _open_editor_workspace(self, nav_button, mode="edit"):
        self._show_page("projects", nav_button)
        self.page_body.grid_rowconfigure(0, weight=1)
        self.page_body.grid_columnconfigure(0, weight=1)
        if self.embedded_editor is None:
            self._clear_body()
            host = tk.Frame(self.page_body, bg=COLORS["bg"], bd=0, highlightthickness=0)
            host.grid(row=0, column=0, sticky="nsew")
            self.embedded_editor_frame = host
            self.embedded_editor = EmbeddedEditor(
                self.root, host, self.editor_engine_dir, data_root(),
                self.editor_engine_dir / "runtime" / "node" / "node.exe", self._editor_embed_failed,
            )
        self.embedded_editor.set_workspace_mode(mode)
        if self.embedded_editor.is_running():
            # Keep the native child window alive under the stacked pages.
            # Returning only raises its existing parent; avoid hide/show which
            # makes WebView2 flash black while it composes the surface again.
            self.embedded_editor.resize()
        else:
            self.root.after_idle(self._show_editor_when_mapped)

    def _show_editor_when_mapped(self):
        """Wait until Tk has mapped the page before showing its native child HWND."""
        if self.current_page != "projects" or not self.embedded_editor or not self.embedded_editor_frame:
            return
        if not self.embedded_editor_frame.winfo_exists():
            return
        if not self.embedded_editor_frame.winfo_ismapped():
            # grid()/tkraise() are applied synchronously, but Windows maps the
            # page HWND on the next event-loop turn. Showing the WebView2 host
            # before then leaves its child surface hidden under the ancestor.
            self.root.after(16, self._show_editor_when_mapped)
            return
        shown = self.embedded_editor.show()
        if shown and self.editor_embed_error is not None:
            try:
                self.editor_embed_error.destroy()
            except tk.TclError:
                pass
            self.editor_embed_error = None

    def _editor_embed_failed(self, message):
        if not self.embedded_editor_frame or not self.embedded_editor_frame.winfo_exists():
            return
        if self.editor_embed_error is None or not self.editor_embed_error.winfo_exists():
            self.editor_embed_error = tk.Label(
                self.embedded_editor_frame, text=message, anchor="center", justify="center",
                wraplength=720, bg=COLORS["bg"], fg=COLORS["muted"],
                font=("Microsoft YaHei UI", 10),
            )
            self.editor_embed_error.place(relx=0.5, rely=0.5, anchor="center")
        else:
            self.editor_embed_error.configure(text=message)
    def open_cutout(self):
        if not self.cutout_page_built:
            # Build and select the destination while it is still behind the
            # active page. Raising an empty cutout shell and filling it in the
            # foreground caused a visible blank-to-content flash.
            self._build_cutout_page()
        if self.current_page == "cutout":
            self._activate_nav(self.nav_cutout)
            return
        if self.cutout_pages[self.current_cutout_page]["editor"] is None and self.rotoscope_import_error is None:
            # Keep the current page visible until the cutout controls are ready.
            # This avoids showing a blank destination during a first-time load.
            self.cutout_open_pending = True
            self._prewarm_cutout_workspace()
            if self.cutout_pages[self.current_cutout_page]["editor"] is None:
                return
            self.cutout_open_pending = False
        self._select_cutout_page(self.current_cutout_page)
        self._show_page("cutout", self.nav_cutout)

    def _prewarm_cutout_workspace(self):
        if not self.root.winfo_exists():
            return
        if not self.cutout_page_built:
            self._build_cutout_page()
        if self.cutout_pages[0]["editor"] is not None:
            return
        self.cutout_prewarm_requested = True
        if self.rotoscope_module is not None:
            self._create_cutout_editor(0, allow_hidden=True)
            return
        if self.rotoscope_import_error is not None or self.rotoscope_importing:
            return
        self.rotoscope_importing = True
        self.rotoscope_import_ready = False

        def import_rotoscope():
            try:
                self.rotoscope_module = importlib.import_module(".rotoscope", package=__package__)
            except Exception as exc:
                self.rotoscope_import_error = exc
            finally:
                self.rotoscope_import_ready = True

        threading.Thread(target=import_rotoscope, name="rotoscope-module-load", daemon=True).start()
        self.root.after(30, self._poll_rotoscope_import)

    def _build_cutout_page(self):
        cutout_host = self.page_frames["cutout"]
        toolbar = tk.Frame(cutout_host, bg=COLORS["bg"], padx=8, pady=4)
        toolbar.pack(fill="x", pady=(0, 4))
        self._label(toolbar, "抠图页", size=11, bold=True).pack(side="left", padx=(4, 12))
        self.cutout_tabs = []
        for index in range(CUTOUT_PAGE_COUNT):
            button = ttk.Button(toolbar, text=str(index + 1), width=3,
                                style="Cutout.TButton", cursor="hand2",
                                command=lambda i=index: self._select_cutout_page(i))
            button.pack(side="left", padx=(0, 5))
            self.cutout_tabs.append(button)
        self.cutout_page_label = self._label(toolbar, "第 1 页 · 未导入视频", muted=True, size=9)
        self.cutout_page_label.pack(side="left", padx=(10, 0), fill="x", expand=True)
        ttk.Button(toolbar, text="导入本页视频", command=self.add_cutout_videos,
                   style="CutoutAction.TButton", cursor="hand2").pack(side="right", padx=(8, 0))

        self.cutout_editor_stack = tk.Frame(cutout_host, bg=COLORS["bg"])
        self.cutout_editor_stack.pack(fill="both", expand=True)
        self.cutout_editor_stack.grid_rowconfigure(0, weight=1)
        self.cutout_editor_stack.grid_columnconfigure(0, weight=1)
        self.cutout_pages = []
        for index in range(CUTOUT_PAGE_COUNT):
            host = tk.Frame(self.cutout_editor_stack, bg=COLORS["bg"])
            host.grid(row=0, column=0, sticky="nsew")
            placeholder = tk.Label(host, text="本页尚未导入视频", bg=COLORS["bg"],
                                   fg=COLORS["muted"], font=("Microsoft YaHei UI", 11))
            placeholder.place(relx=0.5, rely=0.5, anchor="center")
            self.cutout_pages.append({"host": host, "editor": None, "placeholder": placeholder,
                                      "path": "", "state": "未导入"})
        self.cutout_editor_pending = set()
        self.cutout_page_built = True

    def _select_cutout_page(self, index):
        if not self.cutout_page_built:
            return
        self.current_cutout_page = max(0, min(CUTOUT_PAGE_COUNT - 1, int(index)))
        page = self.cutout_pages[self.current_cutout_page]
        for page_index, item in enumerate(self.cutout_pages):
            editor = item.get("editor")
            if editor is not None:
                editor.set_background_active(
                    self.current_page == "cutout" and page_index == self.current_cutout_page
                )
        page["host"].tkraise()
        self.matting_window = page["editor"]
        self._refresh_cutout_tabs()
        self._update_cutout_page_label()
        if page["editor"] is None:
            if self.current_cutout_page not in self.cutout_editor_pending:
                self.cutout_editor_pending.add(self.current_cutout_page)
                self.root.after(60, lambda i=self.current_cutout_page: self._create_cutout_editor(i))

    def _create_cutout_editor(self, index, allow_hidden=False):
        self.cutout_editor_pending.discard(index)
        if not allow_hidden and (self.current_page != "cutout" or index != self.current_cutout_page):
            return None
        page = self.cutout_pages[index]
        if page["editor"] is not None:
            return page["editor"]
        if self.rotoscope_module is None:
            if self.rotoscope_import_error is not None:
                exc = self.rotoscope_import_error
                self.rotoscope_import_error = None
                self._show_rotoscope_import_error(index, exc)
                return None
            if not self.rotoscope_importing:
                self.rotoscope_importing = True
                self.rotoscope_import_ready = False

                def import_rotoscope():
                    try:
                        self.rotoscope_module = importlib.import_module(".rotoscope", package=__package__)
                    except Exception as exc:
                        self.rotoscope_import_error = exc
                    finally:
                        self.rotoscope_import_ready = True

                threading.Thread(target=import_rotoscope, name="rotoscope-module-load", daemon=True).start()
                self.root.after(30, self._poll_rotoscope_import)
            return None
        try:
            editor = self.rotoscope_module.RotoscopeWindow(self, host=page["host"])
        except Exception as exc:
            placeholder = page.get("placeholder")
            if placeholder and placeholder.winfo_exists():
                placeholder.configure(text=f"抠图模块加载失败：{exc}")
            if index == self.current_cutout_page:
                self.cutout_page_label.configure(text=f"第 {index + 1} 页 · 抠图模块加载失败：{exc}")
            if self.cutout_open_pending and allow_hidden:
                self.cutout_open_pending = False
                self._select_cutout_page(index)
                self._show_page("cutout", self.nav_cutout)
            return None
        page["editor"] = editor
        editor.set_background_active(self.current_page == "cutout" and index == self.current_cutout_page)
        if index == 0:
            self.cutout_prewarm_requested = False
        placeholder = page.get("placeholder")
        if placeholder and placeholder.winfo_exists():
            placeholder.destroy()
        page["placeholder"] = None
        self.matting_windows.append(editor)
        if index == self.current_cutout_page:
            self.matting_window = editor
        if page["path"]:
            editor.set_video(page["path"])
        if self.cutout_open_pending and allow_hidden:
            self.cutout_open_pending = False
            self._select_cutout_page(index)
            self._show_page("cutout", self.nav_cutout)
        return editor

    def _poll_rotoscope_import(self):
        if not self.root.winfo_exists() or not self.rotoscope_importing:
            return
        if not self.rotoscope_import_ready:
            self.root.after(30, self._poll_rotoscope_import)
            return
        self.rotoscope_importing = False
        self.rotoscope_import_ready = False
        if self.rotoscope_import_error is not None:
            index = self.current_cutout_page
            exc = self.rotoscope_import_error
            self.rotoscope_import_error = None
            self.cutout_prewarm_requested = False
            if self.current_page == "cutout" or self.cutout_open_pending:
                self.cutout_open_pending = False
                if self.current_page != "cutout":
                    self._select_cutout_page(index)
                    self._show_page("cutout", self.nav_cutout)
                self._show_rotoscope_import_error(index, exc)
            return
        if self.current_page == "cutout":
            index = self.current_cutout_page
            self.cutout_editor_pending.add(index)
            self.root.after(40, lambda i=index: self._create_cutout_editor(i))
        elif self.cutout_prewarm_requested:
            self.cutout_editor_pending.add(0)
            self.root.after(1, lambda: self._create_cutout_editor(0, allow_hidden=True))

    def _show_rotoscope_import_error(self, index, error):
        page = self.cutout_pages[index]
        placeholder = page.get("placeholder")
        if placeholder and placeholder.winfo_exists():
            placeholder.configure(text=f"抠图模块加载失败：{error}")
        if index == self.current_cutout_page and hasattr(self, "cutout_page_label"):
            self.cutout_page_label.configure(text=f"第 {index + 1} 页 · 抠图模块加载失败：{error}")

    def add_cutout_videos(self):
        path = filedialog.askopenfilename(
            parent=self.root, title=f"为抠图页 {self.current_cutout_page + 1} 导入视频",
            filetypes=[("视频", "*.mp4 *.mov *.mkv *.webm *.avi *.m4v *.wmv"), ("所有文件", "*.*")],
        )
        if not path:
            return
        page = self.cutout_pages[self.current_cutout_page]
        page["path"] = str(Path(path).resolve())
        page["state"] = "正在加载"
        self._update_cutout_page_label()
        self._refresh_cutout_tabs()
        if page["editor"] is None:
            if self.current_cutout_page not in self.cutout_editor_pending:
                self.cutout_editor_pending.add(self.current_cutout_page)
                self.root.after(60, lambda i=self.current_cutout_page: self._create_cutout_editor(i))
        else:
            page["editor"].set_video(page["path"])

    def on_cutout_video_set(self, editor, path):
        for index, page in enumerate(self.cutout_pages):
            if page["editor"] is editor:
                page["path"] = str(Path(path).resolve())
                if page["state"] not in {"处理中", "排队中"}:
                    page["state"] = "已导入"
                if index == self.current_cutout_page:
                    self._update_cutout_page_label()
                self._refresh_cutout_tabs()
                return

    def _update_cutout_page_label(self):
        if not hasattr(self, "cutout_page_label"):
            return
        index = self.current_cutout_page
        page = self.cutout_pages[index]
        video = Path(page["path"]).name if page["path"] else "未导入视频"
        self.cutout_page_label.configure(text=f"第 {index + 1} 页 · {video} · {page['state']}")

    def _refresh_cutout_tabs(self):
        for index, button in enumerate(getattr(self, "cutout_tabs", ())):
            state = self.cutout_pages[index]["state"]
            button.configure(style="CutoutSelected.TButton" if index == self.current_cutout_page
                             else "Cutout.TButton")

    def _cutout_page_indices(self, path):
        target = os.path.normcase(os.path.normpath(str(path)))
        return [index for index, page in enumerate(self.cutout_pages)
                if page["path"] and os.path.normcase(os.path.normpath(page["path"])) == target]

    def on_cutout_started(self, path):
        for index in self._cutout_page_indices(path):
            self.cutout_pages[index]["state"] = "处理中"
        self._refresh_cutout_tabs()
        self._update_cutout_page_label()

    def on_cutout_queued(self, path):
        for index in self._cutout_page_indices(path):
            self.cutout_pages[index]["state"] = "排队中"
        self._refresh_cutout_tabs()
        self._update_cutout_page_label()

    def on_cutout_progress(self, path, percent, count, total):
        for index in self._cutout_page_indices(path):
            self.cutout_pages[index]["state"] = f"处理中 {percent:.0f}%"
        self._refresh_cutout_tabs()
        self._update_cutout_page_label()

    def on_cutout_done(self, path, error, output, cancelled):
        state = "已取消" if cancelled else ("失败" if error else "完成")
        for index in self._cutout_page_indices(path):
            self.cutout_pages[index]["state"] = state
        self._refresh_cutout_tabs()
        self._update_cutout_page_label()

    def on_rotoscope_closed(self, window):
        if window in self.matting_windows:
            self.matting_windows.remove(window)
        for page in self.cutout_pages:
            if page["editor"] is window:
                page["editor"] = None
        if self.matting_window is window:
            current = self.cutout_pages[self.current_cutout_page] if self.cutout_pages else None
            self.matting_window = current["editor"] if current else None

    def _active_cutout_windows(self):
        return [window for window in self.matting_windows if getattr(window, "is_exporting", False)]

    def close(self):
        active_cutouts = self._active_cutout_windows()
        if active_cutouts:
            if not messagebox.askyesno("取消抠图", "抠图仍在进行。停止任务并退出吗？", parent=self.root):
                return
            for window in active_cutouts:
                window.cancel_all_exports()
            self.root.after(250, self._close_when_idle)
            return
        if self.downloader_app and self.downloader_app.active:
            if not messagebox.askyesno("取消下载", "下载或降噪仍在进行。停止任务并退出吗？", parent=self.root):
                return
            self.downloader_app.cancel()
            self.root.after(250, self._close_when_idle)
            return
        if self.processing:
            if messagebox.askyesno("取消处理", "处理尚未完成。停止当前任务并退出吗？", parent=self.root):
                self.close_after_processing = True
                if self.cancel_event:
                    self.cancel_event.set()
                self.status_var.set("正在停止当前任务…")
            return
        self._request_editor_close()

    def _request_editor_close(self):
        if self.embedded_editor and self.embedded_editor.is_running():
            if getattr(self, "shutdown_waiting", False):
                return
            self.shutdown_waiting = True
            self.embedded_editor.request_close(self._embedded_editor_closed)
            return
        self._finish_shutdown()

    def _embedded_editor_closed(self, closed):
        self.shutdown_waiting = False
        if closed:
            self._finish_shutdown()
        elif self.root.winfo_exists():
            messagebox.showwarning(
                "剪辑助手正在保存",
                "剪辑工作区没有确认完成退出，主窗口仍保持打开。请等待剪辑页恢复后再关闭。",
                parent=self.root,
            )

    def _finish_shutdown(self):
        for editor in tuple(self.matting_windows):
            editor.shutdown_background_work()
        self._close_downloader_view()
        self.root.destroy()

    def _close_when_idle(self):
        if self._active_cutout_windows():
            self.root.after(250, self._close_when_idle)
            return
        if self.downloader_app and self.downloader_app.active:
            self.root.after(250, self._close_when_idle)
            return
        self._request_editor_close()

    def run(self):
        self.root.mainloop()

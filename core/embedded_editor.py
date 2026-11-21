"""Host the original editor's WebView2 control inside the main Tk process.

The editor surface is a WinForms child HWND created through pythonnet.  There
is no Edge browser window and no standalone editor-host executable.  The
bundled Node runtime remains a hidden local service used by the editor itself.
"""
from __future__ import annotations

import ctypes
import json
import os
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from typing import Callable


_RUNTIME = None
_RUNTIME_LOCK = threading.Lock()
_OLE32 = None
_COM_INITIALIZED = False
_DLL_DIRECTORY = None


def _set_editor_environment(engine_dir: Path, storage_root: Path, node_path: Path) -> None:
    support_root = storage_root / "编辑器数据"
    desktop_data = storage_root / "运行配置"
    media_root = engine_dir / "Modules" / "剪辑助手" / "media"
    temp_root = support_root / "temp"
    for directory in (support_root, desktop_data, temp_root):
        directory.mkdir(parents=True, exist_ok=True)

    os.environ.update({
        "CLIPASSIST_APP_EXECUTABLE": sys.executable,
        "CLIPASSIST_NO_WINDOW": "1",
        "CLIPASSIST_INSTALL_ROOT": str(engine_dir),
        "CLIPASSIST_STORAGE_ROOT": str(storage_root),
        "CLIPASSIST_SUPPORT_ROOT": str(support_root),
        "CLIPASSIST_DESKTOP_DATA": str(desktop_data),
        "CLIPASSIST_NODE_PATH": str(node_path),
        "CLIPASSIST_MEDIA_ROOT": str(media_root),
        "CLIPASSIST_DEEPFILTER_BIN": str(media_root / "deep-filter.exe"),
    })


def _load_runtime(engine_dir: Path, storage_root: Path, node_path: Path):
    """Load the .NET Framework host on the Tk UI thread in an STA apartment."""
    global _RUNTIME, _OLE32, _COM_INITIALIZED, _DLL_DIRECTORY
    if os.name != "nt":
        raise RuntimeError("内置剪辑界面需要在 Windows 上运行。")
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError("剪辑界面必须由主窗口 UI 线程初始化。")

    with _RUNTIME_LOCK:
        if _RUNTIME is not None:
            return _RUNTIME

        _set_editor_environment(engine_dir, storage_root, node_path)
        _DLL_DIRECTORY = os.add_dll_directory(str(engine_dir))

        # WinForms/WebView2 require STA. Initialize before loading the CLR so
        # the Tk thread remains the single owner of both native UI surfaces.
        if not _COM_INITIALIZED:
            _OLE32 = ctypes.WinDLL("ole32", use_last_error=True)
            _OLE32.CoInitializeEx.argtypes = (ctypes.c_void_p, ctypes.c_uint)
            _OLE32.CoInitializeEx.restype = ctypes.c_long
            result = _OLE32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED
            if result not in (0, 1):
                raise RuntimeError(
                    "Windows UI 线程无法切换到 WebView2 所需的 STA 模式 "
                    f"(HRESULT 0x{result & 0xFFFFFFFF:08X})。"
                )
            _COM_INITIALIZED = True

        try:
            from pythonnet import load

            load("netfx")
            import clr

            clr.AddReference("System.Windows.Forms")
            clr.AddReference("System.Drawing")
            clr.AddReference(str(engine_dir / "Microsoft.Web.WebView2.Core.dll"))
            clr.AddReference(str(engine_dir / "Microsoft.Web.WebView2.WinForms.dll"))
            clr.AddReference(str(engine_dir / "剪辑助手.WebView.dll"))

            from System import IntPtr
            from System.Drawing import Rectangle
            from System.Windows.Forms import Application
            from ClipAssistant.Editor import DesktopHost

            Application.EnableVisualStyles()
            _RUNTIME = (IntPtr, Rectangle, DesktopHost)
            return _RUNTIME
        except Exception:
            # Keep the COM initialization alive if the CLR loaded; pythonnet
            # cannot be unloaded safely, and a later retry may complete it.
            raise


class EmbeddedEditor:
    """Own one in-process .NET WebView2 child control for the editor page."""

    def __init__(self, root: tk.Misc, frame: tk.Widget, engine_dir: Path,
                 storage_root: Path, node_path: Path | None = None,
                 on_error: Callable[[str], None] | None = None,
                 native_parent: tk.Widget | None = None,
                 on_main_area_requested: Callable[[str], None] | None = None,
                 on_download_project_completed: Callable[[str, bool, str, str], None] | None = None):
        self.root = root
        self.frame = frame
        # Parent the WinForms/WebView2 HWND directly to the Tk host that owns
        # its display area. Tk then clips and stacks the whole editor with the
        # Projects page, avoiding a separate sibling-HWND reorder on navigation.
        self.native_parent = native_parent or frame
        self.engine_dir = Path(engine_dir)
        self.storage_root = Path(storage_root)
        self.node_path = Path(node_path) if node_path else self.engine_dir / "runtime" / "node" / "node.exe"
        self.on_error = on_error
        self.on_main_area_requested = on_main_area_requested
        self._main_area_requested_handler = None
        self.on_download_project_completed = on_download_project_completed
        self._download_project_pending: set[str] = set()
        self._download_project_poll_id = None
        self.host = None
        self.starting = False
        self.closing = False
        self.close_in_progress = False
        self._close_callback: Callable[[bool], None] | None = None
        self._close_deadline = 0.0
        self._resize_after_id = None
        self._last_bounds = None
        self.workspace_mode = "edit"
        self.frame.bind("<Configure>", self._on_configure, add="+")

    def set_workspace_mode(self, mode: str) -> None:
        self.workspace_mode = "splice" if str(mode) == "splice" else "edit"
        if self.host is not None and not bool(self.host.IsClosed):
            try:
                self.host.SetWorkspaceMode(self.workspace_mode)
            except Exception as exc:
                self._fail(f"无法更新工作区名称：{exc}")

    def is_running(self) -> bool:
        return self.host is not None and not bool(self.host.IsClosed)

    def is_ready(self) -> bool:
        if not self.is_running():
            return False
        try:
            ready = bool(self.host.IsReady)
            if ready:
                self.starting = False
            return ready
        except Exception:
            return False

    def has_failed(self) -> bool:
        if not self.is_running():
            return False
        try:
            return str(self.host.HostState).lower() == "error"
        except Exception:
            return False

    def show(self, *, activate: bool = True) -> bool:
        if self.closing:
            return False
        try:
            if self.host is None or bool(self.host.IsClosed):
                if not self.node_path.is_file():
                    raise RuntimeError(f"剪辑助手本地运行组件缺失：{self.node_path}")
                editor_entry = self.engine_dir / "Modules" / "剪辑助手" / "剪辑界面" / "src" / "bootstrap.mjs"
                if not editor_entry.is_file():
                    raise RuntimeError(f"剪辑助手本地剪辑资源缺失：{editor_entry}")
                IntPtr, Rectangle, DesktopHost = _load_runtime(
                    self.engine_dir, self.storage_root, self.node_path,
                )
                self.host = DesktopHost()
                if self.on_main_area_requested:
                    self._main_area_requested_handler = self._dispatch_main_area_request
                    self.host.MainAreaRequested += self._main_area_requested_handler
                self.host.SetWorkspaceMode(self.workspace_mode)
                x, y, width, height = self._bounds()
                self.host.AttachAsChildWindow(
                    IntPtr(int(self.native_parent.winfo_id())),
                    Rectangle(x, y, width, height),
                )
                self.starting = True

            if activate:
                self.host.ShowEmbedded()
            else:
                self.host.StartEmbedded()
            if not self.resize(force=True):
                raise RuntimeError("剪辑工作区无法填满当前主窗口。")
            return True
        except Exception as exc:
            self.starting = False
            if self.host is not None:
                try:
                    self.host.StopWithoutSave()
                except Exception:
                    pass
                self.host = None
            self._fail(f"剪辑工作区启动失败：{exc}")
            return False

    def hide(self) -> None:
        if self.host is not None and not bool(self.host.IsClosed):
            try:
                self.host.HideEmbedded()
            except Exception as exc:
                self._fail(f"无法隐藏剪辑工作区：{exc}")

    def _bounds(self) -> tuple[int, int, int, int]:
        try:
            if not self.frame.winfo_exists() or not self.native_parent.winfo_exists():
                return 0, 0, 1, 1
            x = self.frame.winfo_rootx() - self.native_parent.winfo_rootx()
            y = self.frame.winfo_rooty() - self.native_parent.winfo_rooty()
            return x, y, max(1, self.frame.winfo_width()), max(1, self.frame.winfo_height())
        except tk.TclError:
            return 0, 0, 1, 1

    def _on_configure(self, _event=None) -> None:
        if self.host is not None and not bool(self.host.IsClosed):
            self._schedule_resize()

    def _schedule_resize(self) -> None:
        if self._resize_after_id is not None:
            return
        try:
            if self.frame.winfo_exists():
                self._resize_after_id = self.root.after_idle(self._resize_when_idle)
        except tk.TclError:
            pass

    def _resize_when_idle(self) -> None:
        self._resize_after_id = None
        self.resize()

    def resize(self, force: bool = False) -> bool:
        if self.host is None or bool(self.host.IsClosed):
            return False
        x, y, width, height = self._bounds()
        bounds = (x, y, width, height)
        if bounds == self._last_bounds and not force:
            return True
        try:
            self.host.ResizeEmbedded(x, y, width, height)
            self._last_bounds = bounds
            return True
        except Exception as exc:
            self._last_bounds = None
            self._fail(f"剪辑工作区尺寸调整失败：{exc}")
            return False

    def request_close(self, callback: Callable[[bool], None]) -> None:
        if self.close_in_progress:
            return
        if not self.is_running():
            callback(True)
            return
        self.close_in_progress = True
        self.closing = True
        self._close_callback = callback
        self._close_deadline = time.monotonic() + 35.0
        try:
            # DesktopHost's FormClosing handshake asks the editor to confirm
            # pending project saves; the host stays embedded during the wait.
            self.host.Close()
        except Exception as exc:
            self.closing = False
            self.close_in_progress = False
            self._complete_close(False, f"剪辑工作区关闭失败：{exc}")
            return
        self.root.after(100, self._poll_close)

    def _poll_close(self) -> None:
        if not self.close_in_progress:
            return
        if self.host is None or bool(self.host.IsClosed):
            self._complete_close(True)
            return
        if time.monotonic() >= self._close_deadline:
            self.closing = False
            self._complete_close(False, "剪辑页面尚未确认保存，主窗口保持打开。")
            return
        try:
            self.root.after(100, self._poll_close)
        except tk.TclError:
            self._complete_close(False)

    def _complete_close(self, closed: bool, error: str | None = None) -> None:
        callback, self._close_callback = self._close_callback, None
        self.close_in_progress = False
        if closed:
            self.host = None
            self.starting = False
            self.closing = False
        if error:
            self._fail(error)
        if callback:
            callback(closed)

    def stop(self) -> None:
        self.closing = True
        self.close_in_progress = False
        self._close_callback = None
        if self._download_project_poll_id is not None:
            try:
                self.root.after_cancel(self._download_project_poll_id)
            except tk.TclError:
                pass
            self._download_project_poll_id = None
        self._download_project_pending.clear()
        if self.host is not None and not bool(self.host.IsClosed):
            try:
                self.host.StopWithoutSave()
            except Exception:
                pass
        self.host = None
        self.starting = False

    def _fail(self, message: str) -> None:
        if self.on_error:
            self.on_error(message)

    def _dispatch_main_area_request(self, area: str) -> None:
        callback = self.on_main_area_requested
        if callback is None:
            return
        try:
            self.root.after(0, lambda: callback(str(area)))
        except tk.TclError:
            pass

    def create_download_project(self, request_id: str, name: str, script: str) -> None:
        if not self.is_ready():
            raise RuntimeError("剪辑工程服务尚未就绪。")
        request_id = str(request_id)
        self._download_project_pending.add(request_id)
        try:
            self.host.CreateDownloadProject(request_id, str(name), str(script))
        except Exception:
            self._download_project_pending.discard(request_id)
            raise
        self._schedule_download_project_poll()

    def _schedule_download_project_poll(self) -> None:
        if not self._download_project_pending or self._download_project_poll_id is not None:
            return
        try:
            self._download_project_poll_id = self.root.after(100, self._poll_download_project_results)
        except tk.TclError:
            self._download_project_poll_id = None

    def _poll_download_project_results(self) -> None:
        self._download_project_poll_id = None
        if not self._download_project_pending:
            return
        if not self.is_running():
            results = [(request_id, False, "剪辑工程服务已退出。", "")
                       for request_id in self._download_project_pending]
            self._download_project_pending.clear()
        else:
            try:
                results = json.loads(str(self.host.TakeDownloadProjectResults() or "[]"))
                if not isinstance(results, list):
                    raise ValueError("剪辑工程服务返回了无效结果。")
            except Exception as exc:
                self._fail(f"读取后台建工程结果失败：{exc}")
                self._schedule_download_project_poll()
                return
        callback = self.on_download_project_completed
        for result in results:
            if isinstance(result, dict):
                request_id = str(result.get("requestId", ""))
                succeeded = bool(result.get("succeeded"))
                detail = str(result.get("detail", "") or "")
                project_id = str(result.get("projectId", "") or "")
            else:
                request_id, succeeded, detail, project_id = result
                request_id = str(request_id)
            if request_id not in self._download_project_pending:
                continue
            self._download_project_pending.discard(request_id)
            if callback:
                try:
                    callback(request_id, succeeded, detail, project_id)
                except Exception as exc:
                    self._fail(f"处理后台建工程结果失败：{exc}")
        self._schedule_download_project_poll()


"""macOS WebKit host for the local editor service.

The main downloader remains in Tk. The editor runs in a native WKWebView
window owned by the same Python process, with its local Node service managed
here and a private per-process session cookie for WebKit subresource requests.
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import threading
import time
import tkinter as tk
from pathlib import Path
from typing import Callable
from urllib.request import Request, urlopen

_MAC_OBJC_CLASS_CACHE = None


class MacEmbeddedEditor:
    def __init__(self, root: tk.Misc, frame: tk.Widget, engine_dir: Path,
                 storage_root: Path, node_path: Path | None = None,
                 on_error: Callable[[str], None] | None = None,
                 native_parent: tk.Widget | None = None,
                 on_main_area_requested: Callable[[str], None] | None = None,
                 on_download_project_completed: Callable[[str, bool, str, str], None] | None = None):
        self.root = root
        self.frame = frame
        self.native_parent = native_parent or frame
        self.engine_dir = Path(engine_dir)
        self.storage_root = Path(storage_root)
        self.node_path = Path(node_path) if node_path else self.engine_dir / "runtime" / "node" / "node"
        self.on_error = on_error
        self.on_main_area_requested = on_main_area_requested
        self.on_download_project_completed = on_download_project_completed
        self.workspace_mode = "edit"
        self.starting = False
        self.closing = False
        self.close_in_progress = False
        self._ready = False
        self._failed = False
        self._url = ""
        self._token = ""
        self._process: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None
        self._log_lock = threading.Lock()
        self._log_path = self.storage_root / "编辑器数据" / "logs" / f"desktop-{time.strftime('%Y%m%d-%H%M%S')}.log"
        self._window = None
        self._webview = None
        self._ns_application = None
        self._appkit_pump_scheduled = False
        self._handler = None
        self._navigation_delegate = None
        self._window_delegate = None
        self._close_callback: Callable[[bool], None] | None = None
        self._close_request_id = ""
        self._allow_window_close = False
        self._drop_paths: list[str] = []
        self._download_project_pending: set[str] = set()
        self.frame.bind("<Configure>", self._on_configure, add="+")

    def set_workspace_mode(self, mode: str) -> None:
        self.workspace_mode = "splice" if str(mode) == "splice" else "edit"
        self._evaluate(
            "(() => { const mode = %s; const label = document.getElementById('workspaceModeLabel'); "
            "if (label) label.textContent = mode === 'splice' ? '视频拼接' : 'DAVINCI EDITOR'; "
            "if (typeof window.setClipAssistantWorkspaceMode === 'function') "
            "window.setClipAssistantWorkspaceMode(mode); else window.__clipAssistantWorkspaceMode = mode; })();"
            % json.dumps(self.workspace_mode)
        )

    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def is_ready(self) -> bool:
        return self._ready and self.is_running()

    def has_failed(self) -> bool:
        return self._failed

    def resize(self, force: bool = False) -> bool:
        return self.is_ready()

    def show(self, *, activate: bool = True) -> bool:
        if self.closing:
            return False
        try:
            if not self.is_running():
                self._start_service()
                return True
            if not self._ready:
                if self._window is not None:
                    self._show_window(activate)
                return True
            self._show_window(activate)
            return True
        except Exception as exc:
            self.starting = False
            self._failed = True
            self._fail(f"剪辑工作区启动失败：{exc}")
            self.stop()
            return False

    def hide(self) -> None:
        if self._window is not None:
            try:
                self._window.orderOut_(None)
            except Exception as exc:
                self._fail(f"无法隐藏剪辑工作区：{exc}")

    def request_close(self, callback: Callable[[bool], None]) -> None:
        if self.close_in_progress:
            return
        if not self.is_running():
            self._destroy_window()
            callback(True)
            return
        if not self._ready:
            self._stop_backend()
            self._destroy_window()
            callback(True)
            return
        self.close_in_progress = True
        self.closing = True
        self._close_callback = callback
        self._close_request_id = secrets.token_hex(16)
        self._evaluate(
            "window.__clipAssistantReceive && window.__clipAssistantReceive(%s);"
            % json.dumps({"type": "prepareClose", "id": self._close_request_id})
        )
        self.root.after(35000, self._close_timeout)

    def create_download_project(self, request_id: str, name: str, script: str) -> None:
        if not self.is_ready():
            raise RuntimeError("剪辑工程服务尚未就绪。")
        request_id = str(request_id)
        self._download_project_pending.add(request_id)
        url = self._url.rstrip("/") + "/rpc/createDownloadProject"
        body = json.dumps([{"requestId": request_id, "name": str(name), "script": str(script)}],
                          ensure_ascii=False).encode("utf-8")

        def post() -> None:
            succeeded, detail, project_id = False, "剪辑工程创建失败。", ""
            try:
                request = Request(url, data=body, headers={
                    "Content-Type": "application/json",
                    "X-Editor-Session": self._token,
                }, method="POST")
                with urlopen(request, timeout=60) as response:
                    envelope = json.loads(response.read().decode("utf-8"))
                if not envelope.get("ok"):
                    detail = envelope.get("error", {}).get("message", detail)
                else:
                    value = envelope.get("value") or {}
                    project_id = str(value.get("id") or "")
                    detail = str(value.get("name") or name)
                    succeeded = bool(project_id)
                    if not succeeded:
                        detail = "剪辑工程服务没有返回工程编号。"
            except Exception as exc:
                detail = str(exc)
            try:
                self.root.after(0, lambda: self._complete_download_project(
                    request_id, succeeded, detail, project_id))
            except tk.TclError:
                pass

        threading.Thread(target=post, name="clipassistant-create-project", daemon=True).start()

    def stop(self) -> None:
        self.closing = True
        self.close_in_progress = False
        self._close_callback = None
        self._download_project_pending.clear()
        self._ready = False
        self._destroy_window()
        process, self._process = self._process, None
        if process is not None:
            try:
                if process.poll() is None and process.stdin:
                    process.stdin.write("shutdown\n")
                    process.stdin.flush()
                    process.wait(timeout=3)
            except Exception:
                try:
                    process.terminate()
                    process.wait(timeout=2)
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
        self.starting = False
        self.closing = False

    def _start_service(self) -> None:
        if not self.node_path.is_file():
            raise RuntimeError(f"剪辑助手本地运行组件缺失：{self.node_path}")
        editor = self.engine_dir / "Modules" / "剪辑助手" / "剪辑界面"
        entry = editor / "src" / "bootstrap.mjs"
        if not entry.is_file():
            raise RuntimeError(f"剪辑助手本地剪辑资源缺失：{entry}")
        support_root = self.storage_root / "编辑器数据"
        data_root = self.storage_root / "运行配置"
        media_root = self.engine_dir / "Modules" / "剪辑助手" / "media"
        temp_root = support_root / "temp"
        for directory in (support_root, data_root, temp_root, self._log_path.parent):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._token = secrets.token_hex(32)
        env = os.environ.copy()
        env.update({
            "CLIPASSIST_APP_EXECUTABLE": os.path.abspath(os.sys.executable),
            "CLIPASSIST_NO_WINDOW": "1",
            "CLIPASSIST_DESKTOP_PLATFORM": "macos",
            "CLIPASSIST_INSTALL_ROOT": str(self.engine_dir),
            "CLIPASSIST_STORAGE_ROOT": str(self.storage_root),
            "CLIPASSIST_SUPPORT_ROOT": str(support_root),
            "CLIPASSIST_DESKTOP_DATA": str(data_root),
            "CLIPASSIST_NODE_PATH": str(self.node_path),
            "CLIPASSIST_MEDIA_ROOT": str(media_root),
            "CLIPASSIST_DEEPFILTER_BIN": str(media_root / "deep-filter"),
            "CLIPASSIST_KEYCHAIN_HELPER": str(self.engine_dir / "runtime" / "keychain-helper"),
            "CLIPASSIST_SESSION_TOKEN": self._token,
            "TMPDIR": str(temp_root),
        })
        env["PATH"] = os.pathsep.join((str(media_root), str(self.node_path.parent), env.get("PATH", "")))
        self.starting = True
        self._failed = False
        self._process = subprocess.Popen(
            [str(self.node_path), str(entry)], cwd=str(editor), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        self._reader = threading.Thread(target=self._read_backend, name="clipassistant-editor-log", daemon=True)
        self._reader.start()
        self.root.after(30 * 60 * 1000, self._startup_timeout)

    def _read_backend(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        for raw in process.stdout:
            line = raw.rstrip("\r\n")
            self._log(line)
            if line.startswith("CLIPASSIST_EDITOR_URL="):
                url = line.split("=", 1)[1]
                try:
                    self.root.after(0, lambda value=url: self._service_ready(value))
                except tk.TclError:
                    return
        if process.poll() is None:
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                return
        try:
            self.root.after(0, self._backend_exited)
        except tk.TclError:
            pass

    def _service_ready(self, url: str) -> None:
        if not self.is_running() or self.closing:
            return
        try:
            from AppKit import (
                NSApplication, NSBackingStoreBuffered, NSDragOperationCopy,
                NSMakeRect, NSPasteboardTypeFileURL,
                NSPasteboardURLReadingFileURLsOnlyKey, NSWindow,
                NSWindowStyleMaskClosable, NSWindowStyleMaskMiniaturizable,
                NSWindowStyleMaskResizable, NSWindowStyleMaskTitled,
            )
            from Foundation import NSMutableURLRequest, NSURL, NSURLRequestReloadIgnoringLocalCacheData
            from WebKit import WKWebView, WKWebViewConfiguration

            parsed = __import__("urllib.parse", fromlist=["urlsplit"]).urlsplit(url)
            if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not (1 <= parsed.port <= 65535):
                raise RuntimeError("剪辑助手本地服务地址无效。")
            self._url = f"http://127.0.0.1:{parsed.port}"
            self._create_window(NSApplication, NSWindow, NSBackingStoreBuffered, NSMakeRect,
                                NSWindowStyleMaskClosable, NSWindowStyleMaskMiniaturizable,
                                NSWindowStyleMaskResizable, NSWindowStyleMaskTitled,
                                NSDragOperationCopy, NSPasteboardTypeFileURL,
                                NSPasteboardURLReadingFileURLsOnlyKey,
                                WKWebView, WKWebViewConfiguration)
            request = NSMutableURLRequest.requestWithURL_cachePolicy_timeoutInterval_(
                NSURL.URLWithString_(self._url + "/"),
                NSURLRequestReloadIgnoringLocalCacheData, 60.0,
            )
            request.setValue_forHTTPHeaderField_(self._token, "X-Editor-Session")
            self._webview.loadRequest_(request)
            self._schedule_appkit_pump()
            self._show_window(True)
        except Exception as exc:
            self._failed = True
            self.starting = False
            self._fail(f"macOS 剪辑窗口初始化失败：{exc}")
            self.stop()

    def _create_window(self, NSApplication, NSWindow, NSBackingStoreBuffered, NSMakeRect,
                       closable, miniaturizable, resizable, titled, drag_copy,
                       file_url_type, file_urls_only_key, WKWebView, WKWebViewConfiguration) -> None:
        global _MAC_OBJC_CLASS_CACHE
        from Foundation import NSObject
        from objc import python_method

        if _MAC_OBJC_CLASS_CACHE is None:
            class ScriptMessageHandler(NSObject):
                @python_method
                def setEditor_(self, value):
                    self.editor = value

                def userContentController_didReceiveScriptMessage_(self, controller, message):
                    value = getattr(self, "editor", None)
                    if value is None:
                        return
                    origin = message.frameInfo().securityOrigin()
                    if (origin.protocol() != "http" or origin.host() != "127.0.0.1" or
                            int(origin.port()) != value._port()):
                        value._log("BLOCKED_WEB_MESSAGE origin mismatch")
                        return
                    body = message.body()
                    if isinstance(body, dict):
                        value._handle_message(body)

            class NavigationDelegate(NSObject):
                @python_method
                def setEditor_(self, value):
                    self.editor = value

                def webView_decidePolicyForNavigationAction_decisionHandler_(self, webview, action, handler):
                    from WebKit import WKNavigationActionPolicyAllow, WKNavigationActionPolicyCancel
                    url = action.request().URL()
                    editor = self.editor
                    try:
                        local_port = int(url.port()) if url.port() is not None else 80
                    except (TypeError, ValueError):
                        local_port = -1
                    if (url.scheme() == "http" and url.host() == "127.0.0.1" and
                            local_port == editor._port()):
                        handler(WKNavigationActionPolicyAllow)
                    else:
                        try:
                            if action.navigationType() == 0 and url.scheme() in ("http", "https"):
                                from AppKit import NSWorkspace
                                NSWorkspace.sharedWorkspace().openURL_(url)
                        finally:
                            handler(WKNavigationActionPolicyCancel)

                def webView_didFailNavigation_withError_(self, webview, navigation, error):
                    editor = self.editor
                    editor._log("WEBVIEW_NAVIGATION_FAILED " + str(error.localizedDescription()))
                    editor._ready = False
                    editor._failed = True
                    editor.starting = False
                    editor._fail("剪辑界面加载失败，请返回剪辑首页重试。")

                def webView_didFinishNavigation_(self, webview, navigation):
                    editor = self.editor
                    editor._ready = True
                    editor._failed = False
                    editor.starting = False
                    editor.set_workspace_mode(editor.workspace_mode)

            class FileDropWebView(WKWebView):
                @python_method
                def setEditor_(self, value):
                    self.editor = value

                def draggingEntered_(self, sender):
                    pasteboard = sender.draggingPasteboard()
                    if file_url_type in list(pasteboard.types() or []):
                        return drag_copy
                    return 0

                def performDragOperation_(self, sender):
                    editor = self.editor
                    try:
                        pasteboard = sender.draggingPasteboard()
                        urls = pasteboard.readObjectsForClasses_options_(
                            [__import__("Foundation").NSURL],
                            {file_urls_only_key: True},
                        ) or []
                        paths = [str(url.path()) for url in urls if url.isFileURL()]
                        if not paths:
                            return False
                        editor._deliver_native_drop(paths)
                        return True
                    except Exception as exc:
                        editor._log("NATIVE_DROP_FAILED " + str(exc))
                        return False

            class WindowDelegate(NSObject):
                @python_method
                def setEditor_(self, value):
                    self.editor = value

                def windowShouldClose_(self, window):
                    editor = self.editor
                    if editor._allow_window_close:
                        return True
                    if editor.is_running() and not editor.close_in_progress:
                        editor.request_close(lambda closed: editor._complete_window_close(window, closed))
                        return False
                    return not editor.is_running()

            _MAC_OBJC_CLASS_CACHE = (ScriptMessageHandler, NavigationDelegate, FileDropWebView, WindowDelegate)

        ScriptMessageHandler, NavigationDelegate, FileDropWebView, WindowDelegate = _MAC_OBJC_CLASS_CACHE

        self._port_value = __import__("urllib.parse", fromlist=["urlsplit"]).urlsplit(self._url).port
        self._handler = ScriptMessageHandler.alloc().init()
        self._handler.setEditor_(self)
        self._navigation_delegate = NavigationDelegate.alloc().init()
        self._navigation_delegate.setEditor_(self)
        self._window_delegate = WindowDelegate.alloc().init()
        self._window_delegate.setEditor_(self)
        config = WKWebViewConfiguration.alloc().init()
        config.userContentController().addScriptMessageHandler_name_(self._handler, "clipassistant")
        frame = NSMakeRect(0, 0, 1260, 820)
        self._webview = FileDropWebView.alloc().initWithFrame_configuration_(frame, config)
        self._webview.setEditor_(self)
        self._webview.registerForDraggedTypes_([file_url_type])
        self._webview.setNavigationDelegate_(self._navigation_delegate)
        style = titled | closable | miniaturizable | resizable
        self._window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            frame, style, NSBackingStoreBuffered, False,
        )
        self._window.setTitle_("剪辑助手")
        self._window.setMinSize_((900, 580))
        self._window.setContentView_(self._webview)
        self._window.setDelegate_(self._window_delegate)
        self._ns_application = NSApplication.sharedApplication()

    def _schedule_appkit_pump(self) -> None:
        if self._appkit_pump_scheduled or self._ns_application is None:
            return
        self._appkit_pump_scheduled = True
        try:
            self.root.after(8, self._pump_appkit_events)
        except tk.TclError:
            self._appkit_pump_scheduled = False

    def _pump_appkit_events(self) -> None:
        self._appkit_pump_scheduled = False
        if self._window is None or self._ns_application is None:
            return
        try:
            from AppKit import NSEventMaskAny
            from Foundation import NSDate, NSDefaultRunLoopMode

            # Tk owns the process's main loop. Give AppKit/WebKit a short
            # slice of the same main thread on each Tk timer tick so native
            # window events and WebKit's run-loop callbacks continue to run.
            for _ in range(32):
                event = self._ns_application.nextEventMatchingMask_untilDate_inMode_dequeue_(
                    NSEventMaskAny,
                    NSDate.dateWithTimeIntervalSinceNow_(0.002),
                    NSDefaultRunLoopMode,
                    True,
                )
                if event is None:
                    break
                self._ns_application.sendEvent_(event)
            self._ns_application.updateWindows()
        except Exception as exc:
            self._log("APPKIT_EVENT_PUMP_FAILED " + str(exc))
        finally:
            self._schedule_appkit_pump()

    def _handle_message(self, message: dict) -> None:
        kind = str(message.get("type") or "")
        if kind == "mainAreaRequest":
            area = str(message.get("area") or "")
            if area in ("download", "projects"):
                self.hide()
                self._dispatch_main_area_request(area)
            return
        if kind == "closeReady":
            if str(message.get("id") or "") != self._close_request_id:
                return
            ok = bool(message.get("ok"))
            callback, self._close_callback = self._close_callback, None
            self.close_in_progress = False
            if not ok:
                self.closing = False
                self._fail(str(message.get("error") or "剪辑页面尚未确认保存，主窗口保持打开。"))
            else:
                self._ready = False
                self._stop_backend()
                self._destroy_window()
                self.closing = False
            if callback:
                callback(ok)
            return
        if kind == "rendererError":
            self._log("RENDERER_ERROR " + str(message.get("kind") or "error") + " " +
                      str(message.get("message") or ""))
            if message.get("kind") != "resource-error":
                self._fail("剪辑界面脚本错误，已记录到运行日志；请返回剪辑首页重试。")
            return
        if kind == "droppedFiles":
            self._drop_paths = [value for value in self._drop_paths if Path(value).is_file()][:500]
            self._reply(message, result=self._drop_paths)
            self._drop_paths = []
            return
        if kind.startswith("mlt"):
            self._reply(message, error="macOS 暂无 MLT 原生后端，正在使用通用导出流程。")

    def _reply(self, message: dict, result=None, error: str | None = None) -> None:
        response = {"id": str(message.get("id") or "")}
        if error:
            response["error"] = error
        else:
            response["result"] = {"ok": True, "value": result}
        self._evaluate("window.__clipAssistantReceive && window.__clipAssistantReceive(%s);" %
                       json.dumps(response, ensure_ascii=False))

    def _deliver_native_drop(self, paths: list[str]) -> None:
        self._drop_paths = [value for value in paths if Path(value).is_file()][:500]
        if not self._drop_paths:
            return
        files = [{"name": Path(value).name, "type": "application/octet-stream"} for value in self._drop_paths]
        script = """(() => {
          const transfer = new DataTransfer();
          for (const item of %s) transfer.items.add(new File([], item.name, {type:item.type}));
          window.__clipAssistantExternalDropFiles = [...transfer.files];
          const event = new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:transfer,
            clientX:Math.round(innerWidth/2),clientY:Math.round(innerHeight/2)});
          document.elementFromPoint(event.clientX,event.clientY)?.dispatchEvent(event);
        })();""" % json.dumps(files, ensure_ascii=False)
        self._evaluate(script)

    def _complete_download_project(self, request_id: str, succeeded: bool, detail: str, project_id: str) -> None:
        if request_id not in self._download_project_pending:
            return
        self._download_project_pending.discard(request_id)
        if self.on_download_project_completed:
            self.on_download_project_completed(request_id, succeeded, detail, project_id)

    def _show_window(self, activate: bool) -> None:
        if self._window is None:
            return
        if activate:
            self._window.makeKeyAndOrderFront_(None)
            from AppKit import NSApplication
            NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
        else:
            self._window.orderFront_(None)

    def _evaluate(self, script: str) -> None:
        if self._webview is None:
            return
        try:
            self._webview.evaluateJavaScript_completionHandler_(script, None)
        except Exception as exc:
            self._log("WEBVIEW_SCRIPT_ERROR " + str(exc))

    def _complete_window_close(self, window, closed: bool) -> None:
        if closed:
            self._allow_window_close = True
            window.close()
            self._allow_window_close = False

    def _close_timeout(self) -> None:
        if not self.close_in_progress:
            return
        self.close_in_progress = False
        self.closing = False
        callback, self._close_callback = self._close_callback, None
        self._fail("剪辑页面尚未确认保存，主窗口保持打开。")
        if callback:
            callback(False)

    def _startup_timeout(self) -> None:
        if self.starting and self.is_running() and not self._ready:
            self._failed = True
            self.starting = False
            self._fail("剪辑工作区启动超时，请查看运行日志后重试。")

    def _backend_exited(self) -> None:
        if self.closing:
            return
        if self.is_running():
            return
        self._ready = False
        self._failed = True
        self._fail("剪辑工作区服务已退出；下载任务仍会继续。")

    def _on_configure(self, _event=None) -> None:
        # The macOS WebKit surface is a native resizable window rather than a
        # child HWND. Tk remains the owner of downloader and project navigation.
        return

    def _dispatch_main_area_request(self, area: str) -> None:
        if self.on_main_area_requested:
            try:
                self.root.after(0, lambda: self.on_main_area_requested(str(area)))
            except tk.TclError:
                pass

    def _port(self) -> int:
        return int(getattr(self, "_port_value", 0))

    def _destroy_window(self) -> None:
        if self._window is not None:
            try:
                self._window.setDelegate_(None)
                self._window.orderOut_(None)
                self._window.close()
            except Exception:
                pass
        self._window = self._webview = None
        self._ns_application = None
        self._handler = self._navigation_delegate = self._window_delegate = None

    def _stop_backend(self) -> None:
        process, self._process = self._process, None
        if process is None:
            return
        try:
            if process.poll() is None and process.stdin:
                process.stdin.write("shutdown\n")
                process.stdin.flush()
                process.wait(timeout=3)
        except Exception:
            try:
                process.terminate()
                process.wait(timeout=2)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

    def _log(self, message: str) -> None:
        safe = str(message).replace(self._token, "[redacted]") if self._token else str(message)
        try:
            with self._log_lock:
                with self._log_path.open("a", encoding="utf-8") as output:
                    output.write(time.strftime("%Y-%m-%dT%H:%M:%S") + " " + safe + "\n")
                self._log_path.chmod(0o600)
        except OSError:
            pass

    def _fail(self, message: str) -> None:
        if self.on_error:
            self.on_error(message)

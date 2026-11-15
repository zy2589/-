using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.ComponentModel;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Threading;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ClipAssistant.Editor
{
public class DesktopHost : Form
{
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr hwnd, IntPtr parent);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("kernel32.dll", EntryPoint="SetLastError")] static extern void ClearLastError(uint error);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    const int GWL_EXSTYLE = -20;
    const int GWL_STYLE = -16;
    const uint WS_CHILD = 0x40000000U;
    const uint WS_POPUP = 0x80000000U;
    const uint WS_CLIPSIBLINGS = 0x04000000U;
    const uint WS_CLIPCHILDREN = 0x02000000U;
    const long WS_EX_APPWINDOW = 0x00040000L;
    const long WS_EX_TOOLWINDOW = 0x00000080L;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_FRAMECHANGED = 0x0020;
    readonly WebView2 view = new WebView2();
    readonly Label status = new Label { Text = "剪辑工作区正在启动…", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White };
    readonly TaskCompletionSource<string> ready = new TaskCompletionSource<string>();
    Process backend;
    IntPtr job;
    bool closing;
    bool checkingClose;
    bool surfaceRefreshPending;
    string editorOrigin;
    string sessionToken;
    TaskCompletionSource<Dictionary<string, object>> closeReply;
    string closeRequestId;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly string root = Environment.GetEnvironmentVariable("CLIPASSIST_INSTALL_ROOT") ?? AppDomain.CurrentDomain.BaseDirectory;
    static readonly string storageRoot = Environment.GetEnvironmentVariable("CLIPASSIST_STORAGE_ROOT") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "ChatGPT", "剪辑助手", "用户数据");
    readonly string data = Environment.GetEnvironmentVariable("CLIPASSIST_DESKTOP_DATA") ?? Path.Combine(storageRoot, "运行配置");
    readonly object logLock = new object();
    string log;
    string hostState = "created";
    string lastError = "";
    string workspaceMode = "edit";
    public bool IsReady { get { return hostState == "ready"; } }
    public bool IsClosed { get { return IsDisposed; } }
    public string HostState { get { return hostState; } }
    public string LastError { get { return lastError; } }
    public DesktopHost()
    {
        Text = "剪辑助手";
        Size = new Size(1600, 980);
        MinimumSize = new Size(1000, 700);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(28, 28, 28);
        ShowIcon = false;
        view.TabStop = true;
        view.Dock = DockStyle.Fill;
        Controls.Add(view);
        Controls.Add(status);
        Shown += async (s, e) => { await StartEditor(); };
        FormClosing += async (s, e) => {
            if (closing) return;
            e.Cancel = true;
            if (checkingClose) return;
            checkingClose = true;
            try {
                if (view.CoreWebView2 != null && !status.Visible) {
                    closeReply = new TaskCompletionSource<Dictionary<string, object>>();
                    closeRequestId = Guid.NewGuid().ToString("N");
                    view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new {type="prepareClose", id=closeRequestId}));
                    if (await Task.WhenAny(closeReply.Task, Task.Delay(30000)) != closeReply.Task) throw new Exception("保存确认超时，窗口已保留，请重试。");
                    var result = await closeReply.Task;
                    if (!result.ContainsKey("ok") || !Equals(result["ok"], true)) throw new Exception(result.ContainsKey("error") ? Convert.ToString(result["error"]) : "未能确认保存。");
                }
                Log("CLOSE_SAVE_CONFIRMED");
                closing = true;
                Hide();
                if (backend != null && !backend.HasExited) {
                    backend.StandardInput.WriteLine("shutdown");
                    await Task.Run(() => backend.WaitForExit(5000));
                }
                Close();
            } catch(Exception ex) {
                closing = false;
                if (view.CoreWebView2 != null) view.CoreWebView2.PostWebMessageAsJson("{\"type\":\"resumeEditing\"}");
                MessageBox.Show(this, ex.Message, "暂不能退出");
            } finally { checkingClose = false; }
        };
        FormClosed += (s, e) => {
            hostState = "closed";
            view.Dispose();
            if (job != IntPtr.Zero) CloseHandle(job);
            try { if (backend != null && !backend.HasExited) backend.Kill(); } catch {}
        };
    }
    public void ShowEmbedded()
    {
        if (IsDisposed) throw new ObjectDisposedException("DesktopHost");
        Show();
        BringToFront();
        ResizeEmbedded(0, 0, Math.Max(1, Width), Math.Max(1, Height));
    }
    public void SetWorkspaceMode(string mode)
    {
        workspaceMode = mode == "splice" ? "splice" : "edit";
        ApplyWorkspaceMode();
    }
    void ApplyWorkspaceMode()
    {
        if (view.CoreWebView2 == null) return;
        string mode = workspaceMode == "splice" ? "splice" : "edit";
        string label = mode == "splice" ? "视频拼接" : "DAVINCI EDITOR";
        string script = "(() => { const mode = '" + mode + "'; const label = document.getElementById('workspaceModeLabel'); if (label) label.textContent = '" + label + "'; if (typeof window.setClipAssistantWorkspaceMode === 'function') window.setClipAssistantWorkspaceMode(mode); else window.__clipAssistantWorkspaceMode = mode; })();";
        try { view.CoreWebView2.ExecuteScriptAsync(script); } catch { }
    }
    public void HideEmbedded()
    {
        if (!IsDisposed && Visible) Hide();
    }
    public void SetEmbeddedPageActive(bool active)
    {
        if (IsDisposed || !IsHandleCreated) return;
        // HWND_TOP/HWND_BOTTOM affect only sibling windows under page_stage;
        // they do not set the application window's always-on-top flag.
        IntPtr insertAfter = active ? IntPtr.Zero : new IntPtr(1);
        if (!SetWindowPos(Handle, insertAfter, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "无法调整剪辑工作区页面层级。");
        Log("EMBEDDED_PAGE_ACTIVE active=" + (active ? "1" : "0"));
    }
    public void ResizeEmbedded(int x, int y, int width, int height)
    {
        if (IsDisposed || !IsHandleCreated) return;
        if (!SetWindowPos(Handle, IntPtr.Zero, x, y, Math.Max(1, width), Math.Max(1, height),
            SWP_NOACTIVATE | 0x0004 | (Visible ? 0x0040U : 0U)))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "无法调整剪辑工作区尺寸。");
    }
    public void StopWithoutSave()
    {
        closing = true;
        try {
            if (backend != null && !backend.HasExited) {
                backend.StandardInput.WriteLine("shutdown");
                if (!backend.WaitForExit(3000)) backend.Kill();
            }
        } catch { try { if (backend != null && !backend.HasExited) backend.Kill(); } catch {} }
        try { if (!IsDisposed) Close(); } catch {}
    }
    protected override void OnVisibleChanged(EventArgs e)
    {
        base.OnVisibleChanged(e);
        if (Visible) QueueEditorSurfaceRefresh();
    }
    void QueueEditorSurfaceRefresh()
    {
        if (!IsHandleCreated || IsDisposed || surfaceRefreshPending) return;
        surfaceRefreshPending = true;
        try {
            BeginInvoke((Action)(() => {
                surfaceRefreshPending = false;
                if (IsDisposed || !Visible || !view.IsHandleCreated) return;
                // WebView2 receives its own native size/visibility messages.
                // A synchronous recursive repaint plus two synthetic DOM
                // resize events on every show/WM_SIZE made navigation wait on
                // the whole editor surface. Coalesce to a non-blocking paint;
                // real viewport changes already raise the browser resize event.
                view.Invalidate();
            }));
        } catch { surfaceRefreshPending = false; }
    }
    public void AttachAsChildWindow(IntPtr parent, Rectangle bounds)
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        MinimumSize = Size.Empty;
        MaximizeBox = false;
        MinimizeBox = false;
        ControlBox = false;
        if (!IsWindow(parent)) throw new InvalidOperationException("剪辑页容器已关闭，无法挂载内置剪辑引擎。");
        IntPtr hwnd = Handle;
        // A real child HWND inherits clipping, movement, focus, and z-order
        // from the page host. This replaces independent top-level overlay
        // positioning, which could drift and block the Tk UI thread.
        ClearLastError(0);
        SetParent(hwnd, parent);
        int parentError = Marshal.GetLastWin32Error();
        if (parentError != 0)
            throw new Win32Exception(parentError, "无法将剪辑引擎挂载到剪辑助手工作区。");
        uint style = unchecked((uint)GetWindowLongPtr(hwnd, GWL_STYLE).ToInt64());
        style = (style & ~WS_POPUP) | WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN;
        SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr(unchecked((long)style)));
        long extended = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        extended = (extended & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
        SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(extended));
        uint parentStyle = unchecked((uint)GetWindowLongPtr(parent, GWL_STYLE).ToInt64());
        SetWindowLongPtr(parent, GWL_STYLE, new IntPtr(unchecked((long)(parentStyle | WS_CLIPCHILDREN))));
        if (!SetWindowPos(hwnd, IntPtr.Zero, bounds.X, bounds.Y, bounds.Width, bounds.Height,
            SWP_NOACTIVATE | SWP_FRAMECHANGED | 0x0040))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "无法设置剪辑工作区窗口尺寸。");
    }
    void Log(string text) { try { lock(logLock) File.AppendAllText(log, DateTime.Now.ToString("s") + " " + text + Environment.NewLine); } catch {} }
    async Task StartEditor()
    {
        try {
            Directory.CreateDirectory(Path.Combine(data, "logs"));
            log = Path.Combine(data, "logs", "desktop-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log");
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            byte[] token = new byte[32];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(token);
            sessionToken = BitConverter.ToString(token).Replace("-", "").ToLowerInvariant();
            string nodePath = Environment.GetEnvironmentVariable("CLIPASSIST_NODE_PATH");
            if (String.IsNullOrWhiteSpace(nodePath) || !File.Exists(nodePath))
                nodePath = Path.Combine(root, "runtime", "node", "node.exe");
            var info = new ProcessStartInfo(nodePath);
            string editor = Path.Combine(root, "Modules", "剪辑助手", "剪辑界面");
            info.Arguments = "\"" + Path.Combine(editor, "src", "bootstrap.mjs") + "\"";
            info.WorkingDirectory = editor;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = info.RedirectStandardError = true;
            info.RedirectStandardInput = true;
            info.StandardOutputEncoding = System.Text.Encoding.UTF8;
            info.StandardErrorEncoding = System.Text.Encoding.UTF8;
            info.EnvironmentVariables["CLIPASSIST_APP_EXECUTABLE"] = Application.ExecutablePath;
            info.EnvironmentVariables["CLIPASSIST_NO_WINDOW"] = "1";
            info.EnvironmentVariables["CLIPASSIST_SESSION_TOKEN"] = sessionToken;
            info.EnvironmentVariables["CLIPASSIST_INSTALL_ROOT"] = root;
            info.EnvironmentVariables["CLIPASSIST_STORAGE_ROOT"] = storageRoot;
            info.EnvironmentVariables["CLIPASSIST_SUPPORT_ROOT"] = Path.Combine(storageRoot, "编辑器数据");
            string temporary = Path.Combine(storageRoot, "编辑器数据", "temp");
            Directory.CreateDirectory(temporary);
            info.EnvironmentVariables["TEMP"] = temporary;
            info.EnvironmentVariables["TMP"] = temporary;
            string media = Environment.GetEnvironmentVariable("CLIPASSIST_MEDIA_ROOT");
            if (String.IsNullOrWhiteSpace(media)) media = Path.Combine(root, "Modules", "剪辑助手", "media");
            info.EnvironmentVariables["CLIPASSIST_MEDIA_ROOT"] = media;
            info.EnvironmentVariables["PATH"] = Path.GetDirectoryName(nodePath) + ";" + media + ";" + Environment.GetEnvironmentVariable("PATH");
            job = CreateJobObject(IntPtr.Zero, null);
            var limits = new JobLimits(); limits.Basic.LimitFlags = 0x2000;
            if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Exception("无法初始化后台进程管理。");
            backend = new Process { StartInfo = info, EnableRaisingEvents = true };
            backend.OutputDataReceived += (s, e) => { if (e.Data == null) return; Log(e.Data); if (e.Data.StartsWith("CLIPASSIST_EDITOR_URL=")) ready.TrySetResult(e.Data.Substring("CLIPASSIST_EDITOR_URL=".Length)); };
            backend.ErrorDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
            backend.Exited += (s, e) => { ready.TrySetException(new Exception("剪辑工作区服务已退出。")); if (!closing && IsHandleCreated) BeginInvoke((Action)(() => { closing = true; MessageBox.Show(this, "剪辑工作区服务已退出，请重新打开剪辑首页。\n日志：" + log, "剪辑助手"); Close(); })); };
            backend.Start();
            if (!AssignProcessToJobObject(job, backend.Handle)) throw new Exception("无法关联后台进程管理。");
            backend.BeginOutputReadLine(); backend.BeginErrorReadLine();
            if (await Task.WhenAny(ready.Task, Task.Delay(30 * 60 * 1000)) != ready.Task) throw new Exception("剪辑工作区启动超时，请查看日志后重试。");
            string url = await ready.Task;
            if (closing || IsDisposed) return;
            Uri origin;
            if (!Uri.TryCreate(url, UriKind.Absolute, out origin) || origin.Host != "127.0.0.1") throw new Exception("无效的本地服务地址。");
            editorOrigin = origin.GetLeftPart(UriPartial.Authority);
            var options = new CoreWebView2EnvironmentOptions();
            status.Text = "数据准备完成，正在初始化窗口…";
            Log("WEBVIEW_INITIALIZING");
            var environmentTask = CoreWebView2Environment.CreateAsync(null, Path.Combine(data, "desktop-profile"), options);
            if (await Task.WhenAny(environmentTask, Task.Delay(60000)) != environmentTask) throw new Exception("窗口初始化超时，请查看启动日志。");
            var environment = await environmentTask;
            if (closing || IsDisposed) return;
            await view.EnsureCoreWebView2Async(environment);
            if (closing || IsDisposed) return;
            view.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            view.CoreWebView2.WebResourceRequested += (s,e) => {
                Uri resource;
                if (Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out resource) && resource.GetLeftPart(UriPartial.Authority) == editorOrigin)
                    e.Request.Headers.SetHeader("X-Editor-Session", sessionToken);
            };
            view.CoreWebView2.WebMessageReceived += OnWebMessage;
            view.CoreWebView2.ProcessFailed += (s, e) => {
                Log("WEBVIEW_PROCESS_FAILED " + e.ProcessFailedKind);
                hostState = "error";
                lastError = "剪辑界面渲染进程异常。";
                status.Text = "剪辑界面渲染进程异常，请返回剪辑首页重试。";
                status.Show();
                status.BringToFront();
            };
            string initialWorkspaceMode = workspaceMode == "splice" ? "splice" : "edit";
            await view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.__clipAssistantWorkspaceMode = '" + initialWorkspaceMode + "';");
            await view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
                (() => {
                    const report = (kind, message, source = '', line = 0, column = 0) => {
                        try { window.chrome.webview.postMessage({type:'rendererError', kind, message:String(message || ''), source:String(source || ''), line:Number(line || 0), column:Number(column || 0)}); } catch (_) {}
                    };
                    window.addEventListener('error', event => {
                        if (event instanceof ErrorEvent) {
                            const detail = event.message || (event.error && (event.error.stack || event.error.message)) || '界面脚本运行失败';
                            report('error', detail, event.filename, event.lineno, event.colno);
                            return;
                        }
                        const target = event.target;
                        if (!target || target === window) return;
                        const tag = String(target.tagName || 'resource').toLowerCase();
                        const url = target.currentSrc || target.src || target.href || '';
                        report('resource-error', tag + (url ? ' 加载失败：' + url : ' 加载失败'), '', 0, 0);
                    }, true);
                    window.addEventListener('unhandledrejection', event => report('unhandledrejection', event.reason && (event.reason.stack || event.reason.message) || event.reason), true);
                })();");
            view.CoreWebView2.NavigationCompleted += async (s, e) => {
                Log("NAVIGATION_COMPLETE id=" + e.NavigationId + " success=" + (e.IsSuccess ? "1" : "0") +
                    (e.IsSuccess ? "" : " error=" + e.WebErrorStatus));
                if (!e.IsSuccess) {
                    hostState = "error";
                    lastError = "剪辑界面加载失败：" + e.WebErrorStatus;
                    status.Text = "剪辑界面加载失败，请返回后重试。";
                    status.Show();
                    Log("Navigation failed: " + e.WebErrorStatus);
                    return;
                }
                status.Hide();
                hostState = "ready";
                lastError = "";
                Log("DESKTOP_READY");
                try {
                    await Task.Delay(500);
                    ApplyWorkspaceMode();
                    string probe = await view.CoreWebView2.ExecuteScriptAsync(@"(() => {
                        const visible = element => {
                            if (!element) return false;
                            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
                            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1;
                        };
                        const home = document.getElementById('home'), app = document.getElementById('app');
                        const projectGrid = document.getElementById('homeProjectGrid');
                        const homeCount = document.getElementById('homeCount');
                        const homeEmpty = document.getElementById('homeEmpty');
                        return JSON.stringify({ready:document.readyState, title:document.title, body:!!document.body,
                            bodyChildren:document.body ? document.body.children.length : 0,
                            home:visible(home), app:visible(app), viewport:[innerWidth,innerHeight],
                            projectCards:projectGrid ? projectGrid.querySelectorAll('[data-project-id]').length : -1,
                            homeCount:homeCount ? homeCount.textContent : '', homeEmpty:visible(homeEmpty),
                            toast:(document.getElementById('toast') || {}).textContent || '',
                            homeRect:home ? [Math.round(home.getBoundingClientRect().width),Math.round(home.getBoundingClientRect().height)] : null,
                            appRect:app ? [Math.round(app.getBoundingClientRect().width),Math.round(app.getBoundingClientRect().height)] : null});
                    })()");
                    Log("RENDER_PROBE " + probe);
                    string recovery = await view.CoreWebView2.ExecuteScriptAsync(@"(() => {
                        const home=document.getElementById('home'), app=document.getElementById('app');
                        const visible=element => { if(!element)return false; const s=getComputedStyle(element),r=element.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>1&&r.height>1; };
                        if (!home || !app) return 'missing-editor-root';
                        if (!visible(home) && !visible(app)) {
                            home.classList.remove('hidden'); app.classList.remove('active');
                            window.dispatchEvent(new Event('resize'));
                            return 'restored-project-home';
                        }
                        return 'visible';
                    })()");
                    if (recovery.Contains("missing-editor-root")) {
                        Log("RENDER_RECOVERY_FAILED " + recovery);
                        status.Text = "剪辑界面内容未能初始化，请返回剪辑首页重试。";
                        status.Show();
                        status.BringToFront();
                    } else if (recovery.Contains("restored-project-home")) {
                        Log("RENDER_RECOVERED_PROJECT_HOME");
                        status.Hide();
                    }
                } catch (Exception ex) { Log("RENDER_PROBE_FAILED " + ex); }
            };
            view.CoreWebView2.Settings.AreDevToolsEnabled = false;
            view.CoreWebView2.Settings.IsStatusBarEnabled = false;
            view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            view.CoreWebView2.NavigationStarting += (s, e) => {
                Uri target;
                bool allowed = Uri.TryCreate(e.Uri, UriKind.Absolute, out target) &&
                    target.GetLeftPart(UriPartial.Authority) == origin.GetLeftPart(UriPartial.Authority);
                Log("NAVIGATION_START id=" + e.NavigationId + " allowed=" + (allowed ? "1" : "0"));
                if (!allowed) e.Cancel = true;
            };
            view.CoreWebView2.NewWindowRequested += (s, e) => { e.Handled = true; Uri link; if (e.IsUserInitiated && Uri.TryCreate(e.Uri, UriKind.Absolute, out link) && (link.Scheme == "https" || link.Scheme == "http")) Process.Start(new ProcessStartInfo(link.AbsoluteUri) { UseShellExecute = true }); };
            status.Text = "正在加载编辑界面…";
            view.CoreWebView2.Navigate(url);
        } catch (Exception ex) {
            Log(ex.ToString());
            if (closing || IsDisposed) return;
            hostState = "error";
            lastError = ex.Message;
            status.Text = "剪辑工作区启动失败：" + ex.Message;
            status.Show();
            status.BringToFront();
        }
    }
    async void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args) {
        try {
            Uri source;
            if (!Uri.TryCreate(args.Source, UriKind.Absolute, out source) || source.GetLeftPart(UriPartial.Authority) != editorOrigin) return;
            var message = json.Deserialize<Dictionary<string,object>>(args.WebMessageAsJson);
            string type = message.ContainsKey("type") ? Convert.ToString(message["type"]) : "";
            if (type == "closeReady") { if (closeReply != null && message.ContainsKey("id") && Convert.ToString(message["id"]) == closeRequestId) closeReply.TrySetResult(message); return; }
            if (type == "rendererError") {
                string kind = message.ContainsKey("kind") ? Convert.ToString(message["kind"]) : "error";
                string detail = message.ContainsKey("message") ? Convert.ToString(message["message"]) : "未知脚本错误";
                string rendererSource = message.ContainsKey("source") ? Convert.ToString(message["source"]) : "";
                string line = message.ContainsKey("line") ? Convert.ToString(message["line"]) : "";
                string column = message.ContainsKey("column") ? Convert.ToString(message["column"]) : "";
                if (kind == "resource-error") {
                    Log("RESOURCE_ERROR " + detail);
                    return;
                }
                Log("RENDERER_ERROR " + kind + " " + detail + " " + rendererSource + ":" + line + ":" + column);
                status.Text = "剪辑界面脚本错误，已记录到运行日志；请返回剪辑首页重试。";
                status.Show();
                status.BringToFront();
                return;
            }
            if (type != "droppedFiles" || !message.ContainsKey("id")) return;
            string id = Convert.ToString(message["id"]);
            try {
                var paths = await ReadDroppedFiles();
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new {id = id, result = paths}));
            } catch {
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new {id = id, error = "读取拖入素材失败，请使用导入按钮重试。"}));
            }
        } catch(Exception ex) { Log("Desktop message failed: " + ex.Message); }
    }
    Dictionary<string,object> ObjectValue(Dictionary<string,object> value, string key) { return value.ContainsKey(key) ? value[key] as Dictionary<string,object> : null; }
    async Task<List<string>> ReadDroppedFiles() {
        var paths = new List<string>();
        Exception failure = null;
        try {
            var evaluated = json.Deserialize<Dictionary<string,object>>(await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate", "{\"expression\":\"window.__clipAssistantExternalDropFiles || []\",\"objectGroup\":\"desktop-drop\",\"returnByValue\":false}"));
            var result = ObjectValue(evaluated,"result");
            if (result == null || !result.ContainsKey("objectId")) return paths;
            var properties = json.Deserialize<Dictionary<string,object>>(await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.getProperties",json.Serialize(new {objectId=result["objectId"],ownProperties=true})));
            foreach(object item in (System.Collections.IEnumerable)properties["result"]) {
                var property = item as Dictionary<string,object>; int index;
                if (property == null || !Int32.TryParse(Convert.ToString(property["name"]),out index)) continue;
                var value = ObjectValue(property,"value");
                if (value == null || !value.ContainsKey("objectId")) continue;
                var file = json.Deserialize<Dictionary<string,object>>(await view.CoreWebView2.CallDevToolsProtocolMethodAsync("DOM.getFileInfo", json.Serialize(new {objectId=value["objectId"]})));
                if (file.ContainsKey("path") && File.Exists(Convert.ToString(file["path"]))) paths.Add(Convert.ToString(file["path"]));
                if (paths.Count >= 500) break;
            }
        } catch(Exception ex) { failure = ex; }
        await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate","{\"expression\":\"window.__clipAssistantExternalDropFiles = null\"}");
        await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.releaseObjectGroup","{\"objectGroup\":\"desktop-drop\"}");
        if (failure != null) throw failure;
        return paths;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long A, B; public uint LimitFlags; public UIntPtr C, D; public uint E; public UIntPtr F; public uint G, H; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct JobLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr A, B, C, D; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int type, ref JobLimits info, uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
}
}


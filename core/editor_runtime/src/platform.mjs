import { applicationRoot, applicationDataRoot } from './app-paths.mjs';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, execFile } from "node:child_process";

export const isWindows = process.platform === "win32";
export const isDarwin = process.platform === "darwin";
const FILTERS = {
  media: "支持的素材|*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.wmv;*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp;*.tif;*.tiff;*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.wma;*.srt;*.vtt;*.ass;*.ssa;*.txt|视频|*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.wmv|音频|*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.wma|图片|*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp;*.tif;*.tiff|字幕|*.srt;*.vtt;*.ass;*.ssa;*.txt|所有文件|*.*",
  video: "视频|*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.wmv|所有文件|*.*",
  image: "图片|*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp;*.tif;*.tiff|所有文件|*.*",
  audio: "音频|*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.wma|所有文件|*.*",
  subtitle: "字幕|*.srt;*.vtt;*.ass;*.ssa;*.txt|所有文件|*.*",
  font: "字体|*.ttf;*.otf;*.ttc;*.woff2|所有文件|*.*",
  lut: "LUT 滤镜|*.cube;*.3dl;*.dat;*.m3d;*.csp|所有文件|*.*",
  backup: "剪辑助手备份|*.clipassistantbackup;*.quickcutbackup;*.zip|所有文件|*.*",
  project: "剪辑助手工程|*.zpe;*.json|所有文件|*.*",
  binary: "Antigravity CLI|agy.exe;agy;agy.cmd;*.exe;*.cmd|所有文件|*.*",
};

const PROMPTS = {
  media: "选择素材（视频、音频、图片或字幕，可多选）",
  video: "选择视频",
  image: "选择图片",
  audio: "选择音频",
  subtitle: "选择字幕文件",
  font: "选择字体文件",
  lut: "选择 LUT 滤镜文件",
  backup: "选择剪辑助手工程备份",
  project: "选择工程文件",
  binary: "选择 agy / Antigravity CLI",
};

function darwinTypes(kind) {
  if (kind === "media") return ' of type {"public.movie","public.image","public.audio","public.plain-text"}';
  if (kind === "video") return ' of type {"public.movie"}';
  if (kind === "image") return ' of type {"public.image"}';
  if (kind === "audio") return ' of type {"public.audio"}';
  if (kind === "subtitle") return ' of type {"public.plain-text"}';
  if (kind === "backup") return ' of type {"public.data","public.zip-archive"}';
  return "";
}

function powershellEncoded(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

export function parseWindowsPickerOutput(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const code = lines[0] || "";
  const payload = lines.slice(1).filter(Boolean);
  if (code === "CANCEL") return { status: "cancel", paths: [] };
  if (code === "OK") return { status: "ok", paths: payload };
  if (code === "ERROR")
    return { status: "error", paths: [], error: payload.join("\n") || "文件对话框失败。" };
  const legacy = [code, ...payload].filter(Boolean);
  if (legacy.length) return { status: "ok", paths: legacy };
  return { status: "error", paths: [], error: "文件对话框没有返回结果。" };
}

export function defaultExportPath(fileName) {
  const directory = path.join(applicationRoot(), '导出');
  fs.mkdirSync(directory, { recursive: true });
  const base = path.basename(String(fileName || "剪辑助手导出.mp4"));
  const dest = path.join(directory, base);
  if (!fs.existsSync(dest)) return dest;
  const parsed = path.parse(base);
  return path.join(directory, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

// Keep the media HTTP server and autosave responsive while a native dialog is open.
export function runDialogProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: "utf8", windowsHide: true,
      timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => resolve({
      status: error ? (error.code || 1) : 0,
      stdout: stdout || "", stderr: stderr || error?.message || "",
    }));
  });
}

let pickerQueue = Promise.resolve();
function writePickerResult(scriptBody) {
  const pending = pickerQueue.then(() => runWindowsPicker(scriptBody));
  pickerQueue = pending.catch(() => {});
  return pending;
}

async function runWindowsPicker(scriptBody) {
  const output = path.join(os.tmpdir(), `clipassistant-pick-${crypto.randomUUID()}.txt`);
  const outputLiteral = output.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(0, 0)
$owner.Opacity = 0
$owner.Show()
$owner.BringToFront()
$owner.Activate()
$owner.Focus()
$owner.TopMost = $true
try {
${scriptBody}
} catch {
  [System.IO.File]::WriteAllText('${outputLiteral}', "ERROR\`n$($_.Exception.Message)", [System.Text.UTF8Encoding]::new($false))
} finally {
  $owner.Close()
  $owner.Dispose()
}
`;
  const encoded = Buffer.from(script.replaceAll("__OUTPUT__", outputLiteral), "utf16le").toString("base64");
  const result = await runDialogProcess("powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]);
  let parsed;
  try {
    parsed = fs.existsSync(output)
      ? parseWindowsPickerOutput(fs.readFileSync(output, "utf8"))
      : {
          status: "error",
          paths: [],
          error: String(result.stderr || result.stdout || "").trim() || "无法打开系统文件对话框。",
        };
  } finally {
    try {
      fs.unlinkSync(output);
    } catch {
      /* temp picker file */
    }
  }
  if (parsed.status === "ok") return parsed.paths;
  if (parsed.status === "cancel") return [];
  if (/#<\s*CLIXML|<Objs\b|<S\s+S="Error"/i.test(parsed.error || '')) {
    console.error('Windows picker failed:', parsed.error);
    throw new Error('系统文件对话框启动失败，请重试。');
  }
  throw new Error(parsed.error || "无法打开系统文件对话框。");
}

export function defaultSupportRoot() {
  if (isWindows) return applicationDataRoot();
  return path.join(os.homedir(), "Library", "Application Support", "剪辑助手");
}

export function executableName(name) {
  const base = String(name || "").replace(/\.exe$/i, "");
  return isWindows ? `${base}.exe` : base;
}

export function pathHasBinary(directory, name) {
  if (!directory) return "";
  const raw = path.join(directory, name);
  if (fs.existsSync(raw)) return raw;
  const withExt = path.join(directory, executableName(name));
  if (withExt !== raw && fs.existsSync(withExt)) return withExt;
  return "";
}

export function whichBinary(name) {
  const exe = executableName(name);
  const delimiter = isWindows ? ";" : ":";
  for (const directory of String(process.env.PATH || "").split(delimiter)) {
    const found = pathHasBinary(directory, exe);
    if (found) return found;
  }
  return "";
}

export function mediaSearchRoots() {
  if (!isWindows) {
    return ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];
  }
  return [
    path.join("C:", "ffmpeg-master-latest-win64-gpl-shared", "bin"),
    path.join("C:", "ffmpeg", "bin"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "ffmpeg", "bin"),
  ];
}

export function fontSearchRoots(extra = []) {
  if (isWindows) {
    return [
      ...extra,
      path.join(process.env.WINDIR || "C:\\Windows", "Fonts"),
      path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "Microsoft",
        "Windows",
        "Fonts",
      ),
    ];
  }
  return [
    ...extra,
    path.join(os.homedir(), "Library", "Fonts"),
    "/Library/Fonts",
    "/System/Library/Fonts",
  ];
}

export function fallbackFontFiles() {
  if (isWindows) {
    const fonts = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
    return [
      path.join(fonts, "msyh.ttc"),
      path.join(fonts, "msyhbd.ttc"),
      path.join(fonts, "simhei.ttf"),
      path.join(fonts, "arial.ttf"),
      path.join(fonts, "segoeui.ttf"),
    ];
  }
  return [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  ];
}

export async function chooseFolder(forExport = false) {
  if (!isWindows) {
    const result = await runDialogProcess('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "选择素材所在文件夹")'], {encoding:'utf8'});
    return result.status === 0 ? result.stdout.trim() : null;
  }
  const picked = await runWindowsPicker(`
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${forExport ? "选择导出文件夹" : "选择素材所在文件夹（将搜索所有子文件夹）"}'
$dialog.ShowNewFolderButton = ${forExport ? "$true" : "$false"}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText('__OUTPUT__', "OK\`n$($dialog.SelectedPath)", [System.Text.UTF8Encoding]::new($false))
} else {
  [System.IO.File]::WriteAllText('__OUTPUT__', 'CANCEL', [System.Text.UTF8Encoding]::new($false))
}
$dialog.Dispose()
`);
  return picked[0] || null;
}
export async function defaultDownloadsDirectory() {
  if (isWindows) {
    const result = await runDialogProcess('powershell.exe', ['-NoProfile', '-Command',
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path"], {timeout:10000});
    const folder = result.stdout.trim();
    if (result.status === 0 && path.isAbsolute(folder)) return folder;
  }
  return path.join(os.homedir(), 'Downloads');
}
export async function chooseFile(kind) {
  if (isWindows) {
    const filter = FILTERS[kind] || FILTERS.project;
    const title = PROMPTS[kind] || PROMPTS.project;
    const picked = await writePickerResult(`
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '${title.replaceAll("'", "''")}'
$dialog.Filter = '${filter}'
$dialog.Multiselect = $false
$result = $dialog.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText('__OUTPUT__', "OK\`n$($dialog.FileName)", [System.Text.UTF8Encoding]::new($false))
} else {
  [System.IO.File]::WriteAllText('__OUTPUT__', "CANCEL", [System.Text.UTF8Encoding]::new($false))
}
`);
    return picked[0] || null;
  }
  const script = `POSIX path of (choose file with prompt "${PROMPTS[kind] || PROMPTS.project}"${darwinTypes(kind)})`;
  const result = await runDialogProcess("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function chooseFiles(kind) {
  if (!["font", "media"].includes(kind)) return [];
  if (isWindows) {
    const filter = FILTERS[kind];
    const title = kind === "media"
      ? "选择素材（视频、音频、图片或字幕，可多选）"
      : "选择字体文件（可多选）";
    return writePickerResult(`
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '${title}'
$dialog.Filter = '${filter}'
$dialog.Multiselect = $true
$result = $dialog.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText('__OUTPUT__', ("OK\`n" + ($dialog.FileNames -join [Environment]::NewLine)), [System.Text.UTF8Encoding]::new($false))
} else {
  [System.IO.File]::WriteAllText('__OUTPUT__', "CANCEL", [System.Text.UTF8Encoding]::new($false))
}
`);
  }
  const result = await runDialogProcess(
    "/usr/bin/osascript",
    [
      "-e",
      `set pickedFiles to choose file with prompt "${PROMPTS[kind]}"${darwinTypes(kind)} with multiple selections allowed`,
      "-e",
      'set outputText to ""',
      "-e",
      "repeat with aFile in pickedFiles",
      "-e",
      "set outputText to outputText & POSIX path of aFile & linefeed",
      "-e",
      "end repeat",
      "-e",
      "return outputText",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return [];
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function windowsPickerString(value) {
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(String(value || ''), 'utf8').toString('base64')}'))`;
}

export function windowsSaveDialogScript({title, fileName, filter, initialDirectory = ''}) {
  return `
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = ${windowsPickerString(title)}
$dialog.FileName = ${windowsPickerString(fileName)}
$dialog.Filter = ${windowsPickerString(filter)}
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
$dialog.InitialDirectory = ${initialDirectory ? windowsPickerString(initialDirectory) : "[Environment]::GetFolderPath('MyVideos')"}
$result = $dialog.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText('__OUTPUT__', "OK\`n$($dialog.FileName)", [System.Text.UTF8Encoding]::new($false))
} else {
  [System.IO.File]::WriteAllText('__OUTPUT__', "CANCEL", [System.Text.UTF8Encoding]::new($false))
}
`;
}

export async function chooseOutput(defaultName, extension = "mp4", initialDirectory = "") {
  const fromName = String(defaultName || "").match(/\.([a-z0-9]+)$/i)?.[1];
  const ext = String(extension || fromName || "mp4").replace(/^\./, "") || "mp4";
  const safeName = String(defaultName || `剪辑助手导出.${ext}`).replace(
    /["\\]/g,
    "",
  );
  const isTimeline = ext === "fcpxml";
  const title = isTimeline
    ? "导出达芬奇时间线"
    : ext === "mp3"
      ? "保存导出音频"
      : ext === "png"
        ? "保存静帧"
        : "保存导出视频";
  const filter = isTimeline
    ? "Final Cut / 达芬奇 XML|*.fcpxml|所有文件|*.*"
    : ext === "mp3"
      ? "音频|*.mp3|所有文件|*.*"
      : ext === "png"
        ? "图片|*.png|所有文件|*.*"
        : ext === "zpe"
          ? "剪辑助手工程|*.zpe|所有文件|*.*"
          : "视频|*.mp4;*.mov;*.mp3|所有文件|*.*";
  if (isWindows) {
    const picked = await writePickerResult(windowsSaveDialogScript({title,fileName:safeName,filter,initialDirectory}));
    return picked[0] || null;
  }
  const script = `POSIX path of (choose file name with prompt "${title}" default name "${safeName}")`;
  const result = await runDialogProcess("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function readClipboard() {
  if (isWindows) {
    const result = powershellEncoded(`
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
Write-Output ([Windows.Forms.Clipboard]::GetText())
`);
    if (result.status !== 0) throw new Error("无法读取系统剪贴板。");
    return result.stdout || "";
  }
  const result = spawnSync("/usr/bin/pbpaste", [], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("无法读取系统剪贴板。");
  return result.stdout;
}

export function revealFile(filePath) {
  if (!filePath) return false;
  if (isWindows) {
    const result = spawnSync("explorer.exe", ["/select,", path.resolve(filePath)]);
    return result.status === 0 || result.status === 1;
  }
  return spawnSync("/usr/bin/open", ["-R", filePath]).status === 0;
}

function tarBinary() {
  if (isWindows) {
    const system = path.join(process.env.WINDIR || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(system)) return system;
  }
  return whichBinary("tar") || "tar";
}

export function assertSafeArchiveEntries(entries, destination) {
  const root = path.resolve(destination);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  for (const entry of entries) {
    const name = String(entry || '').replace(/\\/g, '/');
    if (!name || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.startsWith('//'))
      throw new Error('压缩包包含不安全路径，已停止解压。');
    const resolved = path.resolve(root, ...name.split('/'));
    if (resolved !== root && !resolved.startsWith(rootPrefix))
      throw new Error('压缩包包含越界路径，已停止解压。');
  }
}

export function assertSafeArchiveEntryTypes(verboseListing) {
  const lines = String(verboseListing || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('压缩包没有可验证的成员，已停止解压。');
  for (const line of lines) {
    const match = /^([a-zA-Z-])([rwxStTs-]{9})\s/.exec(line);
    if (!match || !['-', 'd'].includes(match[1]))
      throw new Error('压缩包包含链接或特殊文件，已停止解压。');
  }
}

function validateArchiveEntryTypes(archive) {
  const result = spawnSync(tarBinary(), ['-tvf', archive], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || '无法验证压缩包成员类型。');
  assertSafeArchiveEntryTypes(result.stdout);
}

export function archiveEntries(archive) {
  if (isDarwin && fs.existsSync("/usr/bin/unzip")) {
    const result = spawnSync("/usr/bin/unzip", ["-Z1", archive], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error("无法读取工程备份。");
    return String(result.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean);
  }
  const result = spawnSync(tarBinary(), ["-tf", archive], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || "无法读取工程备份。");
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((entry) => entry.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter(Boolean);
}

export function createArchive(destination, items, cwd) {
  if (isDarwin && fs.existsSync("/usr/bin/zip")) {
    const result = spawnSync("/usr/bin/zip", ["-qry", destination, ...items], {
      cwd,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "备份失败。");
    return destination;
  }
  const result = spawnSync(tarBinary(), ["-a", "-cf", destination, ...items], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || "备份失败。");
  return destination;
}

export function extractArchive(archive, destination) {
  validateArchiveEntryTypes(archive);
  const entries = archiveEntries(archive);
  assertSafeArchiveEntries(entries, destination);
  if (isDarwin && fs.existsSync("/usr/bin/unzip")) {
    const result = spawnSync("/usr/bin/unzip", ["-q", archive, "-d", destination], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "恢复失败。");
    return destination;
  }
  const result = spawnSync(tarBinary(), ["-xf", archive, "-C", destination], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || "恢复失败。");
  return destination;
}

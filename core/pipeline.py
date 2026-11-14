from __future__ import annotations

import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFont

from .denoise import denoise_video


VIDEO_SUFFIXES = {
    ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".mpeg", ".mpg",
    ".ts", ".flv", ".wmv", ".3gp", ".mts", ".m2ts", ".ogv", ".vob",
}


@dataclass
class DownloadTask:
    number: str
    name: str
    title: str
    promotion: str
    url: str
    output_root: str
    theme: str = "白天"
    strength_mode: str = "全局"
    strength_percent: int | None = None

    @property
    def folder_name(self) -> str:
        return f"{safe_component(self.name)}-{safe_component(self.title)}"


def safe_component(value: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", str(value or "")).strip().rstrip(". ")
    if not value or value in {".", ".."}:
        raise ValueError("名称为空或不包含可用字符")
    if value.split(".")[0].upper() in {
        "CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }:
        value = "_" + value
    return value[:80].rstrip(". ") or "视频"


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        [Path("C:/Windows/Fonts/msyhbd.ttc"), Path("C:/Windows/Fonts/arialbd.ttf")]
        if bold
        else [Path("C:/Windows/Fonts/msyh.ttc"), Path("C:/Windows/Fonts/arial.ttf")]
    )
    for candidate in candidates:
        if candidate.is_file():
            try:
                return ImageFont.truetype(str(candidate), size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def _wrap_text(draw: ImageDraw.ImageDraw, value: str, face: ImageFont.ImageFont, width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in str(value or "").splitlines() or [""]:
        current = ""
        for char in paragraph:
            candidate = current + char
            if current and draw.textbbox((0, 0), candidate, font=face)[2] > width:
                lines.append(current)
                current = char
            else:
                current = candidate
        lines.append(current)
    return [line for line in lines if line.strip()]


def generate_title_png(task: DownloadTask, folder: Path) -> Path:
    """Create a transparent vertical promo/title graphic beside the video."""
    folder.mkdir(parents=True, exist_ok=True)
    width, height = 1080, 1920
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    dark = task.theme == "黑天"
    ink = (255, 255, 255, 255) if dark else (19, 23, 22, 255)
    accent = (246, 190, 64, 255) if dark else (238, 128, 54, 255)
    panel = (15, 18, 19, 236) if dark else (250, 250, 248, 242)

    title_face = _font(100, bold=True)
    title_lines = _wrap_text(draw, task.title, title_face, 920)[:4]
    title_y = 250
    for line in title_lines:
        box = draw.textbbox((0, 0), line, font=title_face, stroke_width=1)
        line_w = box[2] - box[0]
        draw.text(((width - line_w) / 2, title_y), line, font=title_face, fill=ink,
                  stroke_width=1, stroke_fill=(0, 0, 0, 100) if not dark else (0, 0, 0, 160))
        title_y += max(105, box[3] - box[1] + 24)

    top, bottom = 1370, 1840
    draw.rounded_rectangle((48, top, width - 48, bottom), radius=44, fill=panel)
    if task.promotion.strip():
        promo_face = _font(48, bold=True)
        promo_lines = _wrap_text(draw, task.promotion.strip(), promo_face, 870)[:4]
        y = top + 52
        for line in promo_lines:
            box = draw.textbbox((0, 0), line, font=promo_face)
            draw.text(((width - (box[2] - box[0])) / 2, y), line, font=promo_face, fill=ink)
            y += max(54, box[3] - box[1] + 10)

    if task.number.strip():
        phone_face = _font(62, bold=True)
        text = task.number.strip()
        box = draw.textbbox((0, 0), text, font=phone_face)
        draw.text(((width - (box[2] - box[0])) / 2, bottom - 118), text,
                  font=phone_face, fill=accent)

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    filename = f"{safe_component(task.name)}-{safe_component(task.title)}-{timestamp}.png"
    output = folder / filename
    image.save(output, format="PNG", optimize=True)
    return output


def _drive_link(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in {"drive.google.com", "docs.google.com"}


def _download_files(
    url: str,
    target: Path,
    progress: Callable[[str], None],
    cancel,
    resource_dir: Path,
) -> list[Path]:
    target.mkdir(parents=True, exist_ok=True)
    if _drive_link(url):
        try:
            import gdown

            if "/folders/" in url:
                gdown.download_folder(url, output=str(target), quiet=True, use_cookies=False)
            else:
                gdown.download(url, output=str(target / "drive-video.mp4"), quiet=True, fuzzy=True)
        except Exception as exc:
            raise RuntimeError(f"Google Drive 下载失败：{exc}") from exc
    else:
        import yt_dlp

        ffmpeg_dir = resource_dir / "ffmpeg"

        def hook(data):
            if cancel.is_set():
                raise RuntimeError("任务已取消")
            if data.get("status") == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate")
                done = data.get("downloaded_bytes") or 0
                if total:
                    progress(f"下载中 {min(99, int(done * 100 / total))}%")
                else:
                    progress("下载中")
            elif data.get("status") == "finished":
                progress("下载完成，准备降噪")

        options = {
            "outtmpl": str(target / "%(title).150B [%(id)s].%(ext)s"),
            "format": "bestvideo*+bestaudio/best",
            "merge_output_format": "mp4",
            "ffmpeg_location": str(ffmpeg_dir),
            "noplaylist": True,
            "windowsfilenames": True,
            "overwrites": False,
            "continuedl": True,
            "retries": 3,
            "socket_timeout": 30,
            "max_filesize": 2 * 1024 * 1024 * 1024,
            "progress_hooks": [hook],
            "quiet": True,
            "no_warnings": True,
        }
        with yt_dlp.YoutubeDL(options) as downloader:
            code = downloader.download([url])
            if code:
                raise RuntimeError("视频下载失败")

    files = sorted(
        (item for item in target.rglob("*") if item.is_file() and item.suffix.lower() in VIDEO_SUFFIXES),
        key=lambda item: item.name.casefold(),
    )
    if not files:
        raise RuntimeError("没有找到下载的视频文件")
    return files


def run_task(
    task: DownloadTask,
    *,
    global_strength_percent: int,
    resource_dir: Path,
    progress: Callable[[str], None],
    cancel,
) -> list[Path]:
    root = Path(task.output_root).expanduser().resolve()
    folder = root / task.folder_name
    folder.mkdir(parents=True, exist_ok=True)
    generate_title_png(task, folder)

    if not task.url.strip():
        progress("标题图片已生成")
        return []
    if cancel.is_set():
        raise RuntimeError("任务已取消")

    stage = Path(tempfile.mkdtemp(prefix=".download-", dir=folder))
    strength_percent = (
        task.strength_percent
        if task.strength_mode == "单条" and task.strength_percent is not None
        else global_strength_percent
    )
    output_files: list[Path] = []
    errors: list[str] = []
    try:
        downloaded = _download_files(task.url.strip(), stage, progress, cancel, resource_dir)
        for index, source in enumerate(downloaded, start=1):
            if cancel.is_set():
                raise RuntimeError("任务已取消")
            progress(f"正在降噪 {index}/{len(downloaded)}")
            try:
                final_source = denoise_video(
                    source,
                    strength_percent=strength_percent,
                    resource_dir=resource_dir,
                    progress=progress,
                    cancel=cancel,
                )
            except Exception as exc:
                errors.append(f"{source.name}：{exc}")
                final_source = source
            destination = folder / final_source.name
            if destination.exists():
                progress(f"同名视频已存在，保留原文件：{destination.name}")
                continue
            shutil.move(str(final_source), str(destination))
            output_files.append(destination)
        if errors:
            raise RuntimeError("有视频降噪失败，原视频已保留：\n" + "\n".join(errors))
        return output_files
    finally:
        shutil.rmtree(stage, ignore_errors=True)

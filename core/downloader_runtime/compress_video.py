"""Post-download H.264/AAC transcode with verified timing and atomic publish."""
from __future__ import annotations

import json
import math
import os
import queue
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Callable


FPS = 30
CRF = 18
AUDIO_RATE = "128k"
AUDIO_SAMPLE_RATE = 44100


def _run_probe(command: list[str], cancel: threading.Event | None = None) -> str:
    process = subprocess.Popen(
        command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    while True:
        try:
            stdout, stderr = process.communicate(timeout=0.2)
            break
        except subprocess.TimeoutExpired:
            if cancel and cancel.is_set():
                process.terminate()
                try:
                    process.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                raise RuntimeError("任务已取消")
    if process.returncode:
        raise RuntimeError((stderr or stdout or "媒体信息读取失败").strip()[-1200:])
    return stdout


def _seconds(value) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if result > 0 else 0.0


def _is_attached_picture(stream: dict) -> bool:
    disposition = stream.get("disposition") or {}
    value = disposition.get("attached_pic", 0)
    return value is True or str(value).strip().casefold() in {"1", "true"}


def _probe(path: Path, ffprobe: Path, cancel=None) -> dict:
    raw = _run_probe([
        str(ffprobe), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ], cancel)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"无法读取媒体信息：{path.name}") from exc
    streams = data.get("streams") or []
    # Some files store cover art as a video stream before the actual moving
    # picture. Never let that attached still become the delivery video.
    video = next((item for item in streams
                  if item.get("codec_type") == "video" and not _is_attached_picture(item)
                  and int(item.get("width") or 0) > 0 and int(item.get("height") or 0) > 0), None)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    if not video:
        raise RuntimeError(f"没有找到视频画面：{path.name}")
    rate = str(video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1").split("/")
    try:
        fps = float(rate[0]) / float(rate[1]) if len(rate) == 2 and float(rate[1]) else 0.0
    except (TypeError, ValueError, ZeroDivisionError):
        fps = 0.0
    format_data = data.get("format") or {}
    return {
        "video": video,
        "video_stream_index": int(video["index"]),
        "audio": audio,
        "duration": _seconds(format_data.get("duration")) or _seconds(video.get("duration")),
        "video_duration": _seconds(video.get("duration")) or _seconds(format_data.get("duration")),
        "audio_duration": (_seconds(audio.get("duration")) or _seconds(format_data.get("duration"))) if audio else 0.0,
        "video_start": _float_or_zero(video.get("start_time")),
        "audio_start": _float_or_zero(audio.get("start_time")) if audio else 0.0,
        "fps": fps,
        "audio_bitrate": _int_or_zero(audio.get("bit_rate")) if audio else 0,
    }


def _sample_aspect_ratio(video: dict) -> float:
    sample_aspect = str(video.get("sample_aspect_ratio") or "1:1")
    try:
        numerator, denominator = (float(part) for part in sample_aspect.replace("/", ":").split(":", 1))
        if numerator > 0 and denominator > 0:
            return numerator / denominator
    except (TypeError, ValueError):
        pass
    return 1.0


def _rotation_degrees(video: dict) -> int:
    rotation = None
    for side_data in video.get("side_data_list") or []:
        if side_data.get("rotation") is not None:
            rotation = _float_or_zero(side_data.get("rotation"))
            break
    if rotation is None:
        try:
            rotation = float((video.get("tags") or {}).get("rotate", 0))
        except (TypeError, ValueError):
            rotation = 0.0
    return int(round(rotation)) % 360


def _display_dimensions(video: dict) -> tuple[float, float]:
    """Return display dimensions after sample aspect ratio and rotation."""
    width = float(_int_or_zero(video.get("width")))
    height = float(_int_or_zero(video.get("height")))
    if width <= 0 or height <= 0:
        raise RuntimeError("无法读取视频画面尺寸")
    width *= _sample_aspect_ratio(video)
    if _rotation_degrees(video) in (90, 270):
        width, height = height, width
    return width, height


def _even_display_dimensions(video: dict) -> tuple[int, int]:
    """Keep the source display size, trimming at most one odd edge pixel for 4:2:0."""
    display_width, display_height = _display_dimensions(video)
    width = max(2, math.floor(display_width / 2) * 2)
    height = max(2, math.floor(display_height / 2) * 2)
    return width, height


def _video_filter(video: dict, output_width: int, output_height: int,
                  fps: float | None = FPS) -> str:
    display_width, display_height = _display_dimensions(video)
    filters = []
    if (abs(display_width - output_width) > 0.01 or
            abs(display_height - output_height) > 0.01 or
            abs(_sample_aspect_ratio(video) - 1.0) > 0.001):
        filters.append(f"scale={output_width}:{output_height}:flags=lanczos+accurate_rnd")
    # The output dimensions already include any source pixel aspect ratio.
    # Normalize to square pixels so players cannot reinterpret the frame shape.
    filters.append("setsar=1")
    if fps is not None:
        filters.append(f"fps={fps:g}")
    return ",".join(filters)


def _float_or_zero(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _int_or_zero(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _recommended_cap(path: Path, media: dict) -> float:
    """Keep the compressed stream below a generous source-relative quality ceiling."""
    pixels = int(media["video"].get("width") or 0) * int(media["video"].get("height") or 0)
    pixel_budget = 60.0 if pixels >= 7_000_000 else 36.0 if pixels >= 3_000_000 else 20.0 if pixels >= 1_500_000 else 12.0
    duration = media["duration"]
    if not duration:
        return 2.30
    total_mbps = path.stat().st_size * 8 / duration / 1_000_000
    audio_mbps = (media["audio_bitrate"] / 1_000_000) if media["audio"] and media["audio_bitrate"] else (0.128 if media["audio"] else 0)
    source_video_mbps = max(0.01, total_mbps - audio_mbps)
    return max(0.01, min(pixel_budget, source_video_mbps * 0.75))


def _encode_once(command: list[str], duration: float, *, cancel=None,
                 progress: Callable[[float], None] | None = None) -> None:
    process = subprocess.Popen(
        command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    messages: queue.Queue[tuple[str, str]] = queue.Queue()

    def collect(stream, label):
        try:
            for line in iter(stream.readline, ""):
                messages.put((label, line.rstrip()))
        finally:
            messages.put((label, ""))

    readers = [threading.Thread(target=collect, args=(process.stdout, "out"), daemon=True),
               threading.Thread(target=collect, args=(process.stderr, "err"), daemon=True)]
    for reader in readers:
        reader.start()
    closed = set()
    errors: list[str] = []
    last_progress = 0.0
    last_report = 0.0
    while process.poll() is None or len(closed) < 2:
        if cancel and cancel.is_set() and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise RuntimeError("任务已取消")
        try:
            label, line = messages.get(timeout=0.2)
        except queue.Empty:
            continue
        if not line:
            closed.add(label)
        elif label == "err":
            errors.append(line)
            del errors[:-30]
        elif line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                current = int(line.split("=", 1)[1]) / 1_000_000
                last_progress = max(0.0, min(1.0, current / max(duration, 0.01)))
                now = time.monotonic()
                if progress and now - last_report >= 0.35:
                    progress(last_progress)
                    last_report = now
            except ValueError:
                pass
    for reader in readers:
        reader.join(timeout=0.5)
    if process.returncode:
        detail = "\n".join(errors).strip()
        raise RuntimeError(detail[-1600:] or f"H.264 转码失败（退出码 {process.returncode}）")
    if cancel and cancel.is_set():
        raise RuntimeError("任务已取消")
    if progress:
        progress(1.0)


def transcode_mp4(video: Path, *, resource_dir: Path, cancel=None,
                  progress: Callable[[str], None] | None = None,
                  remove_source: bool = False, compress: bool = True) -> Path:
    """Compress/convert to MP4 without imposing an output aspect ratio.

    Encoded dimensions follow the source display dimensions; scaling is only
    used to normalize non-square pixels or trim an odd edge for 4:2:0. With
    compress=False, a compatible source is stream-copied; otherwise it is
    encoded at visually lossless CRF 0. The source remains untouched until the
    staged MP4 passes validation.
    """
    video = Path(video)
    ffmpeg = Path(resource_dir) / "ffmpeg" / "ffmpeg.exe"
    ffprobe = Path(resource_dir) / "ffmpeg" / "ffprobe.exe"
    if not video.is_file():
        raise RuntimeError(f"转码源文件不存在：{video.name}")
    if not ffmpeg.is_file() or not ffprobe.is_file():
        raise RuntimeError("转码组件缺失（FFmpeg/FFprobe）")
    if cancel and cancel.is_set():
        raise RuntimeError("任务已取消")

    source = _probe(video, ffprobe, cancel)
    if source["duration"] <= 0:
        raise RuntimeError(f"无法读取视频时长：{video.name}")
    output = video.with_suffix(".mp4")
    staged = video.parent / f".clipassistant-transcode-{uuid.uuid4().hex}.mp4"
    source_video = source["video"]
    source_codec = (source_video.get("codec_name") or "").casefold()
    expected_fps = source["fps"] if compress else FPS
    source_width = int(source_video.get("width") or 0)
    source_height = int(source_video.get("height") or 0)
    display_width, display_height = _display_dimensions(source_video)
    expected_width, expected_height = _even_display_dimensions(source_video)
    stream_copy = False
    if compress:
        cap_mbps = _recommended_cap(video, source)
        maxrate = f"{cap_mbps * 1.2:.2f}M"
        bufsize = f"{cap_mbps * 2:.2f}M"
        video_args = [
            "-vf", _video_filter(source_video, expected_width, expected_height, fps=None),
            "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", str(CRF), "-maxrate", maxrate, "-bufsize", bufsize, "-pix_fmt", "yuv420p",
        ]
        progress_label = f"H.264 压缩转码 CRF {CRF}"
    else:
        source_pixel_format = (source_video.get("pix_fmt") or "").casefold()
        source_matches_delivery_profile = (
            source_codec == "h264" and source_width % 2 == 0 and source_height % 2 == 0 and
            source_pixel_format == "yuv420p" and abs(source["fps"] - FPS) <= 0.02
        )
        if source_matches_delivery_profile:
            video_args = ["-c:v", "copy"]
            expected_width, expected_height = source_width, source_height
            stream_copy = True
            progress_label = "MP4 转码封装（视频流直拷）"
        else:
            video_args = [
                "-vf", _video_filter(source_video, expected_width, expected_height),
                "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast",
                "-crf", "0", "-pix_fmt", "yuv420p",
            ]
            progress_label = "MP4 H.264 转码（跳过压缩）"
        if source_width <= 0 or source_height <= 0 or source["fps"] <= 0:
            raise RuntimeError(f"无法读取视频规格，未压缩转码：{video.name}")
    command = [
        str(ffmpeg), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-nostats", "-stats_period", "0.35", "-progress", "pipe:1", "-i", str(video),
        "-map", f"0:{source['video_stream_index']}", "-map", "0:a:0?", "-map_metadata", "0",
        *video_args,
        *([] if stream_copy else ["-metadata:s:v:0", "rotate=0"]),
        "-c:a", "aac", "-b:a", AUDIO_RATE, "-ar", str(AUDIO_SAMPLE_RATE), "-ac", "2",
        "-movflags", "+faststart", "-f", "mp4", str(staged),
    ]
    try:
        _encode_once(command, source["duration"], cancel=cancel,
                     progress=(lambda ratio: progress(f"{progress_label} {round(ratio * 100)}%") if progress else None))
        if not staged.is_file() or staged.stat().st_size < 1024:
            raise RuntimeError("MP4 转码结果为空或过小，原视频未替换")
        result = _probe(staged, ffprobe, cancel)
        video_stream = result["video"]
        if (video_stream.get("codec_name") or "").casefold() != "h264":
            raise RuntimeError("转码结果不是 H.264，原视频未替换")
        if (int(video_stream.get("width") or 0) != expected_width or
                int(video_stream.get("height") or 0) != expected_height):
            raise RuntimeError("转码分辨率校验失败，原视频未替换")
        result_display_width, result_display_height = _display_dimensions(video_stream)
        expected_display_width, expected_display_height = (
            (display_width, display_height) if stream_copy else (expected_width, expected_height)
        )
        if (abs(result_display_width - expected_display_width) > 1.0 or
                abs(result_display_height - expected_display_height) > 1.0):
            raise RuntimeError("转码画面方向或比例校验失败，原视频未替换")
        if abs(result["fps"] - expected_fps) > 0.02:
            raise RuntimeError("转码帧率校验失败，原视频未替换")
        if abs(result["video_duration"] - source["video_duration"]) > 0.15:
            raise RuntimeError("转码后画面时长变化过大，原视频未替换")
        if source["audio"]:
            if not result["audio"]:
                raise RuntimeError("MP4 缺少原视频音轨，原视频未替换")
            output_audio = result["audio"]
            if (output_audio.get("codec_name") != "aac" or
                    int(output_audio.get("sample_rate") or 0) != AUDIO_SAMPLE_RATE or
                    int(output_audio.get("channels") or 0) != 2):
                raise RuntimeError("MP4 音频规格校验失败（AAC / 44.1 kHz / 双声道），原视频未替换")
            if abs((result["audio_start"] - result["video_start"]) -
                   (source["audio_start"] - source["video_start"])) > 0.04:
                raise RuntimeError("转码后音画起始时间未对齐，原视频未替换")
            if abs(result["audio_duration"] - source["audio_duration"]) > 0.15:
                raise RuntimeError("转码后音轨时长校验失败，原视频未替换")
        if cancel and cancel.is_set():
            raise RuntimeError("任务已取消")
        os.replace(staged, output)
        if remove_source and video != output:
            video.unlink(missing_ok=True)
        return output
    finally:
        staged.unlink(missing_ok=True)

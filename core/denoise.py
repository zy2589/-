from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
import wave
from pathlib import Path
from typing import Callable

from .media_runtime import media_binary


SAMPLE_RATE = 48_000
CHUNK_FRAMES = 60 * SAMPLE_RATE
CONTEXT_FRAMES = int(0.5 * SAMPLE_RATE)
WARMUP_FRAMES = int(0.24 * SAMPLE_RATE)
OPENING_PASSTHROUGH_FRAMES = int(0.8 * SAMPLE_RATE)
OPENING_BLEND_FRAMES = int(0.12 * SAMPLE_RATE)


def _run(command: list[str], *, cwd: Path | None = None, cancel: threading.Event | None = None) -> str:
    if cancel and cancel.is_set():
        raise RuntimeError("任务已取消")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    process = subprocess.Popen(
        command,
        cwd=str(cwd) if cwd else None,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=flags,
    )
    try:
        while True:
            try:
                stdout, stderr = process.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if not cancel or not cancel.is_set():
                    continue
                process.terminate()
                try:
                    process.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                raise RuntimeError("任务已取消")
    except BaseException:
        if process.poll() is None:
            process.kill()
            process.communicate()
        raise
    if process.returncode != 0:
        detail = (stderr or stdout or "").strip()
        raise RuntimeError(detail[-1800:] or f"媒体处理失败（退出码 {process.returncode}）")
    if cancel and cancel.is_set():
        raise RuntimeError("任务已取消")
    return stdout


def _wave_info(path: Path) -> tuple[int, int, int]:
    with wave.open(str(path), "rb") as reader:
        return reader.getnchannels(), reader.getframerate(), reader.getnframes()


def _is_attached_picture(stream: dict) -> bool:
    disposition = stream.get("disposition") or {}
    value = disposition.get("attached_pic", 0)
    return value is True or str(value).strip().casefold() in {"1", "true"}


def _probe_media(video: Path, ffprobe: Path,
                 cancel: threading.Event | None = None) -> tuple[int, float, float, float, float, float, int]:
    output = _run(
        [
            str(ffprobe), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video),
        ], cancel=cancel,
    )
    try:
        data = json.loads(output)
        streams = data.get("streams") or []
        audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
        # Prefer the real video picture. MP4/MOV files can list cover art as a
        # video stream before the moving picture; mapping v:0 would keep only
        # that poster frame and can make players treat the result as audio-only.
        video_stream = next((item for item in streams
                             if item.get("codec_type") == "video" and not _is_attached_picture(item)
                             and int(item.get("width") or 0) > 0 and int(item.get("height") or 0) > 0), None)
        if audio is None:
            raise RuntimeError("视频没有音轨，无法自动降噪")
        if video_stream is None:
            raise RuntimeError("没有找到可播放的视频画面，未替换原视频")
        channels = int(audio.get("channels") or 1)
        duration = float(audio.get("duration") or (data.get("format") or {}).get("duration") or 0)
        audio_start = float(audio.get("start_time") or 0)
        video_start = float((video_stream or {}).get("start_time") or 0)
        video_duration = float((video_stream or {}).get("duration") or (data.get("format") or {}).get("duration") or 0)
        rate = str((video_stream or {}).get("avg_frame_rate") or "30/1").split("/")
        fps = float(rate[0]) / max(float(rate[1]), 1.0) if len(rate) == 2 else 30.0
        if duration <= 0:
            raise RuntimeError("无法读取视频时长")
        if video_duration <= 0:
            raise RuntimeError("无法读取视频画面时长")
        return (max(1, min(channels, 2)), duration, audio_start, video_start,
                video_duration, 1.0 / max(fps, 1.0), int(video_stream["index"]))
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("无法读取视频音轨信息") from exc


def denoise_video(
    video: Path,
    *,
    strength_percent: int,
    resource_dir: Path,
    progress: Callable[[str], None] | None = None,
    cancel: threading.Event | None = None,
    output_audio_bitrate: str = "192k",
    output_sample_rate: int | None = None,
    output_channels: int | None = None,
) -> Path:
    """Denoise the audio in a staged video and mux it back without re-encoding video."""
    video = Path(video)
    ffmpeg = media_binary(resource_dir, "ffmpeg")
    ffprobe = media_binary(resource_dir, "ffprobe")
    # Packaged builds stage the shared executable at the resource root.
    # Development checkouts keep it with the editor runtime assets.
    denoiser = next((candidate for candidate in (
        (Path(os.environ["CLIPASSIST_MEDIA_ROOT"]) /
         ("deep-filter.exe" if os.name == "nt" else "deep-filter"))
        if os.environ.get("CLIPASSIST_MEDIA_ROOT") else resource_dir / ("deep-filter.exe" if os.name == "nt" else "deep-filter"),
        resource_dir / "editor-runtime" / ("deep-filter.exe" if os.name == "nt" else "deep-filter"),
        Path(__file__).resolve().parent.parent / "resources" / "editor-runtime" /
        ("deep-filter.exe" if os.name == "nt" else "deep-filter"),
    ) if candidate.is_file()), resource_dir / ("deep-filter.exe" if os.name == "nt" else "deep-filter"))
    for required in (ffmpeg, ffprobe, denoiser):
        if not required.is_file():
            raise RuntimeError(f"降噪运行文件缺失：{required.name}")

    channels, duration, audio_start, video_start, video_duration, frame_tolerance, video_stream_index = _probe_media(video, ffprobe, cancel)
    mux_channels = max(1, min(2, int(output_channels or channels)))
    mux_sample_rate = max(8_000, int(output_sample_rate or SAMPLE_RATE))
    strength = max(0, min(100, int(strength_percent))) / 100.0
    # Keep the existing strength control on the model itself. Only the opening
    # is protected with source audio; blending dry and wet across the full track
    # can make speech sound phasey or hollow.
    attenuation_db = round(10.0 + 90.0 * strength)
    final_suffix = video.suffix.lower()
    if final_suffix not in {".mp4", ".m4v", ".mov", ".mkv", ".webm"}:
        final_suffix = ".mkv"
    final_path = video.with_suffix(final_suffix)

    work = Path(tempfile.mkdtemp(prefix=".clipassistant-", dir=video.parent))
    try:
        normalized = work / "source.wav"
        _run(
            [
                str(ffmpeg), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                "-i", str(video), "-map", "0:a:0", "-vn", "-ar", str(SAMPLE_RATE),
                "-ac", str(channels), "-c:a", "pcm_s16le", str(normalized),
            ], cancel=cancel,
        )
        actual_channels, sample_rate, total_frames = _wave_info(normalized)
        if sample_rate != SAMPLE_RATE or actual_channels not in (1, 2) or total_frames == 0:
            raise RuntimeError("音轨转换结果无效，未替换原视频")

        channel_paths: list[Path] = []
        for channel in range(actual_channels):
            channel_path = work / f"channel-{channel}.wav"
            if actual_channels == 1:
                shutil.copy2(normalized, channel_path)
            else:
                label = "FL" if channel == 0 else "FR"
                _run(
                    [
                        str(ffmpeg), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-i", str(normalized), "-af", f"pan=mono|c0={label}",
                        "-c:a", "pcm_s16le", str(channel_path),
                    ], cancel=cancel,
                )
            channel_paths.append(channel_path)

        clean_channels: list[Path] = []
        chunk_count = (total_frames + CHUNK_FRAMES - 1) // CHUNK_FRAMES
        for channel, channel_path in enumerate(channel_paths):
            clean_parts: list[str] = []
            for chunk_index, start in enumerate(range(0, total_frames, CHUNK_FRAMES)):
                if cancel and cancel.is_set():
                    raise RuntimeError("任务已取消")
                end = min(start + CHUNK_FRAMES, total_frames)
                input_start = max(0, start - CONTEXT_FRAMES)
                input_end = min(total_frames, end + CONTEXT_FRAMES)
                warmup_frames = (
                    min(WARMUP_FRAMES, input_end - input_start)
                    if input_start == 0 else WARMUP_FRAMES
                )
                trim_start = warmup_frames + start - input_start
                part_name = f"input-{channel}-{chunk_index}.wav"
                clean_name = f"clean-{channel}-{chunk_index}.wav"
                part = work / part_name
                clean = work / clean_name
                enhanced_dir = work / f"enhanced-{channel}-{chunk_index}"
                enhanced_dir.mkdir()

                start_seconds = input_start / SAMPLE_RATE
                input_seconds = (input_end - input_start) / SAMPLE_RATE
                if input_start == 0:
                    # Match 降噪助手: duplicate the real opening as preroll so
                    # DeepFilterNet sees speech before the first output sample.
                    # The duplicate is removed below to preserve source timing.
                    prefix_frames = warmup_frames
                    input_filter = (
                        f"[0:a]atrim=start_sample=0:end_sample={prefix_frames},"
                        f"asetpts=PTS-STARTPTS[prefix];"
                        f"[0:a]atrim=start_sample=0:end_sample={input_end - input_start},"
                        f"asetpts=PTS-STARTPTS[body];"
                        f"[prefix][body]concat=n=2:v=0:a=1,"
                        f"apad=pad_len={WARMUP_FRAMES + CONTEXT_FRAMES}[padded]"
                    )
                    input_filters = ["-filter_complex", input_filter, "-map", "[padded]"]
                else:
                    input_filters = [
                        "-af",
                        # Keep extra context after the requested segment so
                        # the model's final analysis window cannot shorten
                        # aligned audio at a chunk or file boundary.
                        f"adelay={WARMUP_FRAMES}S:all=1,apad=pad_len={WARMUP_FRAMES + CONTEXT_FRAMES}",
                    ]
                _run(
                    [
                        str(ffmpeg), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-ss", f"{start_seconds:.9f}", "-t", f"{input_seconds:.9f}",
                        "-i", str(channel_path), *input_filters,
                        "-c:a", "pcm_s16le", str(part),
                    ], cancel=cancel,
                )
                if progress:
                    percent = int((chunk_index + 1) * 100 / chunk_count)
                    progress(f"降噪中 {percent}% · 声道 {channel + 1}/{actual_channels}")
                denoiser_args = [
                    str(denoiser), "--output-dir", str(enhanced_dir),
                    "--atten-lim-db", str(attenuation_db),
                ]
                if strength >= 0.65:
                    denoiser_args.append("--pf")
                denoiser_args.append(str(part))
                _run(denoiser_args, cwd=work, cancel=cancel)
                enhanced = next(enhanced_dir.glob("*.wav"), None)
                if enhanced is None or not enhanced.is_file():
                    raise RuntimeError("DeepFilterNet 输出文件缺失，未替换原视频")
                output_frames = end - start
                required_end = trim_start + output_frames
                enhanced_info = _wave_info(enhanced)
                if enhanced_info[:2] != (1, SAMPLE_RATE):
                    raise RuntimeError("降噪器输出格式异常，未替换原视频")
                # Some DeepFilterNet builds return a few fewer samples at the final
                # analysis window even with right-side context. Only tolerate
                # a small boundary deficit; pad that tail before trimming so
                # every chunk remains exactly aligned to the source sample grid.
                missing_tail = max(0, required_end - enhanced_info[2])
                if missing_tail > int(0.08 * SAMPLE_RATE):
                    raise RuntimeError(
                        "降噪输出时长校验失败，未替换原视频 "
                        f"（第 {chunk_index + 1}/{chunk_count} 段缺少 {missing_tail} 个采样）"
                    )
                _run(
                    [
                        str(ffmpeg), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-i", str(enhanced), "-af",
                        f"apad=whole_len={required_end},atrim=start_sample={trim_start}:end_sample={required_end},asetpts=PTS-STARTPTS",
                        "-c:a", "pcm_s16le", str(clean),
                    ], cancel=cancel,
                )
                clean_info = _wave_info(clean)
                if clean_info != (1, SAMPLE_RATE, output_frames):
                    raise RuntimeError(
                        "降噪输出时长校验失败，未替换原视频 "
                        f"（第 {chunk_index + 1}/{chunk_count} 段：需要 {output_frames} 个采样，"
                        f"实际 {clean_info[2]} 个）"
                    )
                clean_parts.append(clean_name)

            list_path = work / f"segments-{channel}.txt"
            list_path.write_text(
                "".join(f"file '{name}'\n" for name in clean_parts), encoding="ascii"
            )
            full_channel = work / f"full-clean-{channel}.wav"
            _run(
                [
                    str(ffmpeg), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-f", "concat", "-safe", "1", "-i", str(list_path),
                    "-c:a", "copy", str(full_channel),
                ], cwd=work, cancel=cancel,
            )
            if _wave_info(full_channel) != (1, SAMPLE_RATE, total_frames):
                raise RuntimeError("降噪开头预热音轨帧数异常，未替换原视频")
            clean_channels.append(full_channel)

        cleaned_audio = work / "cleaned.wav"
        if actual_channels == 1:
            shutil.copy2(clean_channels[0], cleaned_audio)
        else:
            _run(
                [
                    str(ffmpeg), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", str(clean_channels[0]), "-i", str(clean_channels[1]),
                    "-filter_complex", "[0:a][1:a]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[out]",
                    "-map", "[out]", "-c:a", "pcm_s16le", str(cleaned_audio),
                ], cancel=cancel,
            )
        if _wave_info(cleaned_audio) != (actual_channels, SAMPLE_RATE, total_frames):
            raise RuntimeError("降噪音轨与原音轨帧数不一致，未替换原视频")

        # Preserve the original only while DeepFilterNet settles, then fade to
        # the processed track. A whole-track dry/wet mix can sound hollow.
        opening_frames = min(total_frames, OPENING_PASSTHROUGH_FRAMES)
        blend_frames = min(OPENING_BLEND_FRAMES, total_frames - opening_frames)
        if blend_frames > 0:
            protected_audio = work / "protected-cleaned.wav"
            opening_start = opening_frames / SAMPLE_RATE
            blend_duration = blend_frames / SAMPLE_RATE
            opening_filter = (
                f"[0:a]afade=t=out:st={opening_start:.6f}:d={blend_duration:.6f}[original];"
                f"[1:a]afade=t=in:st={opening_start:.6f}:d={blend_duration:.6f}[denoised];"
                f"[original][denoised]amix=inputs=2:duration=longest:normalize=0,"
                f"apad,atrim=end_sample={total_frames},asetpts=PTS-STARTPTS[out]"
            )
            _run(
                [
                    str(ffmpeg), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", str(normalized), "-i", str(cleaned_audio),
                    "-filter_complex", opening_filter, "-map", "[out]",
                    "-c:a", "pcm_s16le", str(protected_audio),
                ], cancel=cancel,
            )
            if _wave_info(protected_audio) != (actual_channels, SAMPLE_RATE, total_frames):
                raise RuntimeError("降噪开头保护音轨帧数异常，未替换原视频")
            os.replace(protected_audio, cleaned_audio)
        elif opening_frames == total_frames:
            # Very short clips may contain only the first spoken word.
            shutil.copy2(normalized, cleaned_audio)

        staged = work / f"final{final_suffix}"
        audio_codec = "libopus" if final_suffix == ".webm" else "aac"
        # Keep the original video stream, timestamps and frame sequence intact.
        # The denoised WAV has no timestamps, so restore the source audio/video
        # start-time delta explicitly before muxing it back.
        audio_offset = audio_start - video_start
        mux = [
            str(ffmpeg), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-copyts", "-start_at_zero", "-i", str(video),
            "-itsoffset", f"{audio_offset:.9f}", "-i", str(cleaned_audio),
            "-map", f"0:{video_stream_index}", "-map", "1:a:0", "-map_metadata", "0",
            "-c:v", "copy", "-c:a", audio_codec, "-b:a", str(output_audio_bitrate),
            "-ar", str(mux_sample_rate), "-ac", str(mux_channels),
        ]
        if final_suffix in {".mp4", ".m4v", ".mov"}:
            mux.extend(["-movflags", "+faststart"])
        mux.append(str(staged))
        _run(mux, cancel=cancel)
        if not staged.is_file() or staged.stat().st_size < 1024:
            raise RuntimeError("降噪成片校验失败，未替换原视频")
        output_channels, output_audio_duration, output_audio_start, output_video_start, output_video_duration, _, _ = _probe_media(staged, ffprobe, cancel)
        if output_channels != mux_channels or abs(output_audio_duration - duration) > max(frame_tolerance, 0.05):
            raise RuntimeError("成片音轨帧数或时长与原素材不一致，未替换原视频")
        if abs((output_audio_start - output_video_start) - audio_offset) > max(frame_tolerance, 0.02):
            raise RuntimeError("成片音画起始时间未对齐，未替换原视频")
        if abs(output_video_duration - video_duration) > max(frame_tolerance, 0.05):
            raise RuntimeError("成片画面时长发生变化，未替换原视频")
        if progress:
            progress("视频与降噪音轨合并中")

        if final_path != video and final_path.exists():
            raise RuntimeError(f"输出文件已存在：{final_path.name}")
        if cancel and cancel.is_set():
            raise RuntimeError("任务已取消")
        os.replace(staged, final_path)
        if final_path != video:
            video.unlink()
        return final_path
    finally:
        shutil.rmtree(work, ignore_errors=True)

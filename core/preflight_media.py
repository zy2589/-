"""Small media and title-image smoke check run before packaging."""
import json
import hashlib
import queue
import shutil
import subprocess
import sys
import threading
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image, ImageStat

ROOT = Path(__file__).resolve().parents[1]
RESOURCE_DIR = ROOT / "resources"
FFMPEG = RESOURCE_DIR / "ffmpeg" / "ffmpeg.exe"
FFPROBE = RESOURCE_DIR / "ffmpeg" / "ffprobe.exe"
sys.path.insert(0, str(ROOT / "core" / "downloader_runtime"))
sys.path.insert(0, str(ROOT))

from compress_video import transcode_mp4
from core.denoise import denoise_video
from app import App, group_download_jobs, media_name, task_pairs, try_publish_title_png


def run(args):
    subprocess.run([str(arg) for arg in args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def probe(path):
    result = subprocess.run(
        [str(FFPROBE), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def main():
    with tempfile.TemporaryDirectory(prefix="clipassistant-preflight-") as temp:
        root = Path(temp)
        moving = root / "moving.mp4"
        cover = root / "cover.jpg"
        attached = root / "source-with-cover.mp4"
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
             "testsrc2=size=320x568:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
             "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-shortest", moving])
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
             "color=c=red:size=320x568", "-frames:v", "1", "-q:v", "2", cover])
        # Put a still cover before the real moving picture in the input map.
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", cover, "-i", moving,
             "-map", "0:v:0", "-map", "1:v:0", "-map", "1:a:0", "-c", "copy",
             "-disposition:v:0", "attached_pic", "-disposition:v:1", "default", attached])
        input_streams = probe(attached)["streams"]
        video_streams = [stream for stream in input_streams if stream.get("codec_type") == "video"]
        if not any(str(stream.get("disposition", {}).get("attached_pic", 0)) == "1" for stream in video_streams):
            raise RuntimeError("媒体预检无法生成封面图与活动画面并存的样本。")

        encoded = transcode_mp4(attached, resource_dir=RESOURCE_DIR, compress=True, remove_source=False)
        denoised = denoise_video(encoded, strength_percent=5, resource_dir=RESOURCE_DIR,
                                 output_audio_bitrate="128k", output_sample_rate=44100, output_channels=2)
        output = probe(denoised)
        moving_video = [stream for stream in output["streams"]
                        if stream.get("codec_type") == "video" and not stream.get("disposition", {}).get("attached_pic")]
        audio = [stream for stream in output["streams"] if stream.get("codec_type") == "audio"]
        if not moving_video or not audio:
            raise RuntimeError("压缩和降噪预检失败：输出文件缺少活动画面或声音。")
        frame = root / "frame.jpg"
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", denoised,
             "-frames:v", "1", "-q:v", "2", frame])
        if sum(ImageStat.Stat(Image.open(frame).convert("RGB")).stddev) < 20:
            raise RuntimeError("压缩和降噪预检失败：输出只有静态封面，没有原视频画面。")

        rows = [(f"人名{i}", "测试引流标题", "") for i in range(1, 6)]
        tasks = task_pairs(str(root), rows)
        standalone_folders = [Path(task[2]) for task in tasks]
        if (len(tasks) != 5 or len(set(standalone_folders)) != 5 or
                any(folder.parent != root for folder in standalone_folders)):
            raise RuntimeError("标题图预检失败：独立行没有各自建立人名-视频名称文件夹。")
        design = {
            "footer": "Message us on Whats/App at\n+1 (917) 445-9585\nto join our FREE online Bible study.",
            "lines": [{"size": 52, "bold": True, "runs": [{"text": "", "color": "#000000"}]}],
            "top": 850, "theme": "白天", "layout": "自动", "background": "#ffffff", "radius": 22, "padding": 16,
        }
        start = datetime.now()
        for index, folder in enumerate(standalone_folders):
            folder.mkdir(parents=True, exist_ok=True)
            output_path = folder / (media_name(f"人名{index + 1}", "测试引流标题", start + timedelta(microseconds=index)) + ".png")
            error = try_publish_title_png(design, "测试引流标题", output_path, "1080x1920", root)
            if error or not output_path.is_file() or output_path.stat().st_size < 128:
                raise RuntimeError(f"第 {index + 1} 行标题 PNG 预检失败：{error or output_path}")
            if len(list(folder.glob("*.png"))) != 1:
                raise RuntimeError(f"第 {index + 1} 行标题图没有保存在人名-视频名称文件夹中。")

        # Reproduce the requested case: one shared video URL and title, with
        # different people. Download/transcode once, then publish to every row.
        linked_root = root / "linked-rows"
        linked_root.mkdir()
        shared_url = "https://example.com/preflight-shared-video"
        people = ["甲人", "乙人", "丙人", "丁人", "戊人"]
        linked_rows = [(person, "同名视频", shared_url) for person in people]
        linked_tasks = task_pairs(str(linked_root), linked_rows)
        if len(linked_tasks) != len(people):
            raise RuntimeError("相同链接预检失败：行任务数量不正确。")
        folders = [Path(task[2]) for task in linked_tasks]
        if len(set(folders)) != len(people):
            raise RuntimeError("相同视频名、不同人名预检失败：输出目录发生碰撞。")

        worker = App.__new__(App)
        worker.resource_dir = RESOURCE_DIR
        worker.jobs = {}
        worker.events = queue.Queue()

        def fake_download(_key, _url, _cancel, settings):
            download_folder = Path(settings[3])
            download_folder.mkdir(parents=True, exist_ok=True)
            shutil.copy2(moving, download_folder / moving.name)

        worker._download = fake_download
        group = []
        for index, (name, url, folder) in enumerate(linked_tasks):
            key = f"preflight-row-{index}"
            folder.mkdir(parents=True, exist_ok=True)
            worker.jobs[key] = {
                "row": index, "name": name, "url": url, "path": folder,
                "state": "排队中", "denoise_failed_files": [], "compression_failed_files": [],
            }
            group.append((key, url, threading.Event(), (folder, "best", "", False, 0, [], [])))
            title_path = folder / (media_name(name.split("-", 1)[0], "同名视频", start + timedelta(seconds=index)) + ".png")
            error = try_publish_title_png(design, "同名视频", title_path, "1080x1920", root)
            if error or not title_path.is_file():
                raise RuntimeError(f"相同视频名、不同人名预检失败：第 {index + 1} 行标题图未生成：{error}")

        download_groups, standalone = group_download_jobs(group)
        if standalone or len(download_groups) != 1 or len(download_groups[0]) != len(people):
            raise RuntimeError("相同链接预检失败：下载分组没有保留全部人名行。")
        if not worker._download_group(download_groups[0]):
            raise RuntimeError("相同链接预检失败：共享视频处理任务未完成。")
        terminal = {}
        while not worker.events.empty():
            key, state, detail = worker.events.get_nowait()
            if key in worker.jobs and state in ("完成", "失败", "已取消", "降噪失败（视频已保留）", "转码失败（源视频已保留）"):
                terminal[key] = (state, detail)
        for index, folder in enumerate(folders):
            key = f"preflight-row-{index}"
            videos = list(folder.glob("*.mp4"))
            images = list(folder.glob("*.png"))
            if len(videos) != 1 or len(images) != 1:
                raise RuntimeError(f"相同视频名、不同人名预检失败：{people[index]} 的视频或标题图缺失。")
            if terminal.get(key, ("", ""))[0] != "完成":
                raise RuntimeError(f"相同链接预检失败：{people[index]} 没有成功完成任务：{terminal.get(key)}")
        video_hashes = {
            hashlib.sha256(next(folder.glob("*.mp4")).read_bytes()).hexdigest()
            for folder in folders
        }
        if len(video_hashes) != 1:
            raise RuntimeError("相同链接预检失败：不同人名行没有收到同一份处理后视频。")

    print("MEDIA PREFLIGHT PASSED: audio/video preserved; standalone titles in per-row folders; one shared link produced 5 independent person folders with identical video + title.")


if __name__ == "__main__":
    main()

"""Small media and title-image smoke check run before packaging."""
import json
import hashlib
import queue
import shutil
import subprocess
import sys
import threading
import tempfile
from types import SimpleNamespace
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image, ImageStat

ROOT = Path(__file__).resolve().parents[1]
RESOURCE_DIR = ROOT / "resources"
FFMPEG = RESOURCE_DIR / "ffmpeg" / "ffmpeg.exe"
FFPROBE = RESOURCE_DIR / "ffmpeg" / "ffprobe.exe"
sys.path.insert(0, str(ROOT / "core" / "downloader_runtime"))
sys.path.insert(0, str(ROOT))

from core.denoise import denoise_video
from app import (App, clipboard_field_rows, clipboard_link_groups, clipboard_matrix,
                 _sheets_clipboard_json_fragment, group_download_jobs, media_name,
                 plan_link_fill, task_pairs, task_rows,
                 strip_title_hashtags, try_publish_title_png)
from local_design import normalize_manual_title_lines, replace_title, salient_title_spans
from page_cache import extract_phone_input, format_phone_like


def run(args):
    subprocess.run([str(arg) for arg in args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def probe(path):
    result = subprocess.run(
        [str(FFPROBE), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=True, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return json.loads(result.stdout)


def main():
    hashtag_titles = (
        ('3 Signs a Preacher May Be Using Your Faith for Money #Pastor #Church #Bible #Discernment #Truth',
         '3 Signs a Preacher May Be Using Your Faith for Money'),
        ('When You Have No One Else, God Is Still With You! #ChristianUSA #ChristianCanada #GodIsWithYou #TrustGod #FaithOverFear',
         'When You Have No One Else, God Is Still With You!'),
        ('2 Types of Christians Who May Miss the Bridegroom’s Coming! #ChristianUSA #ChristianCanada #JesusIsComing #WiseVirgins #HearGodsVoice',
         '2 Types of Christians Who May Miss the Bridegroom’s Coming!'),
        ('Want to Grow Closer to God? Start These 6 Daily Habits! #ChristianUSA #ChristianCanada #DrawCloserToGod #DailyPrayer #SpiritualGrowth',
         'Want to Grow Closer to God? Start These 6 Daily Habits!'),
    )
    for source_title, expected_title in hashtag_titles:
        if strip_title_hashtags(source_title) != expected_title:
            raise RuntimeError('标题清理预检失败：# 后面的标签没有全部移除，或标题正文被误删。')

    folder_link = "https://drive.google.com/drive/folders/test-folder-id"
    video_link = "https://drive.google.com/file/d/test-video-id/view"
    rich_cell = (f'<table><tr><td><a href="{folder_link}">文件夹链接</a><br>'
                 f'<a href="{video_link}">IMG_1405.MOV</a></td></tr></table>')
    rich_groups = clipboard_link_groups(rich_cell)
    if rich_groups != [[folder_link, video_link]]:
        raise RuntimeError("Google 表格剪贴板预检失败：同一单元格中的两个真实超链接没有一起识别。")
    sheets_rich_cell = (f'<table><tr><td><a class="in-cell-link" href="{folder_link}">文件夹</a>'
                        f'<br><a class="in-cell-link" href="{video_link}">测试视频12.mp4</a>'
                        '</td></tr></table>')
    if clipboard_link_groups(sheets_rich_cell) != [[folder_link, video_link]]:
        raise RuntimeError('Google 表格富文本预检失败：单元格内链接卡片的 href 没有保留。')
    sheets_private_data = json.dumps({
        'cell': {'text': '测试视频12.mp4',
                 'links': [{'uri': folder_link}, {'uri': video_link}]}
    }).encode('utf-8')
    private_fragment = _sheets_clipboard_json_fragment(sheets_private_data)
    if clipboard_link_groups(private_fragment) != [[folder_link, video_link]]:
        raise RuntimeError('Google 表格专用剪贴板格式预检失败：双链接没有保留在同一行。')
    bulk_plan = plan_link_fill(f'{folder_link} | {video_link}', ["", ""])
    if bulk_plan != [(0, f'{folder_link} | {video_link}')]:
        raise RuntimeError("双链接粘贴预检失败：一个单元格的链接被拆到了两行。")
    copied_rows = clipboard_matrix(
        "演员\\t需求备注\\t文案标题\\t拍摄视频链接",
        '<table><tr><td>演员</td><td>需求备注</td><td>文案标题</td><td>拍摄视频链接</td></tr>'
        f'<tr><td>演员甲</td><td>电话：+12025550147</td><td>测试文案</td>'
        f'<td><a href="{folder_link}">文件夹</a><br><a href="{video_link}">IMG_1405.MOV</a></td></tr></table>')
    mapped_rows = clipboard_field_rows(copied_rows)
    if (len(mapped_rows) != 1 or mapped_rows[0].get('name') != '演员甲' or
            mapped_rows[0].get('phone') != '电话：+12025550147' or
            mapped_rows[0].get('title') != '测试文案' or
            mapped_rows[0].get('link') != f'{folder_link} | {video_link}'):
        raise RuntimeError("带表头的表格批量粘贴预检失败：人名、号码、文案或真实链接映射错误。")

    class ClipboardStatus:
        text = ''

        def config(self, **_kwargs):
            self.text = _kwargs.get('text', self.text)

    class PasteVariable:
        def __init__(self, value=''):
            self.value = value

        def get(self):
            return self.value

        def set(self, value):
            self.value = value

    clipboard_app = App.__new__(App)
    clipboard_app.active = False
    clipboard_app.rows = [(PasteVariable(), PasteVariable(), PasteVariable())
                          for _ in range(12)]
    clipboard_app.phone_vars = [PasteVariable() for _ in range(12)]
    clipboard_app.status = ClipboardStatus()
    clipboard_app.format_phone_cell = lambda index: clipboard_app.phone_vars[index].set(
        format_phone_like('+1(202)555-0123', clipboard_app.phone_vars[index].get()))
    paste_event = SimpleNamespace(widget=object())
    clipboard_app._paste_matrix = lambda _widget: [
        [{'text': '演员甲', 'links': []}], [{'text': '演员乙', 'links': []}]]
    if App.paste_column_values(clipboard_app, paste_event, 0, 'name') != 'break':
        raise RuntimeError("单列批量粘贴预检失败：演员列未进入向下填充路径。")
    if [clipboard_app.rows[i][0].get() for i in range(2)] != ['演员甲', '演员乙']:
        raise RuntimeError("单列批量粘贴预检失败：演员没有按行填入。")
    clipboard_app._paste_matrix = lambda _widget: copied_rows
    if App.paste_column_values(clipboard_app, paste_event, 0, 'name') != 'break':
        raise RuntimeError("表头批量粘贴预检失败：多列区域没有进入映射导入路径。")
    if (clipboard_app.rows[0][0].get() != '演员甲' or
            clipboard_app.phone_vars[0].get() != '+1(202)555-0147' or
            clipboard_app.rows[0][1].get() != '测试文案' or
            clipboard_app.rows[0][2].get() != f'{folder_link} | {video_link}'):
        raise RuntimeError("批量粘贴应用预检失败：字段没有应用到下载表行。")
    clipboard_app._paste_matrix = lambda _widget: [
        [{'text': '文件夹\\nIMG_1405.MOV', 'links': [folder_link, video_link]}]]
    if App.paste_column_values(clipboard_app, paste_event, 0, 'link') != 'break':
        raise RuntimeError("单格双链接粘贴预检失败：链接列没有应用到当前行。")
    if clipboard_app.rows[0][2].get() != f'{folder_link} | {video_link}':
        raise RuntimeError("单格双链接粘贴预检失败：两个链接没有留在同一行。")
    clipboard_app._paste_matrix = lambda _widget: [
        [{'text': '测试视频12.mp4', 'links': []}]]
    if App.paste_column_values(clipboard_app, paste_event, 0, 'link') != 'break':
        raise RuntimeError('文件名误粘贴预检失败：只有显示名称时没有拦截并提示。')
    if '只有文件名' not in clipboard_app.status.text:
        raise RuntimeError('文件名误粘贴预检失败：没有明确告知需要复制真实链接。')
    clipboard_app._paste_matrix = lambda _widget: [
        [{'text': source_title, 'links': []}] for source_title, _ in hashtag_titles]
    if App.paste_column_values(clipboard_app, paste_event, 0, 'title') != 'break':
        raise RuntimeError('标题列清理预检失败：带标签的标题没有进入清理粘贴路径。')
    if [clipboard_app.rows[index][1].get() for index in range(len(hashtag_titles))] != [
            expected for _, expected in hashtag_titles]:
        raise RuntimeError('标题列清理预检失败：批量粘贴后仍含有 # 标签。')
    clipboard_app._paste_matrix = lambda _widget: [
        [{'text': '演员', 'links': []}, {'text': '标题', 'links': []}],
        [{'text': '演员甲', 'links': []}, {'text': hashtag_titles[1][0], 'links': []}],
    ]
    if App.paste_column_values(clipboard_app, paste_event, 4, 'name') != 'break':
        raise RuntimeError('表头标题清理预检失败：多列表格标题没有进入映射粘贴路径。')
    if clipboard_app.rows[4][1].get() != hashtag_titles[1][1]:
        raise RuntimeError('表头标题清理预检失败：视频名称列仍含有 # 标签。')

    phone_us = '合拍視頻\\\n電話：+12025550147'
    phone_nz = '1.25倍+ IG輪播圖合拍  \\\n電話： ＋64 27 000 0000'
    if format_phone_like('+1(202)555-0123', phone_us) != '+1(202)555-0147':
        raise RuntimeError('号码清洗预检失败：说明文字未剔除，或压缩输入没有保留美国号码格式。')
    if format_phone_like('+64 21 000 0000', phone_nz) != '+64 27 000 0000':
        raise RuntimeError('号码清洗预检失败：全角加号、倍速/推广文字或新西兰号码分组处理异常。')
    if extract_phone_input('1.25倍+ IG輪播圖合拍'):
        raise RuntimeError('号码清洗预检失败：没有电话号码时不能把标题/倍速数字保留为号码。')
    class PhoneVariable:
        def __init__(self, value):self.value=value
        def get(self):return self.value
        def set(self, value):self.value=value
    phone_cell = SimpleNamespace(phone_vars=[PhoneVariable(phone_us)], auto_phone_values=['+1(202)555-0123'])
    App.format_phone_cell(phone_cell, 0)
    if phone_cell.phone_vars[0].get() != '+1(202)555-0147':
        raise RuntimeError('号码清洗预检失败：输入框失焦后没有自动提取并格式化电话号码。')
    phone_submit = SimpleNamespace(phone_vars=[PhoneVariable(phone_nz)], auto_phone_values=['+64 21 000 0000'])
    if App.supplied_phone(phone_submit, 0) != '+64 27 000 0000' or phone_submit.phone_vars[0].get() != '+64 27 000 0000':
        raise RuntimeError('号码清洗预检失败：直接开始下载时没有先清洗并应用电话号码。')

    # Automatic title emphasis is intentionally limited to the three requested
    # terms; all other words remain available for manual selection/coloring.
    for title in (
        "3 Dangerous Steps That Can Lead",
        "If You Keep Falling Into Sin, Watch",
        "How to Build Better Habits Every Morning",
        "Lordian Return and Christian Habits",
    ):
        if salient_title_spans(title):
            raise RuntimeError(f"标题自动高亮超出指定词：{title!r}。")
    required_title = "GOD loves JESUS and the LORD and the Holy Spirit"
    required_spans = [required_title[start:end].casefold() for start, end in salient_title_spans(required_title)]
    if required_spans != ["god", "jesus", "lord", "holy spirit"]:
        raise RuntimeError("标题自动高亮预检失败：GOD、JESUS、LORD、Holy Spirit 识别不完整。")
    possessive_title = "gOd's love, jEsUs' words, the LORD's return, and HOLY SPIRIT's guidance"
    possessive_spans = [possessive_title[start:end].casefold() for start, end in salient_title_spans(possessive_title)]
    if possessive_spans != ["god's", "jesus'", "lord's", "holy spirit's"]:
        raise RuntimeError("标题自动高亮预检失败：大小写和所有格处理异常。")
    near_match_title = "Goddess, Jesusian, Holy Spiritual"
    if salient_title_spans(near_match_title):
        raise RuntimeError("标题自动高亮预检失败：匹配到了非完整词。")
    manual_title = "5 things to pray every morning — before you touch your phone. And watch how your day shifts"
    manual_lines = normalize_manual_title_lines(manual_title, [
        "5 things to pray every morning —", "before you touch your phone. And watch", "how your day shifts",
    ])
    manual_design = replace_title({
        "lines": [{"size": 52, "bold": True, "runs": []}],
        "manual_title_lines": manual_lines,
    }, manual_title)
    if ["".join(run["text"] for run in line["runs"]) for line in manual_design["lines"]] != manual_lines:
        raise RuntimeError("标题手动分行预检失败：预览与导出行内容不一致。")
    try:
        normalize_manual_title_lines(manual_title, ["5 things to pray", "this text was changed"])
    except ValueError:
        pass
    else:
        raise RuntimeError("标题手动分行预检失败：错误改写文字没有被拦截。")

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

        denoised = denoise_video(attached, strength_percent=5, resource_dir=RESOURCE_DIR,
                                 output_audio_bitrate="128k", output_sample_rate=44100, output_channels=2)
        output = probe(denoised)
        moving_video = [stream for stream in output["streams"]
                        if stream.get("codec_type") == "video" and not stream.get("disposition", {}).get("attached_pic")]
        audio = [stream for stream in output["streams"] if stream.get("codec_type") == "audio"]
        if not moving_video or not audio:
            raise RuntimeError("直降噪预检失败：输出文件缺少活动画面或声音。")
        frame = root / "frame.jpg"
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", denoised,
             "-frames:v", "1", "-q:v", "2", frame])
        if sum(ImageStat.Stat(Image.open(frame).convert("RGB")).stddev) < 20:
            raise RuntimeError("直降噪预检失败：输出只有静态封面，没有原视频画面。")

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

        long_title_folder = root / "long-title-path"
        long_title_folder.mkdir()
        long_title_stem = media_name("第1行", manual_title, start)
        long_title_output = long_title_folder / f"{long_title_stem}.png"
        if len(long_title_output.name) > 80:
            raise RuntimeError("长标题 PNG 文件名预检失败：输出名称仍过长。")
        error = try_publish_title_png(
            {"footer": "", "lines": [{"runs": [], "size": 52, "bold": True}], "top": 850},
            manual_title, long_title_output, "1080x1920", root,
        )
        if error or not long_title_output.is_file():
            raise RuntimeError(f"长标题 PNG 文件名预检失败：{error or long_title_output}")

        # Reproduce the requested case: one shared video URL and title, with
        # different people. Download once without transcoding, then publish to every row.
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
                "state": "排队中", "denoise_failed_files": [],
            }
            group.append((key, url, threading.Event(), (folder, "best", "", False, 0, [])))
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
            raise RuntimeError("相同链接预检失败：不同人名行没有收到同一份原始视频。")
        if next(folder.glob("*.mp4")).read_bytes() != moving.read_bytes():
            raise RuntimeError("下载预检失败：未启用降噪时，保存的视频与下载原件不一致。")

        multi_root = root / "multi-link-row"
        multi_root.mkdir()
        multi_specs = task_rows(str(multi_root), [
            ("双视频演员", "同一文案", f"{folder_link} | {video_link}")])
        if (len(multi_specs) != 2 or {task[0] for task in multi_specs} != {0} or
                {task[1] for task in multi_specs} != {"双视频演员-同一文案"} or
                len({task[3] for task in multi_specs}) != 1 or
                [(task[4], task[5]) for task in multi_specs] != [(1, 2), (2, 2)]):
            raise RuntimeError("双链接任务预检失败：链接必须仍属于同一演员、同一文案和同一下载行。")

        multi_worker = App.__new__(App)
        multi_worker.resource_dir = RESOURCE_DIR
        multi_worker.jobs = {}
        multi_worker.events = queue.Queue()

        def fake_same_name_download(_key, _url, _cancel, settings):
            download_folder = Path(settings[3])
            download_folder.mkdir(parents=True, exist_ok=True)
            shutil.copy2(moving, download_folder / "same-name.mp4")

        multi_worker._download = fake_same_name_download
        multi_batch = []
        for index, (row, name, url, folder, link_index, link_count) in enumerate(multi_specs):
            key = f"preflight-multi-{index}"
            folder.mkdir(parents=True, exist_ok=True)
            multi_worker.jobs[key] = {
                "row": row, "name": name, "url": url, "path": folder,
                "link_index": link_index, "link_count": link_count,
                "state": "排队中", "denoise_failed_files": [],
            }
            multi_batch.append((key, url, threading.Event(), (folder, "best", "", False, 0, [])))
        multi_groups, multi_standalone = group_download_jobs(multi_batch)
        if multi_standalone or len(multi_groups) != 2:
            raise RuntimeError("双链接任务预检失败：两个不同链接没有分别下载。")
        for group in multi_groups:
            if not multi_worker._download_group(group):
                raise RuntimeError("双链接任务预检失败：某个链接处理没有完成。")
        saved_videos = sorted(multi_specs[0][3].glob("*.mp4"))
        if ([item.name for item in saved_videos] != ["视频1-same-name.mp4", "视频2-same-name.mp4"] or
                any(item.read_bytes() != moving.read_bytes() for item in saved_videos)):
            raise RuntimeError("双链接任务预检失败：同名视频未分别保存，或有视频被覆盖。")

        visible_root = root / "visible-download"
        visible_root.mkdir()
        visible_folder = visible_root / "双链接演员-处理中"
        visible_folder.mkdir()
        visible_worker = App.__new__(App)
        visible_worker.resource_dir = RESOURCE_DIR
        visible_worker.jobs = {
            "visible-link-2": {
                "row": 0, "name": "双链接演员-处理中", "url": video_link,
                "path": visible_folder, "link_index": 2, "link_count": 2,
                "state": "排队中", "denoise_failed_files": [],
            }
        }
        visible_worker.events = queue.Queue()

        def fake_visible_download(_key, _url, _cancel, settings):
            markers = settings[7]
            if len(markers) != 1 or not next(iter(markers.values())).is_file():
                raise RuntimeError("可见下载预检失败：下载开始前目标文件夹没有对应链接状态文件。")
            if "准备下载" not in next(iter(markers.values())).read_text(encoding="utf-8"):
                raise RuntimeError("可见下载预检失败：初始状态文件内容不正确。")
            download_folder = Path(settings[3])
            download_folder.mkdir(parents=True, exist_ok=True)
            shutil.copy2(moving, download_folder / "visible-video.mp4")

        visible_worker._download = fake_visible_download
        marker = visible_folder / "视频2-下载处理中.txt"
        visible_batch = [(
            "visible-link-2", video_link, threading.Event(),
            (visible_folder, "best", "", False, 5, []),
        )]
        from core import denoise as denoise_module
        original_denoise_video = denoise_module.denoise_video

        def fake_denoise_visible(video, **_kwargs):
            visible_videos = list(visible_folder.glob("*.mp4"))
            if len(visible_videos) != 1 or visible_videos[0].read_bytes() != moving.read_bytes():
                raise RuntimeError("可见下载预检失败：降噪过程中目标文件夹没有可见的原视频。")
            if not marker.is_file() or "降噪中" not in marker.read_text(encoding="utf-8"):
                raise RuntimeError("可见下载预检失败：降噪期间状态文件未更新。")
            return Path(video)

        denoise_module.denoise_video = fake_denoise_visible
        try:
            if not visible_worker._download_group(visible_batch):
                raise RuntimeError("可见下载预检失败：处理任务未完成。")
        finally:
            denoise_module.denoise_video = original_denoise_video
        visible_outputs = list(visible_folder.glob("*.mp4"))
        if (len(visible_outputs) != 1 or visible_outputs[0].name != "视频2-visible-video.mp4" or
                visible_outputs[0].read_bytes() != moving.read_bytes() or marker.exists()):
            raise RuntimeError("可见下载预检失败：结束后未留下成品视频，或临时状态文件没有清理。")

    print("MEDIA PREFLIGHT PASSED: rich spreadsheet links and header mapping work; two links in one row download to one folder; source videos and per-link status are visible during denoising; status files are removed after publishing; no-denoise videos remain byte-identical; one shared link produced 5 independent person folders.")


if __name__ == "__main__":
    main()

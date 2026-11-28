"""Interactive foreground extraction UI and alpha-video export helpers."""
import json
import math
import os
import queue
import shutil
import subprocess
import sys
import threading
import tempfile
import time
import tkinter as tk
from collections import OrderedDict
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageTk
from tkinterdnd2 import DND_FILES
from .downloader_runtime.desktop_ui import PALETTES, bind_scale_wheel, native_caption


MAX_PREVIEW_MASKS = 1200
PREVIEW_MASK_SIZE = (128, 128)
ALPHA_EDGE_GAMMA = 1.15
REPAIRED_ALPHA_MIN_FILTER = 41
REPAIRED_ALPHA_CUTOFF = 0.30


def _min_filter_axis_u8(values, size, axis):
    """Apply a replicated-edge 1D minimum filter using block minima."""
    radius = size // 2
    pads = [(0, 0)] * values.ndim
    pads[axis] = (radius, radius)
    padded = np.pad(values, pads, mode='edge')
    moved = np.moveaxis(padded, axis, -1)
    output_length = values.shape[axis]
    extra = (-moved.shape[-1]) % size
    if extra:
        moved = np.pad(moved, [(0, 0)] * (moved.ndim - 1) + [(0, extra)], mode='edge')

    blocks = moved.reshape(*moved.shape[:-1], -1, size)
    prefix = np.minimum.accumulate(blocks, axis=-1).reshape(*moved.shape[:-1], -1)
    suffix = np.minimum.accumulate(blocks[..., ::-1], axis=-1)[..., ::-1].reshape(
        *moved.shape[:-1], -1)
    filtered = np.minimum(suffix[..., :output_length],
                          prefix[..., size - 1:size - 1 + output_length])
    return np.moveaxis(filtered, -1, axis)


def _min_filter_square_u8(values, size):
    """Apply a square minimum filter in linear time, separably by axis."""
    return _min_filter_axis_u8(_min_filter_axis_u8(values, size, 1), size, 0)


def _tighten_alpha_edges(alpha, *, repair_alpha=False):
    """Reduce low-opacity fringe while keeping solid subject pixels unchanged."""
    np.clip(alpha, 0.0, 1.0, out=alpha)
    if repair_alpha:
        # Existing transparent clips often contain a broad, contaminated edge.
        # A modest matte erosion removes the contaminated outer fringe while
        # leaving the solid interior untouched.
        alpha_u8 = np.asarray(np.rint(alpha * 255.0), dtype=np.uint8)
        alpha_u8 = _min_filter_square_u8(alpha_u8, REPAIRED_ALPHA_MIN_FILTER)
        alpha[:] = np.asarray(alpha_u8, dtype=np.float32) / 255.0
        np.subtract(alpha, REPAIRED_ALPHA_CUTOFF, out=alpha)
        alpha /= 1.0 - REPAIRED_ALPHA_CUTOFF
        np.clip(alpha, 0.0, 1.0, out=alpha)
    np.power(alpha, ALPHA_EDGE_GAMMA, out=alpha)
    return alpha


def _run_silent(*args, **kwargs):
    kwargs.setdefault('creationflags', getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return subprocess.run(*args, **kwargs)


def _run_preview_command(command, cancel_event, *, timeout, capture_output=True,
                         check=True, text=False, encoding=None, errors=None):
    """Run preview FFmpeg tools in a cancellable, windowless child process."""
    process = _popen_silent(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture_output else subprocess.DEVNULL,
        stderr=subprocess.PIPE if capture_output else subprocess.DEVNULL,
        text=text,
        encoding=encoding,
        errors=errors,
    )
    deadline = time.monotonic() + timeout
    while True:
        try:
            stdout, stderr = process.communicate(timeout=min(0.2, max(0.01, deadline - time.monotonic())))
            break
        except subprocess.TimeoutExpired:
            if cancel_event.is_set():
                try:
                    process.terminate()
                except OSError:
                    pass
                try:
                    process.communicate(timeout=1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                raise InterruptedError('预览任务已取消')
            if time.monotonic() >= deadline:
                process.kill()
                stdout, stderr = process.communicate()
                raise subprocess.TimeoutExpired(command, timeout, output=stdout, stderr=stderr)
    if cancel_event.is_set():
        raise InterruptedError('预览任务已取消')
    if check and process.returncode:
        raise subprocess.CalledProcessError(process.returncode, command, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def _popen_silent(*args, **kwargs):
    kwargs.setdefault('creationflags', getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return subprocess.Popen(*args, **kwargs)


def _predict_person_probability(rgb, session):
    """Return the model's person probability on the app's normalized frame grid."""
    input_info = session.get_inputs()[0]
    output_info = session.get_outputs()[0]
    shape = input_info.shape
    person_h = int(shape[-2]) if isinstance(shape[-2], int) else 192
    person_w = int(shape[-1]) if isinstance(shape[-1], int) else 192
    # Do not squash portrait/landscape footage into the square model input.
    # Letterbox for inference, then map the probability back onto the app's
    # normalized frame grid so brush tracking keeps using the same coordinates.
    frame_h, frame_w = rgb.shape[:2]
    scale = min(person_w / frame_w, person_h / frame_h)
    resized_w = max(1, round(frame_w * scale))
    resized_h = max(1, round(frame_h * scale))
    pad_x = (person_w - resized_w) // 2
    pad_y = (person_h - resized_h) // 2
    resized = Image.fromarray(rgb).resize((resized_w, resized_h), Image.Resampling.BILINEAR)
    # SegFormer-B0 portrait model expects BGR normalized with its training-set
    # mean/std. Padding with the mean makes letterbox pixels exactly zero after
    # normalization and keeps portrait subjects from being horizontally warped.
    if input_info.name == 'image':
        model_mean = np.array([143.55267075, 132.96705975, 126.94924335], dtype=np.float32)
        model_std = np.array([60.2625333, 60.32740275, 59.30988645], dtype=np.float32)
        # Pixels are RGB here and converted to BGR below. Reverse the mean
        # before filling the letterbox so padding normalizes to zero.
        pad_color = tuple(int(x) for x in model_mean[::-1])
    else:
        # Compatibility with the previous PP-HumanSeg ONNX model.
        model_mean = np.array([127.5, 127.5, 127.5], dtype=np.float32)
        model_std = np.array([127.5, 127.5, 127.5], dtype=np.float32)
        pad_color = (0, 0, 0)
    canvas = Image.new('RGB', (person_w, person_h), pad_color)
    canvas.paste(resized, (pad_x, pad_y))
    model_image = canvas
    small = np.asarray(model_image, dtype=np.float32)
    person_src = ((small[:, :, ::-1] - model_mean) / model_std).transpose(2, 0, 1)[None].astype(np.float32)
    result = np.asarray(session.run([output_info.name], {input_info.name: person_src})[0])
    if result.ndim == 4 and result.shape[1] > 1:
        if result.shape[1] == 2 and input_info.name == 'image':
            logits = result.astype(np.float32, copy=False)
            logits -= np.max(logits, axis=1, keepdims=True)
            exp_logits = np.exp(logits)
            probability = (exp_logits[:, 1] / np.sum(exp_logits, axis=1))[0]
        else:
            probability = result[0, 1]
    elif result.ndim == 4:
        probability = result[0, 0]
    elif result.ndim == 3:
        probability = result[0]
    else:
        raise RuntimeError(f'人物模型输出形状异常：{result.shape}')
    if probability.min() < 0 or probability.max() > 1:
        probability = 1.0 / (1.0 + np.exp(-np.clip(probability, -30, 30)))
    probability = np.clip(probability, 0, 1).astype(np.float32, copy=False)
    # Compatible model exports may emit a lower-resolution logits grid. Bring
    # it back to input coordinates before cropping the letterbox; otherwise
    # the input-sized padding offsets shift the preview mask.
    if probability.shape != (person_h, person_w):
        probability = np.asarray(Image.fromarray(probability, mode='F').resize(
            (person_w, person_h), Image.Resampling.BILINEAR), dtype=np.float32)
    unpadded = probability[pad_y:pad_y + resized_h, pad_x:pad_x + resized_w]
    return np.asarray(Image.fromarray(unpadded, mode='F').resize(
        (person_w, person_h), Image.Resampling.BILINEAR), dtype=np.float32)


def _select_human_component(probability, target=None):
    """Pick one connected human region and return its soft probability and center."""
    threshold = 0.28 if float(np.max(probability)) >= 0.28 else 0.18
    binary = np.asarray(probability >= threshold, dtype=np.uint8)
    height, width = binary.shape
    labels = np.zeros((height, width), dtype=np.int32)
    parent = [0]

    def find(label):
        while parent[label] != label:
            parent[label] = parent[parent[label]]
            label = parent[label]
        return label

    def union(first, second):
        first, second = find(first), find(second)
        if first != second:
            parent[second] = first
        return first

    previous = []
    next_label = 0
    for y in range(height):
        row = binary[y]
        changes = np.diff(np.pad(row.astype(np.int16), (1, 1)))
        starts = np.flatnonzero(changes == 1)
        ends = np.flatnonzero(changes == -1)
        current = []
        previous_index = 0
        for start, end in zip(starts.tolist(), ends.tolist()):
            while previous_index < len(previous) and previous[previous_index][1] < start:
                previous_index += 1
            connected = []
            index = previous_index
            while index < len(previous) and previous[index][0] <= end:
                old_start, old_end, old_label = previous[index]
                if old_end >= start and old_start <= end:
                    connected.append(old_label)
                index += 1
            if connected:
                label = connected[0]
                for other in connected[1:]:
                    label = union(label, other)
            else:
                next_label += 1
                label = next_label
                parent.append(label)
            labels[y, start:end] = label
            current.append((start, end, label))
        previous = current

    if next_label == 0:
        return np.zeros_like(probability, dtype=np.float32), target
    root_map = np.zeros(next_label + 1, dtype=np.int32)
    for label in range(1, next_label + 1):
        root_map[label] = find(label)
    labels = root_map[labels]
    ys, xs = np.nonzero(labels)
    ids = labels[ys, xs]
    areas = np.bincount(ids, minlength=next_label + 1)
    max_area = int(areas.max())
    # Keep small person fragments such as hands/fingers; the click-guided
    # spatial filter below decides whether those fragments belong to the
    # selected subject instead of discarding them by area alone.
    valid_ids = np.flatnonzero(areas >= max(8, int(max_area * 0.003)))
    valid_ids = valid_ids[valid_ids != 0]
    if not len(valid_ids):
        return np.zeros_like(probability, dtype=np.float32), target
    targets = []
    if target is not None:
        targets = [target] if len(target) == 2 and isinstance(target[0], (int, float)) else list(target)
    if not targets:
        selected_id = int(valid_ids[np.argmax(areas[valid_ids])])
        primary_ids = {selected_id}
    else:
        valid_pixels = np.isin(ids, valid_ids)
        candidate_x, candidate_y, candidate_ids = xs[valid_pixels], ys[valid_pixels], ids[valid_pixels]
        selected_ids = set()
        for target_x, target_y in targets:
            tx = min(width - 1, max(0, int(round(target_x))))
            ty = min(height - 1, max(0, int(round(target_y))))
            at_target = int(labels[ty, tx])
            if at_target in valid_ids:
                selected_ids.add(at_target)
            elif len(targets) == 1 and len(candidate_x):
                nearest = int(np.argmin((candidate_x - tx) ** 2 + (candidate_y - ty) ** 2))
                selected_ids.add(int(candidate_ids[nearest]))
        if not selected_ids:
            return np.zeros_like(probability, dtype=np.float32), target
        primary_ids = set(selected_ids)
    primary = np.isin(labels, tuple(primary_ids))
    component_y, component_x = np.nonzero(primary)
    center = (float(component_x.mean()), float(component_y.mean()))
    # A hand can be disconnected from the torso by motion blur or low
    # confidence at the wrist. Keep nearby small components inside a padded
    # person box, while excluding another full-sized person in the scene.
    if len(targets) == 1 and len(component_x):
        primary_area = int(np.count_nonzero(primary))
        box_left, box_right = int(component_x.min()), int(component_x.max())
        box_top, box_bottom = int(component_y.min()), int(component_y.max())
        # Gesturing hands can be well outside the torso when the wrist is
        # briefly lost to motion blur. Use a wider lateral envelope than the
        # old torso-only padding so those detached hand/forearm components
        # remain part of the clicked subject.
        pad_x = max(12, int((box_right - box_left + 1) * 0.75))
        pad_y = max(10, int((box_bottom - box_top + 1) * 0.28))
        left, right = max(0, box_left - pad_x), min(width - 1, box_right + pad_x)
        top, bottom = max(0, box_top - pad_y), min(height - 1, box_bottom + pad_y)
        for candidate_id in valid_ids.tolist():
            if candidate_id in primary_ids or areas[candidate_id] > primary_area * 0.50:
                continue
            candidate = ids == candidate_id
            candidate_x, candidate_y = xs[candidate], ys[candidate]
            if (candidate_x.max() >= left and candidate_x.min() <= right and
                    candidate_y.max() >= top and candidate_y.min() <= bottom):
                primary_ids.add(int(candidate_id))
    selected = np.isin(labels, tuple(primary_ids))
    # Separate the confident person core from weak background pixels before
    # extending its soft boundary. This prevents a couch touching a shoulder
    # from joining the selected person while keeping a few pixels for RVM hair
    # and clothing edge refinement.
    expanded = Image.fromarray(selected.astype(np.uint8) * 255, 'L').filter(ImageFilter.MaxFilter(5))
    selected_probability = probability * (np.asarray(expanded, dtype=np.float32) / 255.0)
    return selected_probability.astype(np.float32, copy=False), center


def _seeded_background_mask(rgb, strokes, model_size, person_probability, roi):
    """Grow blue background strokes through adjacent, color-similar regions."""
    if not strokes:
        return None
    height, width = rgb.shape[:2]
    model_w, model_h = model_size
    small_rgb = np.asarray(Image.fromarray(rgb).resize((model_w, model_h), Image.Resampling.BILINEAR))
    seeds = Image.new('L', (model_w, model_h), 0)
    draw = ImageDraw.Draw(seeds)
    brush = max(3, round(max(10, min(width, height) // 100) * model_w / width))
    seed_targets = []
    for stroke in strokes:
        points = [(round(x * model_w / width), round(y * model_h / height)) for x, y in stroke]
        if not points:
            continue
        draw.line(points, fill=255, width=brush, joint='curve')
        radius = brush // 2
        for x, y in (points[0], points[-1]):
            draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=255)
    seed_y, seed_x = np.nonzero(np.asarray(seeds, dtype=np.uint8))
    if not len(seed_x):
        return None
    # A background mark is only a prompt for the surrounding scene. If the
    # person later moves underneath that same image location, don't sample the
    # new shirt/skin color as a background seed.
    if person_probability is not None and person_probability.shape == (model_h, model_w):
        keep = person_probability[seed_y, seed_x] < 0.58
        seed_y, seed_x = seed_y[keep], seed_x[keep]
        if not len(seed_x):
            left, top, right, bottom = roi
            return np.zeros((bottom - top, right - left), dtype=np.float32)
    sample_ids = np.linspace(0, len(seed_x) - 1, min(16, len(seed_x)), dtype=np.int32)
    seed_colors = small_rgb[seed_y[sample_ids], seed_x[sample_ids]].astype(np.float32)
    pixels = small_rgb.astype(np.float32)
    min_distance_sq = np.full((model_h, model_w), np.inf, dtype=np.float32)
    for color in seed_colors:
        delta = pixels - color
        np.minimum(min_distance_sq, np.sum(delta * delta, axis=2), out=min_distance_sq)
    # Connected color regions propagate the brush prompt across a sofa or wall,
    # while the human model protects pixels confidently belonging to the person.
    seed_rgb = small_rgb[seed_y, seed_x].astype(np.float32)
    color_spread = float(np.percentile(np.std(seed_rgb, axis=0), 75)) if len(seed_rgb) > 1 else 0.0
    tolerance = min(76.0, max(36.0, 34.0 + color_spread * 1.5))
    candidate = (min_distance_sq <= tolerance * tolerance).astype(np.float32)
    sample_targets = np.linspace(0, len(seed_x) - 1, min(64, len(seed_x)), dtype=np.int32)
    targets = list(zip(seed_x[sample_targets].tolist(), seed_y[sample_targets].tolist()))
    region, _ = _select_human_component(candidate, targets)
    if person_probability is not None and person_probability.shape == region.shape:
        # A blue scribble is an explicit background label: when pixels strongly
        # match the sampled seed color, let that prompt override a coarse person
        # model that may mistake a sofa touching the shoulder for clothing.
        distance = np.sqrt(min_distance_sq)
        strong_seed_match = np.clip((tolerance * 0.88 - distance) / (tolerance * 0.32), 0, 1)
        human_confidence = np.clip((person_probability - 0.30) / 0.25, 0, 1)
        # Keep the per-frame human model authoritative where it recognizes a
        # person. A background stroke must not become a stationary crop when
        # the subject moves through the marked sofa/background area.
        semantic_protection = np.clip((person_probability - 0.42) / 0.34, 0, 1)
        human_protection = np.maximum(semantic_protection,
                                      human_confidence * (1.0 - strong_seed_match * 0.5))
        region *= (1.0 - human_protection)
    region_image = Image.fromarray(np.rint(np.clip(region, 0, 1) * 255).astype(np.uint8), 'L')
    left, top, right, bottom = roi
    box = (round(left * model_w / width), round(top * model_h / height),
           round(right * model_w / width), round(bottom * model_h / height))
    region_image = region_image.crop(box).resize((right - left, bottom - top), Image.Resampling.BILINEAR)
    region_image = region_image.filter(ImageFilter.GaussianBlur(1.5))
    return np.asarray(region_image, dtype=np.float32) / 255.0


def _render_smart_corrections(strokes, reference_bbox, person_probability, frame_size, roi,
                              tracking_threshold=0.08, constrain_to_person=True):
    """Track foreground-add strokes with this frame's semantic person silhouette."""
    if not strokes or not reference_bbox or person_probability is None:
        return None, None
    frame_w, frame_h = frame_size
    ref_x0, ref_y0, ref_x1, ref_y1 = reference_bbox
    ref_w, ref_h = max(1.0, ref_x1 - ref_x0), max(1.0, ref_y1 - ref_y0)
    ys, xs = np.nonzero(np.asarray(person_probability) >= tracking_threshold)
    if len(xs) < 4:
        return None, None
    model_h, model_w = person_probability.shape
    current = (xs.min() * frame_w / model_w, ys.min() * frame_h / model_h,
               (xs.max() + 1) * frame_w / model_w, (ys.max() + 1) * frame_h / model_h)
    cur_x0, cur_y0, cur_x1, cur_y1 = current
    cur_w, cur_h = max(1.0, cur_x1 - cur_x0), max(1.0, cur_y1 - cur_y0)
    left, top, right, bottom = roi
    crop_size = (right - left, bottom - top)
    additions = Image.new('L', crop_size, 0)
    subtractions = Image.new('L', crop_size, 0)
    for stroke in strokes:
        points = stroke.get('points') or ()
        if not points:
            continue
        mapped = [(round(cur_x0 + (x - ref_x0) * cur_w / ref_w - left),
                   round(cur_y0 + (y - ref_y0) * cur_h / ref_h - top)) for x, y in points]
        scale_x, scale_y = cur_w / ref_w, cur_h / ref_h
        width = max(1, round(float(stroke.get('radius', 24)) * (scale_x + scale_y) * 0.5))
        target = additions if stroke.get('add', True) else subtractions
        draw = ImageDraw.Draw(target)
        draw.line(mapped, fill=255, width=width, joint='curve')
        radius = width // 2
        for x, y in (mapped[0], mapped[-1]):
            draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=255)
    # Feather only the brush boundary slightly; the correction remains a clear,
    # direct foreground/background prompt while avoiding pixelated brush edges.
    additions = additions.filter(ImageFilter.GaussianBlur(0.8))
    additions = np.asarray(additions, dtype=np.float32) / 255.0
    subtractions = subtractions.filter(ImageFilter.GaussianBlur(0.8))
    subtractions = np.asarray(subtractions, dtype=np.float32) / 255.0
    # The prompt follows the current semantic subject area, so it can fill a
    # missed jacket/shoulder patch but cannot paint a stationary green blob in
    # the background when the person has moved.
    support = Image.fromarray(np.clip(person_probability * 255, 0, 255).astype(np.uint8), 'L')
    support = support.resize(frame_size, Image.Resampling.BILINEAR)
    # Keep corrections attached to the moving person. A large dilation makes
    # shoulder brush marks spill onto nearby background and look stationary.
    support = support.point(lambda value: 255 if value >= 30 else 0).filter(ImageFilter.MaxFilter(7))
    support = support.filter(ImageFilter.GaussianBlur(1.0))
    support = np.asarray(support.crop((left, top, right, bottom)), dtype=np.float32) / 255.0
    if constrain_to_person:
        additions *= support
        subtractions *= support
    # Subtraction strokes are handled as scene-background prompts by the
    # same person-relative mapping as additions. Return a keep mask so erase
    # marks follow shoulders and sleeves instead of staying at old screen coords.
    return additions, np.clip(1.0 - subtractions, 0.0, 1.0)


def _create_ort_session(ort, model_path, session_options):
    """Prefer CUDA, DirectML, Core ML, then CPU; report the backend used."""
    # Load the CUDA wheel's bundled DLL dependencies before constructing any
    # session, including person selection and timeline preview.
    if hasattr(ort, 'preload_dlls'):
        try:
            ort.preload_dlls()
        except Exception:
            pass
    available = set(ort.get_available_providers())
    failures = []
    for provider in ('CUDAExecutionProvider', 'DmlExecutionProvider', 'CoreMLExecutionProvider', 'CPUExecutionProvider'):
        if provider not in available:
            continue
        if provider == 'CUDAExecutionProvider':
            # Keep CUDA inference from creating a worker for every logical CPU.
            # The RVM frame loop is recurrent and the app also decodes, composites,
            # and encodes frames concurrently; a large ORT pool oversubscribes the
            # CPU and can leave the GPU waiting between frames.
            session_options.intra_op_num_threads = 2
        if provider == 'DmlExecutionProvider':
            session_options.enable_mem_pattern = False
            session_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        else:
            session_options.enable_mem_pattern = True
        requested = [provider] if provider == 'CPUExecutionProvider' else [provider, 'CPUExecutionProvider']
        try:
            session = ort.InferenceSession(str(model_path), sess_options=session_options, providers=requested)
            if provider == 'CPUExecutionProvider' or provider in session.get_providers():
                return session, provider
            failures.append(f'{provider}: 初始化后未启用')
        except Exception as exc:
            failures.append(f'{provider}: {exc}')
    raise RuntimeError('无法初始化推理设备。\n' + '\n'.join(failures[-3:]))


def _provider_label(provider):
    return {'CUDAExecutionProvider': 'GPU（NVIDIA CUDA）',
            'DmlExecutionProvider': 'GPU（DirectML）',
            'CoreMLExecutionProvider': 'Apple Core ML'}.get(provider, 'CPU')


class RotoscopeWindow:
    """Let users mark a rough subject region and guide a foreground mask."""

    def __init__(self, parent, host=None):
        self.app = parent if hasattr(parent, 'settings_path') else None
        self.parent = self.app.root if self.app else parent
        self.embedded = host is not None
        self.window = host if self.embedded else tk.Toplevel(self.parent)
        self.window.configure(bg='#101316')
        if not self.embedded:
            self.window.title('人物抠像')
            screen_w = self.window.winfo_screenwidth()
            screen_h = self.window.winfo_screenheight()
            initial_w = min(1280, max(900, screen_w - 100))
            initial_h = min(900, max(640, screen_h - 120))
            self.window.geometry(f'{initial_w}x{initial_h}')
            self.window.minsize(min(760, screen_w), min(560, screen_h))
            self.window.after_idle(lambda: native_caption(self.window, PALETTES['深色'], True))
        self.video = tk.StringVar()
        self.sample_time = tk.StringVar(value='1')
        self.video_fps = 30.0
        self.total_frames = 0
        self.timeline_value = tk.DoubleVar(value=0)
        self.timeline_text = tk.StringVar(value='帧轨道：读取视频后可拖动浏览')
        self.status = tk.StringVar(value='选择视频后，打开一帧并圈出人物的大致范围。')
        self.image = None
        self.loaded_source_identity = None
        self.tk_image = None
        self.smart_overlay_image = None
        self.photo_size = (1, 1)
        self.zoom_factor = 1.0
        self.space_pan = False
        self.pan_active = False
        self.bounds = None
        self.drag_start = None
        self.export_button = None
        self.cancel_button = None
        self.progress = None
        self.progress_text = tk.StringVar(value='等待导出')
        self.choose_button = None
        self.read_button = None
        self.loading_preview = False
        # Timeline scrubbing is a frame refresh within the same source. Keep
        # the selected-person state and current canvas alive while FFmpeg
        # decodes the requested frame; only a newly loaded source resets it.
        self.timeline_seeking = False
        self.events = queue.Queue()
        self.cancel_event = threading.Event()
        self._preview_cancel_event = threading.Event()
        self.preview_generation = 0
        self._mask_scan_lock = threading.Lock()
        self._mask_scan_process = None
        # Page visibility may reduce UI polling, but must never pause an
        # in-flight cutout or the frame-mask scan it depends on. Preview paint
        # is deferred while this embedded page is hidden to avoid work on an
        # unmapped canvas during unrelated workspace switches.
        self._background_active = True
        self._preview_render_pending = False
        self.is_exporting = False
        self.export_jobs = {}
        self.close_when_finished = False
        self.provider_name = 'CPU'
        self.progress_started_at = None
        self.progress_started_count = 0
        self.progress_last_label_update = 0.0
        self.export_started_at = None
        self.active_export_repair_alpha = False
        self.active_export_edge_cleanup = True
        self.active_export_format = ''
        self.contour_mode = tk.BooleanVar(value=False)
        self.contour_points = []
        self.active_contour = None
        self.background_brush_mode = tk.BooleanVar(value=False)
        self.background_strokes = []
        self.active_background_stroke = None
        self.smart_select_mode = tk.BooleanVar(value=True)
        self.smart_seed = None
        self.smart_mask = None
        self.smart_base_mask = None
        # Sparse, compact preview masks keep five independent cutout pages
        # from retaining hundreds of megabytes for long clips.
        self.frame_mask_cache = OrderedDict()
        self.mask_scan_generation = 0
        self.mask_scan_running = False
        self.mask_scan_interval = 1
        self.smart_reference_bbox = None
        self.smart_boundary = None
        self.smart_correction_mode = tk.BooleanVar(value=False)
        self.smart_correction_add = tk.BooleanVar(value=True)
        self.smart_brush_snap = tk.BooleanVar(value=False)
        self.smart_brush_size = tk.IntVar(value=36)
        self.smart_corrections = []
        self.active_smart_correction = None
        self.repair_alpha_mode = tk.BooleanVar(value=False)
        self.alpha_edge_cleanup = tk.BooleanVar(value=True)
        self.repair_alpha = None
        self.smart_tracking_mask = None
        self.loaded_repair_mode = None
        self.smart_selecting = False
        self.selection_generation = 0
        self.export_format = tk.StringVar(value='ProRes 4444 MOV（达芬奇推荐，含 Alpha）')
        if not self.embedded:
            self.window.protocol('WM_DELETE_WINDOW', self.close)
        self._build()
        self._enable_drop()
        self.window.after(100, self._poll_events)

    def _build(self):
        bar = ttk.Frame(self.window, padding=10)
        bar.pack(fill='x')
        self.path_entry = ttk.Entry(bar, textvariable=self.video)
        self.path_entry.pack(side='left', fill='x', expand=True)
        self.choose_button = ttk.Button(bar, text='选择视频', command=self.choose_video)
        self.choose_button.pack(side='left', padx=6)
        if self.embedded:
            self.choose_button.pack_forget()
            self.path_entry.configure(state='readonly')
        ttk.Label(bar, text='参考帧秒数').pack(side='left')
        ttk.Entry(bar, textvariable=self.sample_time, width=6).pack(side='left', padx=(4, 6))
        self.read_button = ttk.Button(bar, text='读取画面', command=self.load_frame)
        self.read_button.pack(side='left')
        tools = ttk.Frame(self.window, padding=(10, 0, 10, 6))
        tools.pack(fill='x')
        ttk.Checkbutton(tools, text='智能选人（点击人物）', variable=self.smart_select_mode,
                        command=self._smart_mode_changed).pack(side='left')
        ttk.Checkbutton(tools, text='粗略人物范围', variable=self.contour_mode,
                        command=lambda: (self.background_brush_mode.set(False), self.smart_select_mode.set(False))).pack(side='left', padx=(8, 0))
        ttk.Checkbutton(tools, text='背景排除笔（涂沙发等）', variable=self.background_brush_mode,
                        command=lambda: (self.contour_mode.set(False), self.smart_select_mode.set(False))).pack(side='left', padx=(8, 0))
        ttk.Button(tools, text='清除标记', command=self.clear_contour).pack(side='left', padx=8)
        ttk.Label(tools, text='RVM 逐帧跟随人物；背景笔会避开当前识别到的人物。').pack(side='left')
        corrections = ttk.Frame(self.window, padding=(10, 0, 10, 6))
        corrections.pack(fill='x')
        ttk.Checkbutton(corrections, text='修复已有透明成片（收紧外沿残边）', variable=self.repair_alpha_mode,
                        command=self._repair_alpha_mode_changed).pack(side='left')
        ttk.Checkbutton(corrections, text='发丝边缘净化（减少灰边）', variable=self.alpha_edge_cleanup).pack(side='left', padx=(8, 0))
        ttk.Checkbutton(corrections, text='手动修正绿蒙版', variable=self.smart_correction_mode,
                        command=self._smart_correction_mode_changed).pack(side='left')
        ttk.Checkbutton(corrections, text='吸附到人物边缘', variable=self.smart_brush_snap).pack(side='left', padx=(6, 0))
        self.correction_add_button = ttk.Radiobutton(corrections, text='添加保留', variable=self.smart_correction_add, value=True)
        self.correction_add_button.pack(side='left', padx=(6, 0))
        ttk.Radiobutton(corrections, text='减去保留', variable=self.smart_correction_add, value=False).pack(side='left', padx=(4, 0))
        ttk.Label(corrections, text='笔刷').pack(side='left', padx=(10, 2))
        ttk.Spinbox(corrections, from_=8, to=120, increment=4, textvariable=self.smart_brush_size,
                    width=5).pack(side='left')
        ttk.Button(corrections, text='撤销修正', command=self.undo_smart_correction).pack(side='left', padx=6)
        view_tools = ttk.Frame(self.window, padding=(10, 0, 10, 4))
        view_tools.pack(fill='x')
        ttk.Button(view_tools, text='−', width=3, command=lambda: self._change_zoom(1 / 1.25)).pack(side='left')
        ttk.Button(view_tools, text='＋', width=3, command=lambda: self._change_zoom(1.25)).pack(side='left', padx=(3, 6))
        ttk.Button(view_tools, text='适配画面', command=self._fit_image).pack(side='left')
        self.zoom_label = ttk.Label(view_tools, text='适配 100% · 滚轮缩放，空格+左键拖动画面')
        self.zoom_label.pack(side='left', padx=8)
        timeline = ttk.Frame(self.window, padding=(10, 0, 10, 6))
        timeline.pack(fill='x')
        ttk.Label(timeline, textvariable=self.timeline_text, width=31, anchor='w').pack(side='left')
        self.timeline = ttk.Scale(timeline, from_=0, to=0, variable=self.timeline_value,
                                  style='Horizontal.TScale',
                                  command=self._timeline_changed)
        self.timeline.pack(side='left', fill='x', expand=True, padx=(4, 8))
        bind_scale_wheel(self.timeline, step=1)
        self.timeline.bind('<ButtonRelease-1>', self._timeline_released)
        canvas_frame = ttk.Frame(self.window)
        canvas_frame.pack(fill='both', expand=True, padx=10, pady=(0, 8))
        self.canvas = tk.Canvas(canvas_frame, background='#24272b', highlightthickness=0,
                                xscrollincrement=32, yscrollincrement=32)
        horizontal = ttk.Scrollbar(canvas_frame, orient='horizontal', command=self.canvas.xview,
                                   style='Horizontal.TScrollbar')
        vertical = ttk.Scrollbar(canvas_frame, orient='vertical', command=self.canvas.yview,
                                 style='Vertical.TScrollbar')
        self.horizontal_scrollbar = horizontal
        self.vertical_scrollbar = vertical
        self.canvas.configure(xscrollcommand=horizontal.set, yscrollcommand=vertical.set)
        self.canvas.grid(row=0, column=0, sticky='nsew')
        vertical.grid(row=0, column=1, sticky='ns')
        horizontal.grid(row=1, column=0, sticky='ew')
        canvas_frame.grid_rowconfigure(0, weight=1)
        canvas_frame.grid_columnconfigure(0, weight=1)
        self.canvas.bind('<Configure>', lambda _e: self._show_image())
        self.canvas.bind('<ButtonPress-1>', self._begin_mark)
        self.canvas.bind('<B1-Motion>', self._draw_mark)
        self.canvas.bind('<ButtonRelease-1>', self._finish_mark)
        self.canvas.bind('<MouseWheel>', self._mouse_wheel_zoom)
        self.canvas.bind('<Button-4>', lambda event: self._mouse_wheel_zoom(event, 1))
        self.canvas.bind('<Button-5>', lambda event: self._mouse_wheel_zoom(event, -1))
        for scrollbar, axis in ((horizontal, 'x'), (vertical, 'y')):
            scrollbar.bind('<MouseWheel>', lambda event, direction=axis: self._scroll_canvas_wheel(event, direction), add='+')
            scrollbar.bind('<Button-4>', lambda event, direction=axis: self._scroll_canvas_wheel(event, direction, 1), add='+')
            scrollbar.bind('<Button-5>', lambda event, direction=axis: self._scroll_canvas_wheel(event, direction, -1), add='+')
        key_target = self.parent if self.embedded else self.window
        key_target.bind('<KeyPress-space>', self._space_pan_start, add='+')
        key_target.bind('<KeyRelease-space>', self._space_pan_end, add='+')
        self.canvas.bind('<ButtonPress-2>', self._pan_start)
        self.canvas.bind('<B2-Motion>', self._pan_move)
        self.canvas.bind('<ButtonRelease-2>', self._pan_end)
        controls = ttk.Frame(self.window, padding=(10, 0, 10, 8))
        controls.pack(fill='x')
        action_row = ttk.Frame(controls)
        action_row.pack(fill='x')
        ttk.Label(action_row, text='输出格式').pack(side='left')
        ttk.Combobox(action_row, textvariable=self.export_format, state='readonly', width=35,
                     values=('ProRes 4444 MOV（达芬奇推荐，含 Alpha）',
                             'DaVinci FFV1 MOV（无损透明，其他软件）',
                             '小体积 WebM（含透明，网页/预览）')).pack(side='left', padx=(5, 10))
        self.export_button = ttk.Button(action_row, text='导出透明视频', command=self.export)
        self.export_button.pack(side='right', padx=(8, 0))
        self.cancel_button = ttk.Button(action_row, text='取消', command=self.cancel_export, state='disabled')
        self.cancel_button.pack(side='right', padx=(8, 0))
        progress_row = ttk.Frame(controls)
        progress_row.pack(fill='x', pady=(5, 0))
        ttk.Label(progress_row, textvariable=self.status, wraplength=700).pack(side='left', fill='x', expand=True)
        ttk.Style(self.window).configure(
            'Cutout.Horizontal.TProgressbar', background='#29c98a', troughcolor='#25282c',
            bordercolor='#25282c', lightcolor='#29c98a', darkcolor='#29c98a',
        )
        self.progress = ttk.Progressbar(progress_row, style='Cutout.Horizontal.TProgressbar',
                                         mode='determinate', maximum=100, length=180)
        self.progress.pack(side='right', padx=(8, 0), fill='x', expand=True)
        ttk.Label(progress_row, textvariable=self.progress_text, width=52, anchor='e').pack(side='right', padx=(8, 4))

    def _enable_drop(self):
        for widget in (self.window, self.path_entry, self.canvas):
            try:
                widget.drop_target_register(DND_FILES)
                widget.dnd_bind('<<Drop>>', self.on_drop)
            except (AttributeError, tk.TclError):
                continue

    def on_drop(self, event):
        try:
            paths = self.window.tk.splitlist(event.data)
        except tk.TclError:
            paths = [event.data.strip('{}')]
        for item in paths:
            if Path(item).suffix.lower() in {'.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.wmv'}:
                self.set_video(item)
                return 'break'
        self.status.set('请拖入 MP4、MOV、MKV、WebM、AVI 或 WMV 视频。')
        return 'break'

    def set_video(self, path):
        # A source change invalidates every asynchronous result tied to the old
        # clip before any widgets start loading the new one.
        self._preview_cancel_event.set()
        self.preview_generation += 1
        self.loading_preview = False
        self.timeline_seeking = False
        self.selection_generation += 1
        self.smart_selecting = False
        self._cancel_mask_scan(clear_cache=True)
        self.video.set(str(path))
        if self.embedded and self.app:
            self.app.on_cutout_video_set(self, path)
        self.image = None
        self.tk_image = None
        self.canvas.delete('all')
        self.loaded_source_identity = None
        self.loaded_repair_mode = None
        self.repair_alpha = None
        self.smart_seed = None
        self.smart_mask = None
        self.smart_base_mask = None
        self.smart_reference_bbox = None
        self.smart_tracking_mask = None
        self.smart_boundary = None
        self.smart_corrections.clear()
        self.active_smart_correction = None
        self.contour_points.clear()
        self.background_strokes.clear()
        self.active_contour = None
        self.active_background_stroke = None
        self.bounds = None
        self._sync_job_controls(reset_progress=True)
        self.sample_time.set('1')
        self.total_frames = 0
        self.timeline_value.set(0)
        self.timeline.configure(to=0)
        self.timeline_text.set('正在读取视频帧数…')
        self.load_frame()

    def choose_video(self):
        path = filedialog.askopenfilename(parent=self.window, title='选择视频', filetypes=[('视频', '*.mp4 *.mov *.mkv *.webm *.avi'), ('全部文件', '*.*')])
        if path:
            self.set_video(path)

    def load_frame(self):
        self._preview_cancel_event.set()
        preview_cancel_event = threading.Event()
        self._preview_cancel_event = preview_cancel_event
        self.preview_generation += 1
        preview_generation = self.preview_generation
        path = Path(self.video.get()).expanduser()
        if not path.is_file():
            self.loading_preview = False
            self.status.set('视频文件不存在或无法访问，请重新选择。')
            self.path_entry.configure(state='readonly' if self.embedded else 'normal')
            self.choose_button.configure(state='normal')
            self.read_button.configure(state='normal')
            messagebox.showwarning('选择视频', '请先选择一个可读取的视频文件。', parent=self.window)
            return
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            self.loading_preview = False
            self.path_entry.configure(state='readonly' if self.embedded else 'normal')
            self.choose_button.configure(state='normal')
            self.read_button.configure(state='normal')
            messagebox.showerror('缺少 FFmpeg', '未找到 FFmpeg，无法读取视频帧。', parent=self.window)
            return
        try:
            path = path.resolve(strict=True)
            at = max(0.0, float(self.sample_time.get()))
            self.requested_preview_time = at
            repair_alpha = bool(self.repair_alpha_mode.get())
            self.loading_preview = True
            if not self.timeline_seeking:
                self.loaded_source_identity = None
                self.loaded_repair_mode = None
            self.path_entry.configure(state='disabled')
            self.choose_button.configure(state='disabled')
            self.read_button.configure(state='disabled')
            self.status.set('正在读取参考帧，窗口仍可响应…')
            threading.Thread(target=self._load_frame_worker,
                             args=(ffmpeg, path, at, repair_alpha, preview_generation,
                                   preview_cancel_event),
                             daemon=True).start()
        except Exception as exc:
            messagebox.showerror('读取失败', str(exc), parent=self.window)

    def _load_frame_worker(self, ffmpeg, path, at, repair_alpha=False, preview_generation=0,
                           cancel_event=None):
        cancel_event = cancel_event or threading.Event()
        try:
            before = path.stat()
            ffprobe = shutil.which('ffprobe')
            if not ffprobe:
                raise RuntimeError('未找到 FFprobe，无法读取视频帧数并建立时间轨道。')
            metadata = _run_preview_command([ffprobe, '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration',
                '-of', 'json', str(path)], capture_output=True, check=True, text=True,
                timeout=30,
                encoding='utf-8', errors='replace', cancel_event=cancel_event)
            streams = json.loads(metadata.stdout).get('streams', [])
            if not streams:
                raise RuntimeError('视频中没有可读取的视频轨道。')
            stream = streams[0]
            def parse_rate(value):
                try:
                    numerator, denominator = value.split('/', 1)
                    return float(numerator) / float(denominator)
                except (ValueError, ZeroDivisionError, AttributeError):
                    return 0.0
            fps = parse_rate(stream.get('avg_frame_rate')) or parse_rate(stream.get('r_frame_rate')) or 30.0
            duration_text = stream.get('duration') or json.loads(metadata.stdout).get('format', {}).get('duration') or '0'
            try:
                duration = float(duration_text)
            except (ValueError, TypeError):
                duration = 0.0
            try:
                frame_count = int(stream.get('nb_frames') or 0)
            except (ValueError, TypeError):
                frame_count = 0
            if frame_count <= 0:
                frame_count = max(1, round(duration * fps))
            # Clamp manual time entry to the last valid frame. Previously an
            # out-of-range seek returned empty bytes and leaked Pillow's
            # low-level "cannot identify image file" exception into the UI.
            if frame_count > 0 and fps > 0:
                at = min(at, max(0.0, (frame_count - 1) / fps))
            elif duration > 0 and fps > 0:
                at = min(at, max(0.0, duration - 1.0 / fps))
            if repair_alpha:
                pix_fmt = stream.get('pix_fmt', '')
                if not any(token in pix_fmt for token in ('yuva', 'rgba', 'bgra', 'argb', 'abgr', 'gbrap', 'ya')):
                    raise RuntimeError(f'这个视频没有可读的 Alpha 通道（像素格式：{pix_fmt or "未知"}）。请选择已经抠好的透明视频。')
            result = _run_preview_command([ffmpeg, '-hide_banner', '-loglevel', 'error', '-ss', str(at),
                '-protocol_whitelist', 'file,crypto,data', '-i', str(path), '-frames:v', '1',
                '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], capture_output=True, check=True,
                timeout=60, cancel_event=cancel_event)
            if not result.stdout:
                raise RuntimeError(f'视频在 {at:.3f} 秒处没有可读取的画面。请确认视频文件完整。')
            from io import BytesIO
            # FFmpeg emits a PNG frame; limit Pillow to that decoder rather
            # than auto-detecting every installed image format from bytes.
            image = Image.open(BytesIO(result.stdout), formats=['PNG']).convert('RGBA' if repair_alpha else 'RGB')
            info = path.stat()
            if (before.st_size, before.st_mtime_ns) != (info.st_size, info.st_mtime_ns):
                raise RuntimeError('读取期间视频文件发生了变化，请重新选择视频。')
            identity = (str(path.resolve(strict=True)), info.st_size, info.st_mtime_ns)
            self.events.put(('preview', preview_generation, image, None, identity, repair_alpha,
                             fps, frame_count, at))
        except Exception as exc:
            self.events.put(('preview', preview_generation, None, str(exc), None,
                             repair_alpha, 0.0, 0, at))

    def _timeline_changed(self, value):
        frame = max(0, min(max(0, self.total_frames - 1), round(float(value))))
        seconds = frame / self.video_fps if self.video_fps > 0 else 0.0
        self.timeline_text.set(f'{frame + 1:,} / {self.total_frames:,} 帧  ·  {seconds:.2f} 秒')

    def _timeline_released(self, _event=None):
        if self.loading_preview or self.total_frames <= 0 or not self.video.get():
            return
        frame = max(0, min(self.total_frames - 1, round(self.timeline_value.get())))
        seconds = frame / self.video_fps if self.video_fps > 0 else 0.0
        self.sample_time.set(f'{seconds:.3f}')
        self.timeline_seeking = True
        self.load_frame()

    def _show_image(self, zoom_anchor=None):
        if self.embedded and not self._background_active:
            self._preview_render_pending = True
            if self.app is not None:
                self.app._record_cutout_preview_event("deferred")
            return
        if self.image is None:
            return
        render_started = time.perf_counter()
        try:
            old_xview = self.canvas.xview()[0]
            old_yview = self.canvas.yview()[0]
        except (AttributeError, tk.TclError):
            old_xview = old_yview = 0.0
        cw, ch = max(1, self.canvas.winfo_width()), max(1, self.canvas.winfo_height())
        fit_scale = min(cw / self.image.width, ch / self.image.height)
        scale = fit_scale * self.zoom_factor
        size = (max(1, round(self.image.width * scale)), max(1, round(self.image.height * scale)))
        preview = self.image.resize(size, Image.Resampling.LANCZOS)
        if self.smart_mask is not None:
            mask = self.smart_mask.resize(size, Image.Resampling.LANCZOS).point(lambda value: round(value * 0.38))
            tint = Image.new('RGBA', size, (25, 225, 135, 0))
            tint.putalpha(mask)
            preview = Image.alpha_composite(preview.convert('RGBA'), tint)
            self.smart_overlay_image = ImageTk.PhotoImage(preview)
            display_image = self.smart_overlay_image
        else:
            self.smart_overlay_image = None
            display_image = ImageTk.PhotoImage(preview)
        self.tk_image = display_image
        x, y = max(0, (cw - size[0]) // 2), max(0, (ch - size[1]) // 2)
        self.photo_size = (size[0], size[1], x, y)
        self.canvas.delete('all')
        self.canvas.configure(scrollregion=(0, 0, max(cw, x + size[0]), max(ch, y + size[1])))
        self.canvas.create_image(x, y, image=self.tk_image, anchor='nw', tags='preview')
        if self.smart_seed:
            sx = x + self.smart_seed[0] * size[0] / self.image.width
            sy = y + self.smart_seed[1] * size[1] / self.image.height
            self.canvas.create_oval(sx - 6, sy - 6, sx + 6, sy + 6, fill='#13d98a', outline='white', width=2)
        if self.bounds:
            self.canvas.create_rectangle(*self.bounds, outline='#28e07a', width=3, tags='mark')
        for points in self.contour_points + ([self.active_contour] if self.active_contour else []):
            if len(points) < 2:
                continue
            canvas_points = []
            for px, py in points:
                canvas_points.extend((x + px * size[0] / self.image.width,
                                      y + py * size[1] / self.image.height))
            self.canvas.create_line(*canvas_points, fill='#ff493f', width=4, capstyle=tk.ROUND,
                                    joinstyle=tk.ROUND, smooth=True, tags='contour')
        for points in self.background_strokes + ([self.active_background_stroke] if self.active_background_stroke else []):
            if len(points) < 1:
                continue
            canvas_points = []
            for px, py in points:
                canvas_points.extend((x + px * size[0] / self.image.width,
                                      y + py * size[1] / self.image.height))
            if len(canvas_points) == 2:
                cx, cy = canvas_points
                brush_size = max(5, round(max(10, min(self.image.width, self.image.height) // 100)
                                          * size[0] / self.image.width))
                radius = brush_size / 2
                self.canvas.create_oval(cx - radius, cy - radius, cx + radius, cy + radius,
                                        fill='#42b9ff', outline='', tags='background-mark')
            else:
                brush_size = max(5, round(max(10, min(self.image.width, self.image.height) // 100)
                                          * size[0] / self.image.width))
                self.canvas.create_line(*canvas_points, fill='#42b9ff', width=brush_size,
                                        capstyle=tk.ROUND, joinstyle=tk.ROUND, smooth=True,
                                        tags='background-mark')
        # Completed corrections are already part of smart_mask. Drawing their
        # opaque brush-colored paths over the video made the preview look like
        # paint rather than a live matte. Only show a translucent guide while
        # the mouse is down; on release, display the corrected green mask itself.
        corrections = [self.active_smart_correction] if self.active_smart_correction else []
        for stroke in corrections:
            points = stroke['points']
            if not points:
                continue
            canvas_points = []
            for px, py in points:
                canvas_points.extend((x + px * size[0] / self.image.width,
                                      y + py * size[1] / self.image.height))
            color = '#17e58e' if stroke['add'] else '#ff5b68'
            brush_size = max(2, round(stroke['radius'] * size[0] / self.image.width))
            if len(canvas_points) == 2:
                cx, cy = canvas_points
                radius = brush_size / 2
                self.canvas.create_oval(cx-radius, cy-radius, cx+radius, cy+radius,
                                        fill=color, outline='', stipple='gray50', tags='smart-correction')
            else:
                self.canvas.create_line(*canvas_points, fill=color, width=brush_size,
                                        capstyle=tk.ROUND, joinstyle=tk.ROUND, smooth=True, stipple='gray50',
                                        tags='smart-correction')
        if hasattr(self, 'zoom_label'):
            self.zoom_label.configure(text=f'{"适配" if self.zoom_factor == 1.0 else "放大"} {self.zoom_factor:.0%}')
        if zoom_anchor is None:
            self.canvas.xview_moveto(old_xview)
            self.canvas.yview_moveto(old_yview)
        else:
            fx, fy, pointer_x, pointer_y = zoom_anchor
            total_w, total_h = max(cw, x + size[0]), max(ch, y + size[1])
            scroll_x = max(0.0, min(total_w - cw, x + fx * size[0] - pointer_x))
            scroll_y = max(0.0, min(total_h - ch, y + fy * size[1] - pointer_y))
            self.canvas.xview_moveto(scroll_x / max(1, total_w))
            self.canvas.yview_moveto(scroll_y / max(1, total_h))
        if self.app is not None:
            self.app._record_cutout_preview_event(
                "painted", (time.perf_counter() - render_started) * 1000
            )

    def _change_zoom(self, multiplier, event=None):
        if self.image is None:
            return
        anchor = None
        if event is not None:
            canvas_x, canvas_y = self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)
            _, _, image_x, image_y = self.photo_size
            display_w, display_h = self.photo_size[:2]
            anchor = (min(1.0, max(0.0, (canvas_x - image_x) / max(1, display_w))),
                      min(1.0, max(0.0, (canvas_y - image_y) / max(1, display_h))),
                      event.x, event.y)
        self.zoom_factor = min(4.0, max(1.0, self.zoom_factor * multiplier))
        self._show_image(anchor)

    def _mouse_wheel_zoom(self, event, direction=None):
        if getattr(event, 'state', 0) & 0x0001:
            return self._scroll_canvas_wheel(event, 'x', direction)
        if direction is None:
            direction = 1 if getattr(event, 'delta', 0) > 0 else -1
        self._change_zoom(1.2 if direction > 0 else 1 / 1.2, event)
        return 'break'

    def _scroll_canvas_wheel(self, event, axis, direction=None):
        if direction is None:
            number = getattr(event, 'num', None)
            if number == 4:
                direction = 1
            elif number == 5:
                direction = -1
            else:
                delta = getattr(event, 'delta', 0)
                direction = 1 if delta > 0 else -1
        scroll = self.canvas.xview_scroll if axis == 'x' else self.canvas.yview_scroll
        scroll(-direction * 3, 'units')
        return 'break'

    def _space_pan_start(self, _event):
        self.space_pan = True
        try:
            self.canvas.configure(cursor='fleur')
        except tk.TclError:
            pass

    def _space_pan_end(self, _event):
        self.space_pan = False
        if not self.pan_active:
            try:
                self.canvas.configure(cursor='')
            except tk.TclError:
                pass

    def _pan_start(self, event):
        self.pan_active = True
        self.canvas.scan_mark(event.x, event.y)
        return 'break'

    def _pan_move(self, event):
        self.canvas.scan_dragto(event.x, event.y, gain=1)
        return 'break'

    def _pan_end(self, _event):
        self.pan_active = False
        if not self.space_pan:
            try:
                self.canvas.configure(cursor='')
            except tk.TclError:
                pass
        return 'break'

    def _fit_image(self):
        self.zoom_factor = 1.0
        self._show_image()

    def _begin_mark(self, event):
        if self.image is None:
            return
        if self.space_pan:
            self.pan_active = True
            self.canvas.scan_mark(event.x, event.y)
            return 'break'
        self.canvas.focus_set()
        needs_tracking_seed = self.repair_alpha_mode.get() and self.smart_seed is None
        if self.smart_correction_mode.get() and not needs_tracking_seed:
            if self.repair_alpha_mode.get() and self.smart_correction_add.get():
                self.status.set('成片修复只支持减去多余 Alpha；添加人物内容请回到原视频重新抠像。')
                return
            if self.smart_mask is None:
                self.status.set('先点击人物完成智能识别，再用修正笔补充或减去绿色区域。')
                return
            try:
                radius = max(4, min(120, int(self.smart_brush_size.get())))
            except (ValueError, tk.TclError):
                radius = 36
            self.active_smart_correction = {'points': [self._smart_brush_point(event)],
                                            'add': bool(self.smart_correction_add.get()),
                                            'radius': radius}
            self._show_image()
            return
        if self.smart_select_mode.get() or needs_tracking_seed:
            point = self._image_point(event)
            try:
                source = Path(self.video.get()).expanduser().resolve(strict=True)
            except OSError as exc:
                self.status.set(f'无法读取当前视频：{exc}')
                return
            repair_mode = bool(self.repair_alpha_mode.get())
            total_frames = self.total_frames
            self.mask_scan_interval = max(
                1, (max(1, total_frames) + MAX_PREVIEW_MASKS - 1) // MAX_PREVIEW_MASKS
            )
            scan_interval = self.mask_scan_interval
            scan_generation = self._cancel_mask_scan(clear_cache=True)
            self.smart_seed = point
            self.smart_corrections.clear()
            self.smart_base_mask = None
            self.smart_reference_bbox = None
            self.smart_boundary = None
            self.smart_mask = None
            self.smart_selecting = True
            self.selection_generation += 1
            generation = self.selection_generation
            self._show_image()
            self.status.set('正在识别点击的人物轮廓…')
            image = self.image.copy()
            threading.Thread(target=self._smart_select_worker,
                             args=(image, point, generation, repair_mode, source,
                                   total_frames, scan_interval,
                                   scan_generation), daemon=True).start()
            return
        if self.background_brush_mode.get():
            self.active_background_stroke = [self._image_point(event)]
            self._show_image()
            return
        if self.contour_mode.get():
            self.active_contour = [self._image_point(event)]
            self._show_image()
            return
        _, _, ox, oy = self.photo_size
        self.drag_start = (max(ox, min(event.x, ox + self.photo_size[0])), max(oy, min(event.y, oy + self.photo_size[1])))
        self.bounds = (*self.drag_start, *self.drag_start)

    def _draw_mark(self, event):
        if self.pan_active and self.space_pan:
            self.canvas.scan_dragto(event.x, event.y, gain=1)
            return 'break'
        if self.active_smart_correction is not None:
            self.active_smart_correction['points'].append(self._smart_brush_point(event))
            self._show_image()
            return
        if self.active_background_stroke is not None:
            self.active_background_stroke.append(self._image_point(event))
            self._show_image()
            return
        if self.active_contour is not None:
            self.active_contour.append(self._image_point(event))
            self._show_image()
            return
        if not self.drag_start:
            return
        _, _, ox, oy = self.photo_size
        x = max(ox, min(event.x, ox + self.photo_size[0]))
        y = max(oy, min(event.y, oy + self.photo_size[1]))
        self.bounds = (self.drag_start[0], self.drag_start[1], x, y)
        self._show_image()

    def _finish_mark(self, _event):
        if self.pan_active:
            self.pan_active = False
            return 'break'
        if self.active_smart_correction is not None:
            stroke = self.active_smart_correction
            if len(stroke['points']) == 1:
                stroke['points'].append(stroke['points'][0])
            self.smart_corrections.append(stroke)
            self.active_smart_correction = None
            self._apply_smart_corrections_to_preview()
            self._show_image()
            action = '加入保留区' if stroke['add'] else '从保留区减去'
            self.status.set(f'已{action}。导出时添加笔迹会跟随逐帧人物识别；减去笔迹作为背景提示，并保护移动中的人物。')
            return
        if self.active_background_stroke is not None:
            if len(self.active_background_stroke) == 1:
                self.active_background_stroke.append(self.active_background_stroke[0])
            self.background_strokes.append(self.active_background_stroke)
            self.active_background_stroke = None
            self._show_image()
            self.status.set('蓝色标记会逐帧识别相似背景区域，并依据当前人物识别结果保护移动中的人物。')
            return
        if self.active_contour is not None:
            self.active_contour.append(self.active_contour[0])
            self.contour_points.append(self.active_contour)
            self.active_contour = None
            self._show_image()
            self.status.set('人物活动范围已圈好；导出时会自动向外留余量，避免轮廓固定切住移动。')
            return
        if not self.drag_start or not self.bounds:
            return
        self.drag_start = None
        x0, y0, x1, y1 = self.bounds
        self.bounds = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        self._show_image()
        self.status.set('范围已标好。请给人物四周留些余量；模型会在范围内提取发丝和人物边缘。')

    def _image_point(self, event):
        preview_w, preview_h, ox, oy = self.photo_size
        canvas_x, canvas_y = self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)
        x = min(max(canvas_x, ox), ox + preview_w)
        y = min(max(canvas_y, oy), oy + preview_h)
        return ((x - ox) * self.image.width / preview_w,
                (y - oy) * self.image.height / preview_h)

    def clear_contour(self):
        self.contour_points.clear()
        self.active_contour = None
        self.background_strokes.clear()
        self.active_background_stroke = None
        self.smart_seed = None
        self.smart_mask = self.repair_alpha.copy() if self.repair_alpha_mode.get() and self.repair_alpha is not None else None
        self.smart_base_mask = self.repair_alpha.copy() if self.repair_alpha_mode.get() and self.repair_alpha is not None else None
        self.smart_reference_bbox = None
        self.smart_tracking_mask = None
        self.smart_boundary = None
        self.smart_corrections.clear()
        self.active_smart_correction = None
        self._show_image()
        self.status.set('人物轮廓已清除。')

    def _smart_correction_mode_changed(self):
        if self.smart_correction_mode.get():
            self.contour_mode.set(False)
            self.background_brush_mode.set(False)
            self.smart_select_mode.set(True)
            if self.smart_mask is None:
                self.status.set('先点击人物完成智能识别，再涂抹添加或减去区域。')
            else:
                self.status.set('在绿色蒙版上涂抹：添加保留补进人物，减去保留擦除误选背景。')

    def _repair_alpha_mode_changed(self):
        self._preview_cancel_event.set()
        self.preview_generation += 1
        self.loading_preview = False
        self.timeline_seeking = False
        self.selection_generation += 1
        self.smart_selecting = False
        self._cancel_mask_scan(clear_cache=True)
        self.path_entry.configure(state='readonly' if self.embedded else 'normal')
        self.choose_button.configure(state='normal')
        self.read_button.configure(state='normal')
        repair = bool(self.repair_alpha_mode.get())
        self.contour_mode.set(False)
        self.background_brush_mode.set(False)
        self.smart_select_mode.set(True)
        self.smart_correction_mode.set(repair)
        self.smart_correction_add.set(False)
        if hasattr(self, 'correction_add_button'):
            self.correction_add_button.configure(state='disabled' if repair else 'normal')
        self.loaded_source_identity = None
        self.loaded_repair_mode = None
        self.repair_alpha = None
        self.smart_tracking_mask = None
        self.smart_seed = None
        self.smart_mask = None
        self.smart_base_mask = None
        self.smart_reference_bbox = None
        self.smart_boundary = None
        self.smart_corrections.clear()
        self.active_smart_correction = None
        if repair:
            self.status.set('修复模式会保留现有 Alpha 并收紧外沿残边；要删局部残留时，点选人物后用“减去保留”标出。')
        else:
            self.status.set('已退出成片修复模式。请选择原视频并重新读取。')
        self._show_image()

    def undo_smart_correction(self):
        if self.active_smart_correction is not None:
            self.active_smart_correction = None
        elif self.smart_corrections:
            self.smart_corrections.pop()
        self._apply_smart_corrections_to_preview()
        self._show_image()
        self.status.set('已撤销最近一笔蒙版修正。')

    def _apply_smart_corrections_to_preview(self):
        if self.repair_alpha_mode.get():
            if self.repair_alpha is None or self.smart_tracking_mask is None:
                return
            mask = np.asarray(self.repair_alpha, dtype=np.uint8).copy()
        elif self.smart_base_mask is not None:
            mask = np.asarray(self.smart_base_mask, dtype=np.uint8).copy()
        else:
            return
        for stroke in self.smart_corrections:
            layer = Image.new('L', self.image.size, 0)
            draw = ImageDraw.Draw(layer)
            pts = [(round(x), round(y)) for x, y in stroke['points']]
            width = max(1, round(stroke['radius']))
            draw.line(pts, fill=255, width=width, joint='curve')
            radius = width // 2
            for px, py in (pts[0], pts[-1]):
                draw.ellipse((px-radius, py-radius, px+radius, py+radius), fill=255)
            correction = np.asarray(layer, dtype=np.uint8)
            if stroke['add']:
                mask = np.maximum(mask, correction)
            else:
                mask = np.minimum(mask, 255 - correction)
        self.smart_mask = Image.fromarray(mask, 'L')
        binary = mask >= 128
        eroded = np.asarray(Image.fromarray(mask, 'L').filter(ImageFilter.MinFilter(3)), dtype=np.uint8) >= 128
        self.smart_boundary = binary & ~eroded
        # Keep the motion-mapping reference stable if a subtract stroke removes
        # a far edge; additive shoulder/clothing strokes may expand the box.
        if self.repair_alpha_mode.get():
            reference = np.asarray(self.smart_tracking_mask, dtype=np.uint8).copy()
        else:
            reference = np.asarray(self.smart_base_mask, dtype=np.uint8).copy()
            for stroke in self.smart_corrections:
                if not stroke['add']:
                    continue
                layer = Image.new('L', self.image.size, 0)
                draw = ImageDraw.Draw(layer)
                pts = [(round(x), round(y)) for x, y in stroke['points']]
                width = max(1, round(stroke['radius']))
                draw.line(pts, fill=255, width=width, joint='curve')
                radius = width // 2
                for px, py in (pts[0], pts[-1]):
                    draw.ellipse((px-radius, py-radius, px+radius, py+radius), fill=255)
                reference = np.maximum(reference, np.asarray(layer, dtype=np.uint8))
        self.smart_reference_bbox = self._mask_bbox(Image.fromarray(reference, 'L'))

    def _smart_brush_point(self, event):
        point = self._image_point(event)
        if not self.smart_brush_snap.get() or self.smart_boundary is None:
            return point
        # Snap only to a nearby contour; if the cursor is farther away, preserve
        # the user's point so they can still add a missed region manually.
        image_w, image_h = self.image.size
        display_w = max(1, self.photo_size[0])
        radius = max(4, round(16 * image_w / display_w))
        px, py = round(point[0]), round(point[1])
        x0, x1 = max(0, px - radius), min(image_w, px + radius + 1)
        y0, y1 = max(0, py - radius), min(image_h, py + radius + 1)
        local = self.smart_boundary[y0:y1, x0:x1]
        ys, xs = np.nonzero(local)
        if len(xs) == 0:
            return point
        xs, ys = xs + x0, ys + y0
        nearest = int(np.argmin((xs - point[0]) ** 2 + (ys - point[1]) ** 2))
        return float(xs[nearest]), float(ys[nearest])

    @staticmethod
    def _mask_bbox(mask, threshold=20):
        array = np.asarray(mask, dtype=np.uint8)
        ys, xs = np.nonzero(array >= threshold)
        if len(xs) < 4:
            return None
        return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)

    def _cached_frame_mask(self, frame):
        with self._mask_scan_lock:
            if not self.frame_mask_cache:
                return None
            frame = max(0, round(float(frame)))
            closest = min(self.frame_mask_cache, key=lambda index: abs(index - frame))
            if abs(closest - frame) > max(1, self.mask_scan_interval):
                return None
            return self.frame_mask_cache[closest].copy()

    def _smart_mode_changed(self):
        if self.smart_select_mode.get():
            self.contour_mode.set(False)
            self.background_brush_mode.set(False)
            self.status.set('请在预览画面中点击要保留的人物；绿色区域是识别预览。')

    def _cancel_mask_scan(self, clear_cache=False):
        """Invalidate a scan and stop its FFmpeg decoder without blocking Tk."""
        with self._mask_scan_lock:
            self.mask_scan_generation += 1
            generation = self.mask_scan_generation
            if clear_cache:
                self.frame_mask_cache.clear()
            process = self._mask_scan_process
            self._mask_scan_process = None
        self.mask_scan_running = False
        if process is not None:
            try:
                if process.poll() is None:
                    process.terminate()
            except OSError:
                pass
        return generation

    def set_background_active(self, active):
        """Track page visibility; background jobs continue, hidden paints coalesce."""
        was_active = self._background_active
        self._background_active = bool(active)
        if self.embedded and self._background_active and not was_active and self._preview_render_pending:
            self._preview_render_pending = False
            try:
                self.window.after_idle(self._show_image)
            except tk.TclError:
                pass

    def shutdown_background_work(self):
        self._preview_cancel_event.set()
        self.preview_generation += 1
        self.selection_generation += 1
        self.loading_preview = False
        self.smart_selecting = False
        self._cancel_mask_scan(clear_cache=True)

    def _smart_select_worker(self, image, point, generation, repair_mode,
                             source, total_frames, scan_interval, scan_generation):
        try:
            if generation != self.selection_generation:
                return
            with self._mask_scan_lock:
                if scan_generation != self.mask_scan_generation:
                    return
            import onnxruntime as ort
            model = self._person_model_path()
            if not model.is_file():
                raise RuntimeError(f'找不到人物识别模型：{model}')
            options = ort.SessionOptions()
            session, _provider = _create_ort_session(ort, model, options)
            probability = _predict_person_probability(np.asarray(image, dtype=np.uint8), session)
            px = point[0] * probability.shape[1] / image.width
            py = point[1] * probability.shape[0] / image.height
            px = min(probability.shape[1] - 1, max(0.0, px))
            py = min(probability.shape[0] - 1, max(0.0, py))
            radius = max(4, min(probability.shape) // 12)
            y0, y1 = max(0, int(py) - radius), min(probability.shape[0], int(py) + radius + 1)
            x0, x1 = max(0, int(px) - radius), min(probability.shape[1], int(px) + radius + 1)
            if float(probability[int(py), int(px)]) < 0.12 and float(probability[y0:y1, x0:x1].max()) < 0.28:
                raise RuntimeError('点击位置附近没有识别到人物。请点在人物身体内部再试一次。')
            probability, _center = _select_human_component(probability, (px, py))
            mask = np.asarray(Image.fromarray(np.rint(np.clip(probability, 0, 1) * 255).astype(np.uint8))
                              .resize(image.size, Image.Resampling.BILINEAR), dtype=np.uint8)
            if generation != self.selection_generation:
                return
            with self._mask_scan_lock:
                if scan_generation != self.mask_scan_generation:
                    return
            self.events.put(('selection_preview', generation, repair_mode,
                             Image.fromarray(mask, 'L'), None, scan_generation))
            if not repair_mode:
                threading.Thread(target=self._scan_video_masks, args=(source, image.size, point,
                    probability.shape, total_frames, scan_interval, scan_generation),
                    daemon=True).start()
        except Exception as exc:
            self.events.put(('selection_preview', generation, repair_mode,
                             None, str(exc), scan_generation))

    def _scan_video_masks(self, source, frame_size, point, model_grid, total_frames,
                          scan_interval, scan_generation):
        """Segment every source frame in the background and retain compact masks for scrubbing."""
        process = None
        try:
            with self._mask_scan_lock:
                if scan_generation != self.mask_scan_generation:
                    return
            import onnxruntime as ort
            ffmpeg = shutil.which('ffmpeg')
            if not ffmpeg:
                raise RuntimeError('找不到 FFmpeg，无法生成逐帧人物预览。')
            model = self._person_model_path()
            options = ort.SessionOptions()
            session, _provider = _create_ort_session(ort, model, options)
            with self._mask_scan_lock:
                if scan_generation != self.mask_scan_generation:
                    return
            width, height = frame_size
            preview_scale = min(1.0, 384 / max(width, height))
            scan_width = max(2, round(width * preview_scale))
            scan_height = max(2, round(height * preview_scale))
            process = _popen_silent([ffmpeg, '-hide_banner', '-loglevel', 'error', '-i', str(source),
                '-vf', f'scale={scan_width}:{scan_height}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            with self._mask_scan_lock:
                if scan_generation != self.mask_scan_generation:
                    process.terminate()
                    return
                self._mask_scan_process = process
            frame_bytes = scan_width * scan_height * 3
            previous_center = (point[0] * model_grid[1] / width, point[1] * model_grid[0] / height)
            index = 0
            last_progress_at = 0.0
            while True:
                with self._mask_scan_lock:
                    if scan_generation != self.mask_scan_generation:
                        break
                raw = process.stdout.read(frame_bytes)
                if len(raw) != frame_bytes:
                    break
                is_sample = (index % max(1, scan_interval) == 0 or
                             (total_frames > 0 and index == total_frames - 1))
                if is_sample:
                    rgb = np.frombuffer(raw, dtype=np.uint8).reshape(scan_height, scan_width, 3)
                    probability = _predict_person_probability(rgb, session)
                    target = previous_center if index else (point[0] * probability.shape[1] / width,
                                                             point[1] * probability.shape[0] / height)
                    selected, center = _select_human_component(probability, target)
                    if center is not None:
                        previous_center = center
                    compact = np.asarray(Image.fromarray(np.rint(np.clip(selected, 0, 1) * 255).astype(np.uint8))
                                         .resize(PREVIEW_MASK_SIZE, Image.Resampling.BILINEAR), dtype=np.uint8)
                    with self._mask_scan_lock:
                        if scan_generation != self.mask_scan_generation:
                            break
                        self.frame_mask_cache[index] = compact
                        self.frame_mask_cache.move_to_end(index)
                        while len(self.frame_mask_cache) > MAX_PREVIEW_MASKS:
                            self.frame_mask_cache.popitem(last=False)
                    now = time.monotonic()
                    if index % max(8, scan_interval * 8) == 0 and now - last_progress_at >= 1.0:
                        self.events.put(('mask_scan_progress', scan_generation, index + 1))
                        last_progress_at = now
                index += 1
            self.events.put(('mask_scan_done', scan_generation, index))
        except Exception as exc:
            self.events.put(('mask_scan_error', scan_generation, str(exc)))
        finally:
            if process is not None:
                try:
                    if process.stdout:
                        process.stdout.close()
                except Exception:
                    pass
                try:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=1)
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
                with self._mask_scan_lock:
                    if self._mask_scan_process is process:
                        self._mask_scan_process = None

    def export(self):
        if not self.video.get():
            messagebox.showwarning('还没准备好', '请先选择视频。', parent=self.window)
            return
        repair_alpha = bool(self.repair_alpha_mode.get())
        edge_cleanup = bool(self.alpha_edge_cleanup.get())
        automatic_alpha_cleanup = repair_alpha and edge_cleanup and not self.smart_corrections
        if self.smart_select_mode.get() and (self.smart_seed is None or self.smart_mask is None) and not automatic_alpha_cleanup:
            messagebox.showwarning('先点选人物', '请先在预览画面中点击要保留的人物，看到绿色识别预览后再导出。', parent=self.window)
            return
        if not repair_alpha and not self.smart_select_mode.get() and not (self.bounds or self.contour_points):
            messagebox.showwarning('先标出抠图范围', '请先点击“智能选人”并点选人物，或切换到“粗略人物范围”标出要保留的区域，再导出。', parent=self.window)
            return
        if repair_alpha and (self.loaded_repair_mode is not True or self.repair_alpha is None):
            messagebox.showwarning('重新读取透明成片', '请在勾选成片修复模式后重新读取带 Alpha 通道的视频。', parent=self.window)
            return
        if repair_alpha and self.smart_corrections and (self.smart_seed is None or self.smart_reference_bbox is None):
            messagebox.showwarning('先建立人物跟踪', '请先在要修复的人物上点击一次，建立逐帧跟踪参考。', parent=self.window)
            return
        if repair_alpha and any(stroke['add'] for stroke in self.smart_corrections):
            messagebox.showwarning('先标出残留', '请使用“减去保留”笔刷在当前帧标出要擦除的背景残留。', parent=self.window)
            return
        if repair_alpha and not self.smart_corrections and not edge_cleanup:
            messagebox.showwarning('选择 Alpha 修复方式', '请启用“发丝边缘净化”，或点选人物并用“减去保留”笔刷标出残留。', parent=self.window)
            return
        try:
            source = Path(self.video.get()).expanduser().resolve(strict=True)
            source_info = source.stat()
        except (OSError, RuntimeError, ValueError):
            messagebox.showwarning('重新读取视频', '视频路径无效或文件已不存在，请重新选择并读取视频。', parent=self.window)
            return
        if not source.is_file():
            messagebox.showwarning('重新读取视频', '只能处理本地视频文件，请重新选择并读取视频。', parent=self.window)
            return
        source_key = self._source_key(source)
        if source_key in self.export_jobs:
            self.status.set('这个视频已经在抠图任务中。')
            return
        identity = (str(source), source_info.st_size, source_info.st_mtime_ns)
        if self.image is None or identity != self.loaded_source_identity or self.loaded_repair_mode is not repair_alpha:
            messagebox.showwarning('重新读取视频', '预览后视频路径或文件内容发生了变化，请重新读取视频再导出。', parent=self.window)
            return
        selected_format = self.export_format.get()
        compact = selected_format.startswith('小体积') and not repair_alpha
        prores = selected_format.startswith('ProRes') or repair_alpha
        extension = '.webm' if compact else '.mov'
        filetype = ('快速透明视频（WebM/VP8）', '*.webm') if compact else ('高质量透明视频（ProRes 4444）', '*.mov')
        output = filedialog.asksaveasfilename(parent=self.window, title='导出透明人物视频',
            initialfile=f'{source.stem}_修复版{extension}' if repair_alpha else f'{source.stem}_透明{extension}', defaultextension=extension,
            filetypes=[filetype])
        if not output:
            return
        output_path = Path(output)
        same_source = output_path.resolve() == source
        if output_path.exists():
            try:
                same_source = same_source or os.path.samefile(output_path, source)
            except OSError:
                pass
        if same_source:
            messagebox.showwarning('不能覆盖源视频', '请为透明视频选择一个新文件名。', parent=self.window)
            return
        if output_path.exists() and not messagebox.askyesno('覆盖文件', f'文件已存在，是否覆盖？\n{output_path}', parent=self.window):
            return
        # The subject-guided timeline preview can still be scanning sampled
        # frames. Pause it before export so it cannot compete with RVM for GPU
        # memory or CPU time; cached preview masks remain available.
        self._cancel_mask_scan(clear_cache=False)
        width, height = self.image.size
        preview_w, preview_h, offset_x, offset_y = self.photo_size
        if self.bounds and not self.smart_select_mode.get():
            x0, y0, x1, y1 = self.bounds
            left = max(0, min(width - 1, round((x0 - offset_x) * width / preview_w)))
            top = max(0, min(height - 1, round((y0 - offset_y) * height / preview_h)))
            right = max(left + 1, min(width, round((x1 - offset_x) * width / preview_w)))
            bottom = max(top + 1, min(height, round((y1 - offset_y) * height / preview_h)))
        else:
            left, top, right, bottom = 0, 0, width, height
        if self.contour_points:
            contour_x = [x for contour in self.contour_points for x, _ in contour]
            contour_y = [y for contour in self.contour_points for _, y in contour]
            left = min(left, max(0, int(min(contour_x))))
            top = min(top, max(0, int(min(contour_y))))
            right = max(right, min(width, int(max(contour_x)) + 1))
            bottom = max(bottom, min(height, int(max(contour_y)) + 1))
        # Treat hand marks as a loose subject hint, not a frame-locked cut line.
        # The generous padding lets the recurrent RVM matte follow normal movement.
        pad_x = max(48, int((right - left) * 0.35))
        pad_y = max(48, int((bottom - top) * 0.35))
        left, top = max(0, left - pad_x), max(0, top - pad_y)
        right, bottom = min(width, right + pad_x), min(height, bottom + pad_y)
        if right - left < 32 or bottom - top < 32:
            messagebox.showwarning('范围太小', '请把人物完整框入，并留出少量余量。', parent=self.window)
            return
        self.progress.configure(value=0, maximum=100)
        self.progress_text.set('准备导出…')
        self.cancel_event.clear()
        self.active_export_repair_alpha = repair_alpha
        self.active_export_edge_cleanup = edge_cleanup
        self.active_export_format = selected_format
        self.export_started_at = time.monotonic()
        self.progress_started_at = None
        self.progress_started_count = 0
        self.status.set('正在加载模型并准备人物轮廓…')
        contours = [list(points) for points in self.contour_points]
        background_strokes = [list(points) for points in self.background_strokes]
        smart_corrections = [{'points': list(stroke['points']), 'add': stroke['add'],
                              'radius': stroke['radius']} for stroke in self.smart_corrections]
        # Alpha-only edge cleanup does not need an expensive person-tracking pass.
        # Manual corrections still use the clicked-person seed to follow motion.
        smart_seed = (self.smart_seed if self.smart_mask is not None and
                      (not repair_alpha or smart_corrections) else None)
        # Smart-correction strokes, including erase marks, are mapped to the
        # current person on every frame. The separate background brush remains
        # scene-anchored for static furniture/background cleanup.
        smart_reference_bbox = self.smart_reference_bbox
        job = RotoscopeWindow.__new__(RotoscopeWindow)
        job.app = self.app
        job.events = queue.Queue()
        job.cancel_event = threading.Event()
        job.provider_name = 'CPU'
        self.export_jobs[source_key] = {'engine': job, 'cancel_event': job.cancel_event,
                                        'progress': 0.0, 'state': '排队中',
                                        'started_at': None, 'progress_started_at': None,
                                        'progress_started_count': 0,
                                        'progress_last_label_update': 0.0}
        self.is_exporting = True
        self.cancel_button.configure(state='normal')
        self.status.set('任务已加入后台队列。')
        if self.embedded and self.app:
            self.app.on_cutout_queued(source_key)
        self._sync_job_controls()

        args = (source, output_path, (left, top, right, bottom), self.image.size,
                contours, background_strokes, compact, smart_seed, prores,
                smart_corrections, smart_reference_bbox, repair_alpha, edge_cleanup)

        def run_job():
            semaphore = getattr(self.app, 'cutout_semaphore', None)
            acquired = False
            try:
                if semaphore:
                    while not job.cancel_event.is_set():
                        acquired = semaphore.acquire(timeout=0.2)
                        if acquired:
                            break
                if job.cancel_event.is_set():
                    self.events.put(('job_done', source_key, None, '', True, 0.0))
                    return
                started = time.monotonic()
                self.events.put(('job_started', source_key, started))
                worker = threading.Thread(target=job._export_worker, args=args, daemon=True)
                worker.start()
                while True:
                    event = job.events.get()
                    if event[0] == 'progress':
                        _, count, total, provider = event
                        self.events.put(('job_progress', source_key, count, total, provider))
                    elif event[0] == 'phase':
                        self.events.put(('job_phase', source_key, event[1]))
                    elif event[0] == 'done':
                        _, error, output, cancelled = event
                        self.events.put(('job_done', source_key, error, output, cancelled,
                                         time.monotonic() - started))
                        break
            except Exception as exc:
                self.events.put(('job_done', source_key, str(exc), str(output_path), False,
                                 0.0))
            finally:
                if semaphore and acquired:
                    semaphore.release()

        threading.Thread(target=run_job, daemon=True).start()

    def _model_path(self):
        app_root = Path(self.app.resource_dir) if self.app and hasattr(self.app, 'resource_dir') else (self.app.settings_path.parent if self.app else Path(__file__).resolve().parent.parent / 'dist')
        candidates = [app_root / 'matting_models' / 'rvm_mobilenetv3_fp32.onnx']
        if self.app and not getattr(sys, 'frozen', False):
            candidates.append(app_root.parent / 'matting_models' / 'rvm_mobilenetv3_fp32.onnx')
        bundle_root = getattr(sys, '_MEIPASS', None)
        if bundle_root:
            candidates.append(Path(bundle_root) / 'matting_models' / 'rvm_mobilenetv3_fp32.onnx')
        return next((path for path in candidates if path.is_file()), candidates[0])

    def _person_model_path(self, high_resolution=True):
        app_root = Path(self.app.resource_dir) if self.app and hasattr(self.app, 'resource_dir') else (self.app.settings_path.parent if self.app else Path(__file__).resolve().parent.parent / 'dist')
        model_name = 'human_segmentation_segformer_b0_ps_512.onnx'
        legacy_name = 'human_segmentation_pphumanseg_2023mar.onnx'
        names = (model_name, legacy_name) if high_resolution else (legacy_name, model_name)
        candidates = [app_root / 'matting_models' / name for name in names]
        candidates.extend(app_root.parent / 'matting_models' / name for name in names)
        if self.app and not getattr(sys, 'frozen', False):
            candidates.extend(app_root.parent / 'matting_models' / name for name in names)
        bundle_root = getattr(sys, '_MEIPASS', None)
        if bundle_root:
            candidates.extend(Path(bundle_root) / 'matting_models' / name for name in names)
        return next((path for path in candidates if path.is_file()), candidates[0])

    def _poll_events(self):
        if not self.window.winfo_exists():
            return
        try:
            while True:
                event = self.events.get_nowait()
                if event[0] == 'preview':
                    _, generation, image, error, source_identity, repair_alpha, fps, frame_count, at = event
                    if generation != self.preview_generation:
                        continue
                    self.loading_preview = False
                    timeline_seeking = self.timeline_seeking
                    self.timeline_seeking = False
                    self.path_entry.configure(state='readonly' if self.embedded else 'normal')
                    self.choose_button.configure(state='normal')
                    self.read_button.configure(state='normal')
                    if error:
                        self.status.set('读取画面失败。')
                        messagebox.showerror('读取失败', error, parent=self.window)
                    else:
                        self.sample_time.set(f'{at:.3f}')
                        self.video_fps = fps or 30.0
                        self.total_frames = frame_count
                        current_frame = max(0, min(max(0, frame_count - 1), round(at * self.video_fps)))
                        self.timeline.configure(to=max(0, frame_count - 1))
                        self.timeline_value.set(current_frame)
                        self._timeline_changed(current_frame)
                        same_source = (timeline_seeking and source_identity == self.loaded_source_identity
                                       and self.image is not None and repair_alpha == self.loaded_repair_mode)
                        self.loaded_repair_mode = repair_alpha
                        if repair_alpha:
                            self.repair_alpha = image.getchannel('A')
                            background = Image.new('RGB', image.size, '#55585c')
                            self.image = Image.composite(image.convert('RGB'), background, self.repair_alpha)
                        else:
                            self.repair_alpha = None
                            self.image = image
                        self.loaded_source_identity = source_identity
                        if not same_source:
                            self.zoom_factor = 1.0
                            self.bounds = None
                            self.contour_points.clear()
                            self.active_contour = None
                            self.smart_seed = None
                            self.smart_mask = None
                            self.smart_base_mask = None
                            self.smart_reference_bbox = None
                            self.smart_tracking_mask = None
                            self.smart_boundary = None
                            self.smart_corrections.clear()
                            self.active_smart_correction = None
                            self.smart_selecting = False
                            self.selection_generation += 1
                            with self._mask_scan_lock:
                                self.frame_mask_cache.clear()
                        self._show_image()
                        cached = self._cached_frame_mask(current_frame) if not repair_alpha else None
                        if cached is not None:
                            self.smart_base_mask = Image.fromarray(cached, 'L').resize(self.image.size, Image.Resampling.BILINEAR)
                            self.smart_mask = self.smart_base_mask.copy()
                            self._apply_smart_corrections_to_preview()
                            self._show_image()
                        elif same_source and not repair_alpha and self.smart_seed is not None:
                            # Never leave the previous frame's subject matte on
                            # screen when a sampled frame is not available yet.
                            self.smart_base_mask = None
                            self.smart_mask = None
                            self._show_image()
                        if repair_alpha:
                            self.smart_base_mask = self.repair_alpha.copy()
                            self.smart_mask = self.repair_alpha.copy()
                            self._show_image()
                            self.status.set('透明成片已读取。导出时会收紧现有 Alpha 外沿；要删局部残留时，可点选人物后用“减去保留”。')
                        else:
                            self.status.set('视频已读取，尚未开始抠图。点击人物身体内部一点后，才会识别人物并生成预览。')
                elif event[0] == 'selection_preview':
                    _, generation, repair_mode, mask, error, scan_generation = event
                    if generation != self.selection_generation:
                        continue
                    self.smart_selecting = False
                    if repair_mode != bool(self.repair_alpha_mode.get()):
                        continue
                    if error:
                        self.smart_seed = None
                        self.smart_mask = None
                        self.smart_base_mask = None
                        self.smart_reference_bbox = None
                        self.smart_tracking_mask = None
                        self.smart_boundary = None
                        self.status.set('智能选人失败。')
                        messagebox.showwarning('智能选人', error, parent=self.window)
                    else:
                        if not repair_mode and scan_generation == self.mask_scan_generation:
                            self.mask_scan_running = True
                        if self.repair_alpha_mode.get():
                            self.smart_tracking_mask = mask.copy()
                            self.smart_base_mask = self.repair_alpha.copy()
                            self.smart_mask = self.repair_alpha.copy()
                            self.smart_reference_bbox = self._mask_bbox(mask)
                        else:
                            self.smart_base_mask = mask.copy()
                            self.smart_mask = mask
                        self._apply_smart_corrections_to_preview()
                        if not self.repair_alpha_mode.get():
                            cached = self._cached_frame_mask(self.timeline_value.get())
                            if cached is not None:
                                self.smart_base_mask = Image.fromarray(cached, 'L').resize(self.image.size, Image.Resampling.BILINEAR)
                                self.smart_mask = self.smart_base_mask.copy()
                                self._apply_smart_corrections_to_preview()
                        if self.repair_alpha_mode.get():
                            self.status.set('已建立人物跟踪。修正笔会跟随每帧人物移动；导出只改 Alpha，不重新运行 RVM。')
                        else:
                            self.status.set('人物已识别。绿色为逐帧人像模型的预览区域；导出时会继续沿视频识别并由 RVM 细化边缘。')
                    self._show_image()
                elif event[0] == 'mask_scan_progress':
                    _, scan_generation, count = event
                    if scan_generation == self.mask_scan_generation and self.mask_scan_running:
                        self.status.set(f'后台生成时间轴预览蒙版（尚未导出）：{count:,} 帧；时间轨可继续拖动。')
                elif event[0] == 'mask_scan_done':
                    _, scan_generation, count = event
                    if scan_generation == self.mask_scan_generation:
                        self.mask_scan_running = False
                        self.status.set(f'时间轴预览蒙版已就绪：{count:,} 帧。点击“导出透明视频”后才开始正式抠图。')
                elif event[0] == 'mask_scan_error':
                    _, scan_generation, error = event
                    if scan_generation == self.mask_scan_generation:
                        self.mask_scan_running = False
                        self.status.set(f'全片蒙版后台识别失败：{error}')
                elif event[0] == 'progress':
                    _, count, total, provider = event
                    now = time.monotonic()
                    if self.progress_started_at is None:
                        self.progress_started_at = now
                        self.progress_started_count = count
                    percent, summary = self._progress_summary(
                        count, total, self.export_started_at, self.progress_started_at,
                        self.progress_started_count, now)
                    percent = max(float(self.progress['value']), percent)
                    if self.embedded and self.app:
                        self.app.on_cutout_progress(self.video.get(), percent, count, total)
                    self.progress.configure(value=percent)
                    total_text = f'{total:,}' if total else '未知'
                    self.progress_text.set(summary)
                    action = '修复 Alpha' if self.active_export_repair_alpha else '抠像'
                    self.status.set(f'{action}中 {count:,}/{total_text} 帧 · {provider}')
                elif event[0] == 'job_started':
                    _, source, started = event
                    job_state = self.export_jobs.get(source)
                    if job_state:
                        job_state['state'] = '处理中'
                        job_state['started_at'] = started
                        job_state['progress_last_label_update'] = 0.0
                    if self.embedded and self.app:
                        self.app.on_cutout_started(source)
                    if self._is_current_source(source):
                        self.progress_text.set('加载模型并准备视频…')
                        self.status.set('正在加载模型并准备人物轮廓…')
                elif event[0] == 'job_progress':
                    _, source, count, total, provider = event
                    job_state = self.export_jobs.get(source)
                    percent = min(100, count * 100 / total) if total else 0.0
                    if job_state:
                        job_state['progress'] = percent
                    if self.embedded and self.app:
                        self.app.on_cutout_progress(source, percent, count, total)
                    if self._is_current_source(source):
                        now = time.monotonic()
                        if job_state and job_state['progress_started_at'] is None:
                            job_state['progress_started_at'] = now
                            job_state['progress_started_count'] = count
                        percent, summary = self._progress_summary(
                            count, total, (job_state or {}).get('started_at'),
                            (job_state or {}).get('progress_started_at'),
                            (job_state or {}).get('progress_started_count', count), now)
                        percent = max(float(self.progress['value']), percent)
                        if job_state:
                            job_state['progress'] = percent
                        self.progress.configure(value=percent)
                        last_label_update = (job_state or {}).get('progress_last_label_update', 0.0)
                        if not last_label_update or now - last_label_update >= 2.5 or percent >= 100:
                            self.progress_text.set(summary)
                            self.status.set(f'抠图处理中 {count:,}/{total:,} 帧 · {provider}' if total else f'抠图处理中 · {provider}')
                            if job_state:
                                job_state['progress_last_label_update'] = now
                elif event[0] == 'job_phase':
                    _, source, phase = event
                    job_state = self.export_jobs.get(source)
                    if job_state:
                        job_state['state'] = '正在收尾'
                    if self._is_current_source(source):
                        self.progress_text.set(f'{self.progress["value"]:.1f}% · 正在收尾')
                        self.status.set(phase)
                elif event[0] == 'job_done':
                    _, source, error, output, cancelled, elapsed = event
                    self.export_jobs.pop(source, None)
                    self.is_exporting = bool(self.export_jobs)
                    if self.embedded and self.app:
                        self.app.on_cutout_done(source, error, output, cancelled)
                    if self._is_current_source(source):
                        if error or cancelled:
                            self.progress_text.set('已取消' if cancelled else '抠图失败')
                            self.status.set('已取消抠图' if cancelled else f'抠图失败：{error}')
                        else:
                            self.progress.configure(value=100)
                            self.progress_text.set(f'100% · 完成 · 用时 {self._format_remaining(elapsed)}')
                            self.status.set(f'抠图完成：{Path(output).name}')
                        if not self.embedded and not self.close_when_finished:
                            if error and not cancelled:
                                messagebox.showerror('人物抠像失败', error, parent=self.window)
                            elif not error and not cancelled:
                                messagebox.showinfo('导出完成', f'透明视频已保存：\n{output}', parent=self.window)
                    self._sync_job_controls()
                    if self.close_when_finished and not self.is_exporting:
                        self._destroy_window()
                elif event[0] == 'status':
                    self.status.set(event[1])
                elif event[0] == 'phase':
                    self.progress_text.set(f'{self.progress["value"]:.1f}% · 正在收尾')
                    self.status.set(event[1])
                elif event[0] == 'done':
                    _, error, output, cancelled = event
                    self._export_done(error, output, cancelled)
        except queue.Empty:
            pass
        if self.window.winfo_exists():
            active_work = (self.is_exporting or self.loading_preview or self.smart_selecting
                           or (self.mask_scan_running and self._background_active))
            # Hidden pages still drain progress and completion events, just at
            # a lower UI cadence. Compute continues in its worker threads.
            self.window.after(100 if active_work else 450, self._poll_events)

    @staticmethod
    def _format_remaining(seconds):
        seconds = max(0, int(seconds + 0.5))
        hours, remainder = divmod(seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours:
            return f'{hours}小时{minutes:02d}分'
        if minutes:
            return f'{minutes}分{seconds:02d}秒'
        return f'{seconds}秒'

    @staticmethod
    def _source_key(path):
        """Normalize local paths so slash and case differences still match."""
        return os.path.normcase(str(Path(path).expanduser().resolve(strict=False)))

    def _is_current_source(self, path):
        try:
            return self._source_key(path) == self._source_key(self.video.get())
        except (OSError, RuntimeError, TypeError, ValueError):
            return False

    @classmethod
    def _progress_summary(cls, count, total, started_at, sample_started_at,
                          sample_started_count, now=None):
        now = time.monotonic() if now is None else now
        percent = min(100.0, count * 100 / total) if total else 0.0
        if sample_started_at is None:
            sample_started_at, sample_started_count = now, count
        measured_seconds = now - sample_started_at
        measured_frames = max(0, count - sample_started_count)
        current_fps = measured_frames / measured_seconds if measured_seconds > 0 else 0.0
        if total and count >= 90 and measured_seconds >= 10 and measured_frames:
            eta = cls._format_remaining(max(0, (total - count) * measured_seconds / measured_frames))
        else:
            eta = '模型预热中' if count < 90 else '正在测算速度'
        speed = f'{current_fps:.1f}帧/秒' if current_fps else '测算速度中'
        elapsed = cls._format_remaining(now - started_at) if started_at else '0秒'
        if total:
            return percent, f'{percent:.1f}% · {speed} · 已用 {elapsed} · 预计剩余 {eta}'
        return percent, f'已处理 {count:,} 帧 · {speed} · 已用 {elapsed}'

    def _export_done(self, error, output, cancelled=False):
        if not self.window.winfo_exists():
            return
        elapsed = (time.monotonic() - self.export_started_at) if self.export_started_at else None
        self.is_exporting = False
        self.export_started_at = None
        self.progress_started_at = None
        self.export_button.configure(state='normal')
        self.cancel_button.configure(state='disabled')
        if error:
            self.progress_text.set('已取消' if cancelled else '导出失败')
            self.status.set('导出失败。')
            if cancelled:
                self.status.set('已取消抠像。')
            elif self.embedded:
                self.status.set(f'抠图失败：{error}')
            else:
                messagebox.showerror('人物抠像失败', error, parent=self.window)
            if self.embedded and self.app:
                self.app.on_cutout_done(self.video.get(), error, '', cancelled)
        else:
            self.progress.configure(value=100)
            self.progress_text.set(f'100% · 完成 · 用时 {self._format_remaining(elapsed)}' if elapsed is not None else '100% · 完成')
            self.status.set(f'导出完成：{output}')
            format_text = (('ProRes 4444 MOV（收紧现有 Alpha 外沿残边）' if self.active_export_edge_cleanup
                            else 'ProRes 4444 MOV（仅应用手动修正）') if self.active_export_repair_alpha
                           else ('WebM / VP8（含 Alpha，快速压缩；不建议用于 DaVinci）' if Path(output).suffix.lower() == '.webm'
                                 else ('FFV1 MOV（无损 RGBA，DaVinci 可读 Alpha）' if self.active_export_format.startswith('DaVinci FFV1')
                                       else 'ProRes 4444 MOV（含 Alpha，高质量）')))
            if self.embedded:
                self.status.set(f'抠图完成：{Path(output).name} · {format_text}')
                if self.app:
                    self.app.on_cutout_done(self.video.get(), '', output, False)
            else:
                messagebox.showinfo('导出完成', f'透明视频已保存：\n{output}\n\n格式：{format_text}', parent=self.window)
        if self.close_when_finished:
            self._destroy_window()

    def _export_worker(self, source, output, roi, frame_size, contour_points=(), background_strokes=(), compact=False, smart_seed=None, prores=False, smart_corrections=(), smart_reference_bbox=None, repair_alpha=False, edge_cleanup=True):
        temporary_output = None
        try:
            fd, temporary_name = tempfile.mkstemp(prefix='.rotoscope-', suffix=output.suffix,
                                                  dir=str(output.parent))
            os.close(fd)
            temporary_output = Path(temporary_name)
            self._run_matting(source, temporary_output, roi, frame_size, contour_points, background_strokes, compact, smart_seed, prores,
                              smart_corrections, smart_reference_bbox, repair_alpha, edge_cleanup)
            # Commit only a verified complete render. A failed or cancelled
            # export must never truncate/delete the user's previous file.
            os.replace(temporary_output, output)
        except Exception as exc:
            if temporary_output is not None:
                temporary_output.unlink(missing_ok=True)
            self.events.put(('done', str(exc), output, self.cancel_event.is_set()))
        else:
            self.events.put(('done', None, output, False))

    def _run_matting(self, source, output, roi, frame_size, contour_points=(), background_strokes=(), compact=False, smart_seed=None, prores=False, smart_corrections=(), smart_reference_bbox=None, repair_alpha=False, edge_cleanup=True):
        ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        if not ffmpeg or not ffprobe:
            raise RuntimeError('需要安装 FFmpeg（含 ffprobe），并将它加入 PATH。')
        # Existing-alpha repair uses the supplied matte directly; normal
        # cutout mode predicts a new matte from RGB with RVM.
        model = self._model_path() if not repair_alpha else None
        if not repair_alpha and not model.is_file():
            raise RuntimeError(f'找不到人物分割模型：{model}\n请重新运行模型安装/打包流程。')
        use_person_model = smart_seed is not None or bool(background_strokes)
        # Use the same person guide in the preview and export so the selected
        # subject stays consistent. RVM uses a larger input for edge cleanup
        # to retain more hair detail on portrait footage.
        person_model = self._person_model_path(high_resolution=False) if use_person_model else None
        if use_person_model and not person_model.is_file():
            raise RuntimeError(f'找不到自动人像识别模型：{person_model}\n请重新运行模型安装/打包流程。')
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise RuntimeError('缺少 ONNX Runtime。请运行源码\安装依赖.bat 后重启应用。') from exc

        if hasattr(ort, 'preload_dlls'):
            try:
                ort.preload_dlls()
            except Exception:
                pass
        metadata = _run_silent([ffprobe, '-v', 'error', '-protocol_whitelist', 'file,crypto,data',
            '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,pix_fmt', '-show_entries',
            'format=duration', '-of', 'json', str(source)],
            capture_output=True, check=True, text=True, encoding='utf-8', errors='replace')
        stream = json.loads(metadata.stdout)['streams'][0]
        if repair_alpha and not any(token in stream.get('pix_fmt', '')
                                    for token in ('yuva', 'rgba', 'bgra', 'argb', 'abgr', 'gbrap', 'ya')):
            raise RuntimeError('所选视频没有 Alpha 通道。请确认输入的是已经抠好的透明成片。')
        # ffmpeg autorotates smartphone footage during both preview and decode.
        width, height = frame_size
        num, den = stream['r_frame_rate'].split('/')
        fps = float(num) / max(1, float(den))
        if not (0 < fps < 241):
            fps = 30.0
        duration = float(json.loads(metadata.stdout).get('format', {}).get('duration') or 0)
        total_frames = max(0, math.ceil(duration * fps))
        left, top, right, bottom = roi
        right, bottom = min(right, width), min(bottom, height)
        crop_w, crop_h = right - left, bottom - top
        inference_long_side = 1024.0 if edge_cleanup else 512.0
        inference_scale = min(inference_long_side / max(crop_w, crop_h), 1.0)
        inference_w = max(1, round(crop_w * inference_scale))
        inference_h = max(1, round(crop_h * inference_scale))
        session_options = ort.SessionOptions()
        session = None
        active_provider = 'CPUExecutionProvider'
        if not repair_alpha:
            session, active_provider = _create_ort_session(ort, model, session_options)
            self.provider_name = _provider_label(active_provider)
        person_session = None
        person_h = person_w = 512
        # Re-evaluate the selected high-resolution contour on every frame so
        # the tracked silhouette does not jump between periodic refreshes.
        # Full matting refreshes the person guide periodically for speed;
        # alpha-only repair tracks the selected person on every frame.
        person_interval = 1 if repair_alpha else 4
        background_interval = 2
        person_provider = active_provider
        if use_person_model:
            person_session, person_provider = _create_ort_session(ort, person_model, session_options)
            if repair_alpha:
                self.provider_name = f'仅修 Alpha · 跟踪 {_provider_label(person_provider)}'
            else:
                if person_provider != active_provider:
                    self.provider_name = f'RVM {_provider_label(active_provider)} / 人像识别 {_provider_label(person_provider)}'
            person_shape = person_session.get_inputs()[0].shape
            person_h = int(person_shape[-2]) if isinstance(person_shape[-2], int) else 192
            person_w = int(person_shape[-1]) if isinstance(person_shape[-1], int) else 192
        # The input was resized to RVM's effective side above, so no second
        # model-side resize is needed. RVM still updates the matte on every frame.
        ratio = 1.0
        matting_interval = 1
        states = [np.zeros((1, 1, 1, 1), dtype=np.float32) for _ in range(4)]
        state_device_type = {'CUDAExecutionProvider': 'cuda', 'DmlExecutionProvider': 'dml'}.get(active_provider)
        use_gpu_state_binding = session is not None and state_device_type is not None
        state_binding = None
        device_states = None
        last_rvm_alpha = None
        last_rvm_fgr = None
        alpha_window = np.ones((crop_h, crop_w), dtype=np.float32)
        alpha_window_active = (top > 0 or bottom < height or left > 0 or right < width)
        feather = min(12, max(1, min(crop_h, crop_w) // 30))
        if top > 0:
            alpha_window *= np.clip(np.arange(crop_h, dtype=np.float32)[:, None] / feather, 0, 1)
        if bottom < height:
            alpha_window *= np.clip(np.arange(crop_h - 1, -1, -1, dtype=np.float32)[:, None] / feather, 0, 1)
        if left > 0:
            alpha_window *= np.clip(np.arange(crop_w, dtype=np.float32)[None, :] / feather, 0, 1)
        if right < width:
            alpha_window *= np.clip(np.arange(crop_w - 1, -1, -1, dtype=np.float32)[None, :] / feather, 0, 1)
        contour_mask = Image.new('L', (crop_w, crop_h), 0)
        if contour_points:
            draw = ImageDraw.Draw(contour_mask)
            for contour in contour_points:
                polygon = [(round(x - left), round(y - top)) for x, y in contour]
                if len(polygon) >= 3:
                    draw.polygon(polygon, fill=255)
            # Supersample the rough hand-drawn subject-area guide before expansion.
            contour_mask = contour_mask.resize((crop_w * 2, crop_h * 2), Image.Resampling.NEAREST)
            contour_mask = contour_mask.resize((crop_w, crop_h), Image.Resampling.LANCZOS)
        # Expand the rough hand-drawn subject outline so it guides the work area
        # without freezing the final silhouette to the reference frame.
        if contour_points:
            expand = max(25, min(crop_w, crop_h) // 18)
            kernel = expand * 2 + 1
            contour_mask = contour_mask.filter(ImageFilter.MaxFilter(kernel))
            contour_mask = contour_mask.filter(ImageFilter.GaussianBlur(max(1.0, expand / 5)))
        contour_alpha = np.asarray(contour_mask, dtype=np.float32) / 255.0
        # Keep the semantic guide soft so it protects uncertain hair and
        # clothing boundaries; the lightweight guide now refreshes each frame.
        person_gate_lut = [round(max(0.0, min(1.0, (value / 255.0 - 0.06) / 0.30)) * 255)
                           for value in range(256)]
        person_guide = None
        semantic_gate = None
        person_core = None
        current_person_probability = None
        selected_person_probability = None
        background_cut = None
        tracking_center = None
        if smart_seed is not None:
            tracking_center = (smart_seed[0] * person_w / width, smart_seed[1] * person_h / height)

        failure = None
        decoder_log = tempfile.TemporaryFile()
        decode_pix_fmt = 'rgba64le' if repair_alpha else 'rgb24'
        decoder = _popen_silent([ffmpeg, '-hide_banner', '-loglevel', 'warning',
            '-protocol_whitelist', 'file,crypto,data', '-i', str(source), '-map', '0:v:0',
            '-vf', f'fps={fps:.8f}', '-f', 'rawvideo', '-pix_fmt', decode_pix_fmt, 'pipe:1'], stdout=subprocess.PIPE, stderr=decoder_log)
        encoder = None
        encoder_log = tempfile.TemporaryFile()
        frame_bytes = width * height * (8 if repair_alpha else 3)
        count = 0
        frame_queue = queue.Queue(maxsize=2)
        processing_queue = queue.Queue(maxsize=2)
        writer_errors = []
        processing_errors = []
        writer_thread = None
        processing_thread = None

        def encode_queued_frames():
            try:
                while True:
                    payload = frame_queue.get()
                    if payload is None:
                        break
                    if writer_errors:
                        continue
                    try:
                        encoder.stdin.write(payload)
                    except Exception as exc:
                        writer_errors.append(exc)
            finally:
                try:
                    encoder.stdin.close()
                except Exception:
                    pass

        def process_queued_frames():
            """Build output RGBA frames while the main thread runs the next RVM frame."""
            worker_background_cut = None
            while True:
                item = processing_queue.get()
                if item is None:
                    break
                if processing_errors:
                    continue
                try:
                    frame_number, rgb, rvm_alpha, rvm_fgr, frame_gate, person_probs = item
                    alpha = np.clip(rvm_alpha, 0, 1).astype(np.float32, copy=True)
                    if not repair_alpha:
                        if alpha.shape != (crop_h, crop_w):
                            alpha = np.asarray(Image.fromarray(alpha, mode='F').resize(
                                (crop_w, crop_h), Image.Resampling.BILINEAR), dtype=np.float32).copy()
                        if alpha_window_active:
                            np.multiply(alpha, alpha_window, out=alpha)
                        if frame_gate is not None:
                            if frame_gate.shape != alpha.shape:
                                raise RuntimeError(f'人物遮罩和处理区域尺寸不一致：{frame_gate.shape} / {alpha.shape}')
                            np.multiply(alpha, frame_gate, out=alpha)
                        if contour_points:
                            np.multiply(alpha, contour_alpha, out=alpha)
                        if background_strokes:
                            if worker_background_cut is None or frame_number % background_interval == 0:
                                worker_background_cut = _seeded_background_mask(
                                    rgb, background_strokes, (person_w, person_h), person_probs, roi)
                            if worker_background_cut is not None:
                                np.multiply(alpha, 1.0 - worker_background_cut, out=alpha)
                        offset, scale = (0.08, 0.84) if frame_gate is not None else (0.25, 0.50)
                        edge = np.empty_like(alpha)
                        np.subtract(alpha, offset, out=edge)
                        edge /= scale
                        np.clip(edge, 0.0, 1.0, out=edge)
                        np.multiply(edge, edge, out=alpha)
                        edge *= -2.0
                        edge += 3.0
                        np.multiply(alpha, edge, out=alpha)
                    add_mask = subtract_keep = None
                    if smart_corrections and person_probs is not None:
                        # Use the current selected-person segmentation, rather
                        # than the previous frame's matte box, to move a manual
                        # add prompt with the subject's actual screen position.
                        add_mask, subtract_keep = _render_smart_corrections(
                            smart_corrections, smart_reference_bbox, person_probs,
                            (width, height), roi, tracking_threshold=0.35,
                            constrain_to_person=not repair_alpha)
                    if add_mask is not None and not repair_alpha:
                        np.maximum(alpha, add_mask, out=alpha)
                    if subtract_keep is not None:
                        np.multiply(alpha, subtract_keep, out=alpha)
                    if edge_cleanup:
                        _tighten_alpha_edges(alpha, repair_alpha=repair_alpha)
                    rgb_crop = rgb[top:bottom, left:right]
                    if rvm_fgr is not None and not repair_alpha:
                        # RVM predicts an uncontaminated foreground color as
                        # well as alpha. Use that color only on partially
                        # transparent edge pixels, where the source RGB still
                        # contains the old bright background. Keep the source
                        # RGB inside the opaque subject for maximum sharpness.
                        foreground = rvm_fgr
                        if foreground.shape[:2] != (crop_h, crop_w):
                            foreground = np.asarray(Image.fromarray(foreground, 'RGB').resize(
                                (crop_w, crop_h), Image.Resampling.BILINEAR))
                        foreground = foreground.astype(np.float32)
                        if repair_alpha:
                            foreground *= 257.0
                        edge_weight = np.clip((0.99 - alpha) / 0.22, 0.0, 1.0)
                        if add_mask is not None:
                            np.multiply(edge_weight, 1.0 - add_mask, out=edge_weight)
                        if subtract_keep is not None:
                            np.multiply(edge_weight, subtract_keep, out=edge_weight)
                        edge_weight = edge_weight[:, :, None]
                        color_max = 65535.0 if repair_alpha else 255.0
                        color_dtype = np.uint16 if repair_alpha else np.uint8
                        rgb_crop = np.asarray(np.rint(np.clip(
                            rgb_crop.astype(np.float32) * (1.0 - edge_weight) +
                            foreground * edge_weight, 0.0, color_max)), dtype=color_dtype)
                    if left == 0 and top == 0 and right == width and bottom == height:
                        rgba = np.empty((height, width, 4), dtype=np.uint16 if repair_alpha else np.uint8)
                        rgba[:, :, :3] = rgb_crop
                    else:
                        rgba = np.zeros((height, width, 4), dtype=np.uint8)
                        rgba[top:bottom, left:right, :3] = rgb_crop
                    np.multiply(alpha, 65535.0 if repair_alpha else 255.0, out=alpha)
                    np.rint(alpha, out=alpha)
                    rgba[top:bottom, left:right, 3] = alpha
                    frame_queue.put(memoryview(rgba).cast('B'))
                except Exception as exc:
                    processing_errors.append(exc)

        try:
            encode_options = (['-c:v', 'prores_ks', '-profile:v', '4', '-quant_mat', '2',
                               '-pix_fmt', 'yuva444p12le', '-alpha_bits', '16', '-c:a', 'copy'] if repair_alpha else
                              (['-c:v', 'libvpx', '-pix_fmt', 'yuva420p', '-crf', '20', '-b:v', '0',
                               '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0',
                               '-metadata:s:v:0', 'alpha_mode=1', '-c:a', 'libopus', '-b:a', '128k'] if compact else
                              (['-c:v', 'prores_ks', '-profile:v', '4', '-quant_mat', '2', '-pix_fmt', 'yuva444p10le',
                               '-alpha_bits', '16', '-c:a', 'aac', '-b:a', '192k'])
                               if prores else
                               ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgra', '-slicecrc', '1',
                                '-c:a', 'aac', '-b:a', '192k']))
            encoder = _popen_silent([ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format',
                'rgba64le' if repair_alpha else 'rgba', '-video_size', f'{width}x{height}', '-framerate', f'{fps:.8f}', '-protocol_whitelist', 'pipe',
                '-i', 'pipe:0', '-protocol_whitelist', 'file,crypto,data', '-i', str(source),
                '-map', '0:v:0', '-map', '1:a?', *encode_options, str(output)],
                stdin=subprocess.PIPE, stderr=encoder_log)
            if compact:
                self._check_vp9_alpha(ffmpeg, ffprobe, source, fps, output.parent)
            writer_thread = threading.Thread(target=encode_queued_frames, daemon=True)
            writer_thread.start()
            processing_thread = threading.Thread(target=process_queued_frames, daemon=True)
            processing_thread.start()
            while True:
                if self.cancel_event.is_set():
                    raise RuntimeError('已取消抠像')
                if writer_errors:
                    raise RuntimeError(f'FFmpeg 编码输入失败：{writer_errors[0]}')
                if processing_errors:
                    raise RuntimeError(f'遮罩合成失败：{processing_errors[0]}')
                raw = decoder.stdout.read(frame_bytes)
                if not raw:
                    break
                if len(raw) != frame_bytes:
                    raise RuntimeError('读取视频时遇到不完整帧。')
                if repair_alpha:
                    rgba_source = np.frombuffer(raw, np.uint16).reshape(height, width, 4)
                    output_rgb = rgba_source[:, :, :3]
                    rgb = (output_rgb >> 8).astype(np.uint8)
                    last_rvm_alpha = rgba_source[top:bottom, left:right, 3].astype(np.float32) / 65535.0
                    last_rvm_fgr = None
                else:
                    rgb = np.frombuffer(raw, np.uint8).reshape(height, width, 3)
                    output_rgb = rgb
                # Semantic person segmentation rejects furniture/background per frame;
                # RVM below then restores fine hair and semi-transparent edge detail.
                # Match the selected model's documented preprocessing.
                # Keep RVM recurrent inference on every frame. The optional
                # click-to-select semantic tracker runs only in smart mode and
                # refreshes its motion-following guide periodically.
                if use_person_model and (current_person_probability is None or (count % person_interval) == 0):
                    current_person_probability = _predict_person_probability(rgb, person_session)
                    if smart_seed is not None and not repair_alpha:
                        person_probability, tracking_center = _select_human_component(current_person_probability, tracking_center)
                        selected_person_probability = person_probability
                        small_guide = Image.fromarray(np.clip(person_probability * 255, 0, 255).astype(np.uint8))
                        small_guide = small_guide.point(person_gate_lut)
                        # Expand the soft guide slightly so RVM can retain hair
                        # and shoulder detail at the model's uncertain boundary.
                        # Leave a wider semantic safety margin around the
                        # selected subject. RVM still computes a fresh matte
                        # every frame; this margin prevents a low-confidence
                        # wrist/hand edge from being hard-clipped by the guide.
                        motion_safe_guide = small_guide.filter(ImageFilter.MaxFilter(9))
                        guide_box = (round(left * person_w / width), round(top * person_h / height),
                                     round(right * person_w / width), round(bottom * person_h / height))
                        person_guide = small_guide.crop(guide_box).resize((crop_w, crop_h), Image.Resampling.BILINEAR)
                        safe_core = motion_safe_guide.crop(guide_box).resize((crop_w, crop_h), Image.Resampling.BILINEAR)
                        person_core = np.asarray(safe_core.filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float32) / 255.0
                        person_alpha = np.asarray(person_guide, dtype=np.float32) / 255.0
                        semantic_gate = np.maximum(person_core, person_alpha)
                        # The per-frame semantic model can briefly label a
                        # moving hand or shoulder as background. Keep a soft,
                        # wider support zone around the selected person so the
                        # recurrent RVM matte can carry those uncertain edges
                        # through the frame instead of multiplying them to 0.
                        # This is only a partial gate; RVM's own alpha remains
                        # responsible for rejecting background pixels.
                        # Keep a modest motion margin around the semantic
                        # silhouette, but avoid carrying broad background
                        # regions into the matte when the subject overlaps
                        # nearby objects. This is relative to the detected
                        # person and works regardless of scene or position.
                        hand_support = small_guide.filter(ImageFilter.MaxFilter(31))
                        hand_support = hand_support.crop(guide_box).resize(
                            (crop_w, crop_h), Image.Resampling.BILINEAR
                        ).filter(ImageFilter.GaussianBlur(6.0))
                        hand_support = np.asarray(hand_support, dtype=np.float32) / 255.0
                        np.maximum(semantic_gate, hand_support * 0.38, out=semantic_gate)
                    elif smart_seed is not None:
                        person_probability, tracking_center = _select_human_component(
                            current_person_probability, tracking_center)
                        selected_person_probability = person_probability
                cropped = np.ascontiguousarray(rgb[top:bottom, left:right])
                # RVM is used only when creating a matte from an opaque source.
                # Existing-alpha repair keeps the supplied matte and tightens
                # its edge in the processing worker.
                if not repair_alpha and (last_rvm_alpha is None or count % matting_interval == 0):
                    if inference_scale < 1.0:
                        model_frame = np.asarray(Image.fromarray(cropped).resize(
                            (inference_w, inference_h), Image.Resampling.BILINEAR))
                    else:
                        model_frame = cropped
                    src = model_frame.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
                    feed = {'src': src, 'r1i': states[0], 'r2i': states[1], 'r3i': states[2], 'r4i': states[3],
                            'downsample_ratio': np.array([ratio], np.float32)}
                    if use_gpu_state_binding:
                        try:
                            if device_states is None:
                                device_states = [ort.OrtValue.ortvalue_from_numpy(state, state_device_type, 0)
                                                 for state in states]
                            # A fresh binding keeps DirectML recurrent state
                            # outputs alive as inputs to the next frame. Clearing
                            # and reusing one binding invalidates these GPU buffers.
                            state_binding = session.io_binding()
                            state_binding.bind_cpu_input('src', src)
                            state_binding.bind_cpu_input('downsample_ratio', feed['downsample_ratio'])
                            for name, state in zip(('r1i', 'r2i', 'r3i', 'r4i'), device_states):
                                state_binding.bind_ortvalue_input(name, state)
                            state_binding.bind_output('pha', 'cpu')
                            state_binding.bind_output('fgr', 'cpu')
                            for name in ('r1o', 'r2o', 'r3o', 'r4o'):
                                state_binding.bind_output(name, state_device_type, device_id=0)
                            session.run_with_iobinding(state_binding)
                            results = state_binding.get_outputs()
                            pha_result, fgr_result = results[0].numpy(), results[1].numpy()
                            device_states = results[2:]
                        except Exception:
                            # Keep the normal ONNX Runtime path as a fallback
                            # for GPUs or DirectML builds without I/O binding.
                            if device_states is not None:
                                states = [state.numpy() for state in device_states]
                                feed.update(zip(('r1i', 'r2i', 'r3i', 'r4i'), states))
                            use_gpu_state_binding = False
                            state_binding = None
                            results = session.run(['pha', 'fgr', 'r1o', 'r2o', 'r3o', 'r4o'], feed)
                            pha_result, fgr_result = results[0], results[1]
                            states = results[2:]
                    else:
                        results = session.run(['pha', 'fgr', 'r1o', 'r2o', 'r3o', 'r4o'], feed)
                        pha_result, fgr_result = results[0], results[1]
                        states = results[2:]
                    last_rvm_alpha = np.clip(pha_result[0, 0], 0, 1).astype(np.float32, copy=True)
                    last_rvm_fgr = np.clip(fgr_result[0].transpose(1, 2, 0), 0, 1)
                    last_rvm_fgr = np.asarray(np.rint(last_rvm_fgr * 255), dtype=np.uint8)
                    if last_rvm_alpha.shape != (crop_h, crop_w):
                        last_rvm_alpha = np.asarray(Image.fromarray(last_rvm_alpha, mode='F').resize(
                            (crop_w, crop_h), Image.Resampling.BILINEAR), dtype=np.float32).copy()
                processing_queue.put((count, output_rgb, last_rvm_alpha, last_rvm_fgr,
                                      None if repair_alpha else semantic_gate,
                                      selected_person_probability if smart_seed is not None
                                      else current_person_probability))
                count += 1
                if count % 3 == 0:
                    self.events.put(('progress', count, total_frames, self.provider_name))
            self.events.put(('phase', '所有帧已处理，正在写入并封装视频…'))
        except Exception as exc:
            failure = exc
        finally:
            if processing_thread is not None:
                processing_queue.put(None)
                processing_thread.join()
            if failure is None and processing_errors:
                failure = RuntimeError(f'遮罩合成失败：{processing_errors[0]}')
            if writer_thread is not None:
                frame_queue.put(None)
                writer_thread.join()
            try:
                decoder.stdout.close()
                decoder.wait(timeout=2)
            except Exception:
                decoder.kill()
                decoder.wait()
            if encoder is not None:
                try:
                    encoder.stdin.close()
                except Exception:
                    pass
                # On normal EOF, VP9 may need longer than a few seconds to flush
                # the final cluster/index. Never mistake that for a hung encoder.
                if failure is not None and encoder.poll() is None:
                    encoder.terminate()
                try:
                    encoder.wait(timeout=120 if failure is None else 5)
                except subprocess.TimeoutExpired:
                    encoder.kill()
                    encoder.wait()
                encoder_log.flush()
                encoder_log.seek(0)
                error = encoder_log.read().decode('utf-8', 'replace').strip()
            decoder_log.flush()
            decoder_log.seek(0)
            decoder_error = decoder_log.read().decode('utf-8', 'replace').strip()
            decoder_log.close()
            encoder_log.close()
        if encoder is None:
            raise RuntimeError('无法启动 FFmpeg 编码器。')
        if failure is not None:
            if encoder.returncode not in (None, 0) and error:
                raise RuntimeError(f'{failure}\nFFmpeg：{error}') from failure
            raise failure
        if encoder.returncode != 0:
            detail = error or f'FFmpeg 进程异常退出，退出码：{encoder.returncode}。'
            raise RuntimeError(f'{detail}\n编码器：{ffmpeg}')
        if decoder.returncode != 0:
            raise RuntimeError(f'源视频解码失败（退出码 {decoder.returncode}）：\n{decoder_error or ffmpeg}')
        if count == 0:
            raise RuntimeError('视频中没有可处理的视频帧。')
        self.events.put(('phase', '视频已写入，正在校验透明通道…'))
        self._verify_output_alpha(ffmpeg, ffprobe, output, compact)
        self.events.put(('progress', count, total_frames or count, self.provider_name))

    @staticmethod
    def _verify_output_alpha(ffmpeg, ffprobe, output, compact=False):
        """Verify both alpha signaling and actual transparent pixels in frame 1."""
        probe = _run_silent([ffprobe, '-v', 'error', '-protocol_whitelist', 'file,crypto,data',
                                '-select_streams', 'v:0', '-show_entries',
                                'stream=pix_fmt:stream_tags=alpha_mode', '-of', 'json', str(output)],
                               capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
        if probe.returncode != 0:
            raise RuntimeError(f'透明视频校验失败：{probe.stderr.strip() or "ffprobe 无法读取输出。"}')
        stream_data = json.loads(probe.stdout).get('streams', [{}])[0]
        pix_fmt = str(stream_data.get('pix_fmt', '')).lower()
        tags = {str(key).casefold(): value for key, value in stream_data.get('tags', {}).items()}
        if compact and tags.get('alpha_mode') != '1':
            raise RuntimeError('导出完成，但 WebM 没有 Alpha 标记；已停止交付该文件。')
        if not compact and not any(token in pix_fmt for token in ('a', 'rgba', 'bgra')):
            raise RuntimeError(f'导出文件像素格式 {pix_fmt or "未知"} 不含 Alpha 通道；已停止交付该文件。')
        # WebM VP8 stores alpha as a separate BlockAdditional payload. FFmpeg's
        # default VP8 decoder ignores that payload, so explicitly select libvpx
        # when verifying WebM; otherwise valid transparent output looks opaque.
        decoder = ['-c:v', 'libvpx'] if compact else []
        alpha = _run_silent([ffmpeg, '-hide_banner', '-loglevel', 'error', *decoder,
                                '-protocol_whitelist', 'file,crypto,data',
                                '-i', str(output), '-vf', 'alphaextract', '-frames:v', '1',
                                '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
                               capture_output=True, timeout=30)
        if alpha.returncode != 0 or not alpha.stdout:
            detail = alpha.stderr.decode('utf-8', 'replace').strip()
            raise RuntimeError(f'无法从导出文件读取 Alpha 像素：{detail or pix_fmt}')
        if min(alpha.stdout) == 255:
            raise RuntimeError('导出文件的第一帧 Alpha 全不透明；已停止交付该文件。')

    @staticmethod
    def _check_vp9_alpha(ffmpeg, ffprobe, source, fps, output_dir):
        """Fail before a long export if this FFmpeg cannot produce VP8 Alpha."""
        frame = bytes(64 * 64 * 4 * 2)
        fd, sample_name = tempfile.mkstemp(prefix='.video-alpha-check-', suffix='.webm', dir=str(output_dir))
        os.close(fd)
        sample = Path(sample_name)
        try:
            command = [ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format',
                       'rgba', '-video_size', '64x64', '-framerate', f'{fps:.8f}', '-protocol_whitelist', 'pipe',
                       '-i', 'pipe:0', '-protocol_whitelist', 'file,crypto,data', '-i', str(source),
                       '-map', '0:v:0', '-map', '1:a?', '-frames:v', '2', '-c:v', 'libvpx', '-pix_fmt',
                       'yuva420p', '-crf', '20', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8',
                       '-auto-alt-ref', '0', '-metadata:s:v:0', 'alpha_mode=1', '-c:a', 'libopus', '-b:a',
                       '128k', '-shortest', str(sample)]
            result = _run_silent(command, input=frame, capture_output=True, timeout=30)
            if result.returncode != 0:
                detail = result.stderr.decode('utf-8', 'replace').strip() or f'FFmpeg 退出码 {result.returncode}'
                raise RuntimeError(f'透明 VP8 编码预检失败，尚未处理视频帧：\n{detail}\n编码器：{ffmpeg}')
            check = _run_silent([ffprobe, '-v', 'error', '-protocol_whitelist', 'file,crypto,data',
                                    '-select_streams', 'v:0', '-show_entries',
                                    'stream_tags=alpha_mode', '-of', 'json', str(sample)], capture_output=True,
                                   text=True, encoding='utf-8', errors='replace', timeout=30)
            check_stream = json.loads(check.stdout).get('streams', [{}])[0] if check.returncode == 0 else {}
            check_tags = {str(key).casefold(): value for key, value in check_stream.get('tags', {}).items()}
            if check.returncode != 0 or check_tags.get('alpha_mode') != '1':
                detail = check.stderr.strip() or '编码器未写入 Alpha 标记。'
                raise RuntimeError(f'透明 VP8 编码预检失败：{detail}\n编码器：{ffmpeg}')
        finally:
            sample.unlink(missing_ok=True)

    def cancel_export(self):
        source = self._source_key(self.video.get()) if self.video.get() else ''
        job = self.export_jobs.get(source)
        if job:
            job['cancel_event'].set()
            self.cancel_button.configure(state='disabled')
            self.status.set('正在停止当前视频的抠图…')

    def cancel_all_exports(self):
        for job in self.export_jobs.values():
            job['cancel_event'].set()

    def _sync_job_controls(self, reset_progress=False):
        if not self.export_button or not self.export_button.winfo_exists():
            return
        source = self._source_key(self.video.get()) if self.video.get() else ''
        running = source in self.export_jobs
        self.export_button.configure(state='disabled' if running else 'normal')
        self.cancel_button.configure(state='normal' if running else 'disabled')
        job = self.export_jobs.get(source)
        if job:
            self.progress.configure(value=job.get('progress', 0))
            self.status.set('视频正在后台抠图…' if job.get('state') in ('处理中', '正在收尾') else '视频在等待处理…')
        elif reset_progress:
            self.progress.configure(value=0)

    def close(self):
        if self.is_exporting:
            self.close_when_finished = True
            self.cancel_all_exports()
            self.status.set('正在取消抠像，完成清理后关闭窗口…')
            return
        self._destroy_window()

    def _destroy_window(self):
        if self.window.winfo_exists():
            self.window.destroy()
        if self.app:
            self.app.on_rotoscope_closed(self)


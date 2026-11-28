"""Resolve bundled media tools without depending on platform file suffixes."""
from __future__ import annotations

import os
import shutil
from pathlib import Path


def media_binary(resource_root: Path, name: str) -> Path:
    executable = f"{name}.exe" if os.name == "nt" else name
    candidates = []
    override = os.environ.get("CLIPASSIST_MEDIA_ROOT")
    if override:
        candidates.append(Path(override) / executable)
    candidates.append(Path(resource_root) / "ffmpeg" / executable)
    located = shutil.which(executable)
    if located:
        candidates.append(Path(located))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"缺少媒体运行文件：{executable}")

"""Publish regenerated images while keeping previous content recoverable."""
import io
import hashlib
import os
import uuid
from datetime import datetime
from pathlib import Path


def publish_png(image, output, backup_root):
    output=Path(output)
    stream=io.BytesIO()
    image.save(stream,format='PNG')
    payload=stream.getvalue()
    if output.exists():
        previous=output.read_bytes()
        if previous==payload:return
        backups=Path(backup_root)/'generated_png_backups'
        backups.mkdir(parents=True,exist_ok=True)
        identity=hashlib.sha256(str(output.resolve()).encode('utf-8')).hexdigest()[:16]
        (backups/f'{identity}-{datetime.now():%Y%m%d-%H%M%S-%f}.png').write_bytes(previous)
    temporary=output.with_name(output.name+f'.{uuid.uuid4().hex}.tmp')
    try:
        temporary.write_bytes(payload)
        try:
            os.replace(temporary,output)
        except PermissionError:
            # Windows cannot replace a PNG currently opened without delete
            # sharing (for example, in an image viewer or Explorer preview).
            # Preserve the old image and still let the download proceed.
            if not output.exists():
                raise
            alternate=output.with_name(
                f'{output.stem}-新建-{datetime.now():%Y%m%d-%H%M%S-%f}{output.suffix}')
            os.replace(temporary,alternate)
            return alternate
        return output
    finally:
        if temporary.exists():temporary.unlink()

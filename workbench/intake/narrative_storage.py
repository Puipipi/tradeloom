from __future__ import annotations

import hashlib
import os
import re
import secrets
import stat
from pathlib import Path

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction

from workbench.models import NarrativeSourceVersion

from .storage import _private_directory, verify_source_root

MAX_NARRATIVE_BYTES = 2 * 1024 * 1024
MAX_NARRATIVE_LINES = 20_000
MAX_EVIDENCE_LINE_SPAN = 200
MAX_EVIDENCE_SUMMARY_CHARS = 1_000


def prepare_narrative(upload) -> dict:
    """Read and validate one bounded UTF-8 .txt upload without persisting it."""
    name = str(getattr(upload, "name", "")).replace("\\", "/").split("/")[-1]
    if not name or len(name) > 255 or not name.lower().endswith(".txt") or any(ord(ch) < 32 for ch in name):
        raise ValidationError("仅支持有效的 UTF-8 文本文件。")
    declared = getattr(upload, "size", None)
    if declared is not None and declared > MAX_NARRATIVE_BYTES:
        raise ValidationError("文本文件超过大小限制。")
    content = upload.read(MAX_NARRATIVE_BYTES + 1)
    if not content or len(content) > MAX_NARRATIVE_BYTES:
        raise ValidationError("文本文件超过大小限制或为空。")
    try:
        text = content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ValidationError("文本文件必须使用 UTF-8 编码。") from exc
    if "\x00" in text:
        raise ValidationError("文本文件格式无效。")
    line_count = max(1, len(text.splitlines()))
    if line_count > MAX_NARRATIVE_LINES:
        raise ValidationError("文本文件行数超过限制。")
    return {"display_name": name, "content": content, "sha256": hashlib.sha256(content).hexdigest(),
            "byte_size": len(content), "line_count": line_count}


def store_narrative(prepared: dict) -> tuple[NarrativeSourceVersion, bool, str | None]:
    """Append one immutable narrative blob and its private source row."""
    content = prepared["content"]
    digest = hashlib.sha256(content).hexdigest()
    if digest != prepared["sha256"] or len(content) != prepared["byte_size"]:
        raise ValidationError("文本来源校验失败。")
    root = verify_source_root()
    base = _private_directory(root, "narratives", create=True)
    incoming = _private_directory(base, "incoming", create=True)
    temp_path = incoming / f"{secrets.token_hex(32)}.part"
    final_path = None
    storage_key = ""
    try:
        fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        objects = _private_directory(base, "objects", create=True)
        object_dir = _private_directory(objects, digest[:2], create=True)
        filename = f"{secrets.token_hex(32)}.txt"
        final_path = object_dir / filename
        storage_key = f"narratives/objects/{digest[:2]}/{filename}"
        os.replace(temp_path, final_path)
        try:
            with transaction.atomic():
                source = NarrativeSourceVersion.objects.create(
                    sha256=digest,
                    storage_key=storage_key,
                    display_name=prepared["display_name"],
                    byte_size=len(content),
                    line_count=prepared["line_count"],
                )
            # The caller owns the surrounding operation transaction. If its
            # receipt cannot commit, it may remove only this newly written,
            # now-unreferenced object after that transaction rolls back.
            return source, True, storage_key
        except IntegrityError:
            final_path.unlink(missing_ok=True)
            source = NarrativeSourceVersion.objects.filter(sha256=digest).first()
            if source is None:
                raise
            return source, False, None
        except Exception:
            try:
                referenced = NarrativeSourceVersion.objects.filter(storage_key=storage_key).exists()
            except Exception:
                referenced = True
            if not referenced:
                final_path.unlink(missing_ok=True)
            raise
    except OSError as exc:
        raise ValidationError("私有文本存储不可用。") from exc
    finally:
        temp_path.unlink(missing_ok=True)


def cleanup_unreferenced_narrative(storage_key: str | None) -> None:
    """Remove only a just-created object after its outer DB transaction rolled back."""
    if not isinstance(storage_key, str):
        return
    parts = storage_key.split("/")
    if (len(parts) != 4 or parts[0] != "narratives" or parts[1] != "objects" or
            not re.fullmatch(r"[a-f0-9]{2}", parts[2]) or not re.fullmatch(r"[a-f0-9]{64}\.txt", parts[3])):
        return
    try:
        if NarrativeSourceVersion.objects.filter(storage_key=storage_key).exists():
            return
        root = verify_source_root()
        object_dir = _private_directory(root, *parts[:3])
        path = object_dir / parts[3]
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or
                getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400) or
                path.resolve(strict=True) != path.absolute()):
            return
        # A DB lookup failure above is caught by the outer guard and preserves
        # the file; deletion is allowed only after a positive unreferenced read.
        path.unlink()
    except FileNotFoundError:
        return
    except Exception:
        # Failure to prove ownership or reference state means preserve the blob.
        return


def open_narrative(source_id: str):
    """Open a hash-checked private narrative by opaque record ID."""
    root = verify_source_root()
    source = NarrativeSourceVersion.objects.get(pk=source_id)
    parts = source.storage_key.split("/")
    if (len(parts) != 4 or parts[0] != "narratives" or parts[1] != "objects" or
            parts[2] != source.sha256[:2] or not parts[3].endswith(".txt") or
            Path(parts[3]).name != parts[3]):
        raise ValidationError("文本来源引用无效。")
    object_dir = _private_directory(root, *parts[:3])
    path = object_dir / parts[3]
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or
            getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
        raise ValidationError("文本来源不可用。")
    if path.resolve(strict=True) != path.absolute() or info.st_size != source.byte_size:
        raise ValidationError("文本来源校验失败。")
    stream = path.open("rb")
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(64 * 1024), b""):
        digest.update(chunk)
    if digest.hexdigest() != source.sha256:
        stream.close()
        raise ValidationError("文本来源校验失败。")
    stream.seek(0)
    return stream

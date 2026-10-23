from __future__ import annotations

import hashlib
import os
import re
import secrets
import stat
import zipfile
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction

from workbench.models import IntakeSourceVersion
from .limits import MAX_SOURCE_BYTES, MAX_UNCOMPRESSED_BYTES, MAX_ZIP_PARTS

INTAKE_MARKER = ".tradeloom-intake-owned"
INTAKE_MARKER_CONTENT = "tradeloom-private-intake-v1\n"
_STORAGE_KEY = re.compile(r"^[a-f0-9]{64}\.xlsx$")
_REQUIRED_PARTS = {"[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"}


def verify_source_root() -> Path:
    root = getattr(settings, "TRADELOOM_INTAKE_ROOT", None)
    data_root = getattr(settings, "TRADELOOM_DATA_ROOT", None)
    if root is None or data_root is None:
        raise ValidationError("私有资料存储尚未配置。")
    root = Path(root)
    expected = Path(data_root) / "private" / "intake"
    try:
        if root.resolve(strict=True) != expected.resolve(strict=True):
            raise ValidationError("私有资料存储路径无效。")
        current = root
        while current != current.parent:
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
                raise ValidationError("私有资料存储路径无效。")
            current = current.parent
        marker = root / INTAKE_MARKER
        marker_info = marker.lstat()
        if not stat.S_ISREG(marker_info.st_mode) or marker.read_text(encoding="utf-8") != INTAKE_MARKER_CONTENT:
            raise ValidationError("私有资料存储尚未受控初始化。")
    except (OSError, RuntimeError) as exc:
        raise ValidationError("私有资料存储不可用。") from exc
    media_root = Path(settings.MEDIA_ROOT).resolve()
    static_root = Path(settings.STATIC_ROOT).resolve()
    if any(root == public or root in public.parents or public in root.parents for public in (media_root, static_root)):
        raise ValidationError("私有资料存储路径无效。")
    return root


def _private_directory(root: Path, *parts: str, create: bool = False) -> Path:
    current = root
    for part in parts:
        if part in {"", ".", ".."} or "/" in part or "\\" in part:
            raise ValidationError("私有资料存储路径无效。")
        candidate = current / part
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            if not create:
                raise ValidationError("来源文件不可用。")
            try:
                candidate.mkdir()
            except FileExistsError:
                pass
            try:
                info = candidate.lstat()
            except OSError as exc:
                raise ValidationError("私有资料存储不可用。") from exc
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise ValidationError("私有资料存储路径无效。")
        try:
            if candidate.resolve(strict=True) != candidate.absolute():
                raise ValidationError("私有资料存储路径无效。")
        except (OSError, RuntimeError) as exc:
            raise ValidationError("私有资料存储路径无效。") from exc
        current = candidate
    return current


def _validate_zip(path: Path) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ZIP_PARTS:
                raise ValidationError("工作簿包含过多部件。")
            names = {entry.filename for entry in entries}
            if len(names) != len(entries):
                raise ValidationError("工作簿包含重复部件。")
            if not _REQUIRED_PARTS.issubset(names):
                raise ValidationError("文件不是受支持的 XLSX 工作簿。")
            if any(name.startswith("xl/externalLinks/") for name in names):
                raise ValidationError("含外部工作簿链接的文件不能导入。")
            if any(name.lower().endswith("vbaproject.bin") for name in names):
                raise ValidationError("含宏的文件不能导入。")
            total = 0
            for entry in entries:
                name = Path(entry.filename)
                if name.is_absolute() or ".." in name.parts or "\\" in entry.filename:
                    raise ValidationError("工作簿部件路径无效。")
                total += entry.file_size
                if total > MAX_UNCOMPRESSED_BYTES:
                    raise ValidationError("工作簿解压后超过大小限制。")
            bad = archive.testzip()
            if bad is not None:
                raise ValidationError("工作簿压缩内容损坏。")
    except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
        raise ValidationError("文件不是有效的 XLSX 工作簿。") from exc


def store_source(upload) -> tuple[IntakeSourceVersion, bool]:
    original_name = Path(str(getattr(upload, "name", ""))).name
    if not original_name.lower().endswith(".xlsx"):
        raise ValidationError("仅支持 .xlsx 工作簿。")
    declared = getattr(upload, "size", None)
    if declared is not None and declared > MAX_SOURCE_BYTES:
        raise ValidationError("工作簿超过大小限制。")
    root = verify_source_root()
    incoming = _private_directory(root, "incoming", create=True)
    temp_path = incoming / f"{secrets.token_hex(32)}.part"
    digest = hashlib.sha256()
    size = 0
    try:
        fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as target:
            for chunk in upload.chunks():
                size += len(chunk)
                if size > MAX_SOURCE_BYTES:
                    raise ValidationError("工作簿超过大小限制。")
                digest.update(chunk)
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        _validate_zip(temp_path)
        sha256 = digest.hexdigest()
        storage_key = f"{secrets.token_hex(32)}.xlsx"
        _private_directory(root, "objects", create=True)
        object_dir = _private_directory(root, "objects", sha256[:2], create=True)
        final_path = object_dir / storage_key
        os.replace(temp_path, final_path)
        try:
            with transaction.atomic():
                source = IntakeSourceVersion.objects.create(
                    sha256=sha256,
                    storage_key=f"{sha256[:2]}/{storage_key}",
                    original_name=original_name[:255],
                    byte_size=size,
                    mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            return source, True
        except IntegrityError:
            final_path.unlink(missing_ok=True)
            source = IntakeSourceVersion.objects.get(sha256=sha256)
            return source, False
        except Exception:
            # Never leave a newly moved object unreferenced. If the DB state
            # cannot be checked, preserve the object rather than risk deleting
            # a file that a committed row already references.
            try:
                referenced = IntakeSourceVersion.objects.filter(
                    storage_key=f"{sha256[:2]}/{storage_key}"
                ).exists()
            except Exception:
                referenced = True
            if not referenced:
                final_path.unlink(missing_ok=True)
            raise
    finally:
        temp_path.unlink(missing_ok=True)


def cleanup_unreferenced_source(storage_key: str) -> bool:
    """Remove one newly owned object only when its private path and lack of DB references are certain."""
    if not isinstance(storage_key, str) or storage_key.count("/") != 1:
        return False
    prefix, filename = storage_key.split("/", 1)
    if not re.fullmatch(r"[a-f0-9]{2}", prefix) or not _STORAGE_KEY.fullmatch(filename):
        return False
    try:
        root = verify_source_root()
        if IntakeSourceVersion.objects.filter(storage_key=storage_key).exists():
            return False
        object_dir = _private_directory(root, "objects", prefix)
        path = object_dir / filename
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or
                getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
            return False
        if path.resolve(strict=True) != path.absolute():
            return False
        path.unlink()
        return True
    except Exception:
        # A failed DB lookup or uncertain filesystem check is not proof that the object is unreferenced.
        return False


def open_source(source_id: str):
    root = verify_source_root()
    source = IntakeSourceVersion.objects.get(pk=source_id)
    if not re.fullmatch(r"[a-f0-9]{2}/[a-f0-9]{64}\.xlsx", source.storage_key):
        raise ValidationError("来源文件引用无效。")
    prefix, filename = source.storage_key.split("/", 1)
    object_dir = _private_directory(root, "objects", prefix)
    path = object_dir / filename
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
        raise ValidationError("来源文件不可用。")
    if path.resolve(strict=True) != path.absolute():
        raise ValidationError("来源文件引用无效。")
    stream = None
    try:
        info = path.stat()
        if info.st_size != source.byte_size or info.st_size > MAX_SOURCE_BYTES:
            raise ValidationError("来源文件校验失败。")
        digest = hashlib.sha256()
        stream = path.open("rb")
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        if digest.hexdigest() != source.sha256:
            raise ValidationError("来源文件校验失败。")
        stream.seek(0)
        return stream
    except ValidationError:
        if stream is not None:
            stream.close()
        raise
    except OSError as exc:
        if stream is not None:
            stream.close()
        raise ValidationError("来源文件不可用。") from exc

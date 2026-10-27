from __future__ import annotations

import hashlib
import os
import re
import xml.etree.ElementTree as ET
import io
from pathlib import Path
from typing import Mapping

from django.conf import settings
from PIL import Image, UnidentifiedImageError


DELIVERY_FILES = {
    "catalog_html": "catalog.html",
    "catalog_markdown": "catalog.md",
    "sample_checklist_csv": "sample_checklist.csv",
    "sample_checklist_json": "sample_checklist.json",
    "quality_report_json": "quality_report.json",
}
_SAFE_ID = re.compile(r"^[0-9a-f]{32}$")
_IMAGE_LIMIT = 5 * 1024 * 1024
_RASTER_FORMATS = {
    ".png": ("image/png", "PNG"),
    ".jpg": ("image/jpeg", "JPEG"),
    ".jpeg": ("image/jpeg", "JPEG"),
    ".gif": ("image/gif", "GIF"),
    ".webp": ("image/webp", "WEBP"),
}
_IMAGE_DIMENSION_LIMIT = 10_000
_IMAGE_PIXEL_LIMIT = 40_000_000


class DeliveryStorageError(ValueError):
    pass


def artifact_root() -> Path:
    return Path(settings.TRADELOOM_ARTIFACT_ROOT).resolve()


def _contained_path(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative:
        raise DeliveryStorageError("Stored file path is invalid")
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root.resolve()):
        raise DeliveryStorageError("Stored file path is outside the configured root")
    return candidate


def task_file_path(stored_name: str) -> Path:
    if not isinstance(stored_name, str) or Path(stored_name).name != stored_name:
        raise DeliveryStorageError("TaskFile stored name is invalid")
    media_root = Path(settings.MEDIA_ROOT).resolve()
    path = _contained_path(media_root, stored_name)
    if not path.is_file():
        raise DeliveryStorageError("TaskFile bytes are missing")
    return path


def _svg_mime(content: bytes) -> str:
    if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
        raise DeliveryStorageError("SVG document types are not supported")
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        raise DeliveryStorageError("SVG content is invalid") from exc
    if root.tag.rsplit("}", 1)[-1].lower() != "svg":
        raise DeliveryStorageError("SVG root element is invalid")
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1].lower()
        if tag in {"script", "foreignobject", "style", "iframe", "object", "embed"}:
            raise DeliveryStorageError("Active SVG elements are not supported")
        for name, value in element.attrib.items():
            local_name = name.rsplit("}", 1)[-1].lower()
            normalized_value = value.strip().lower()
            if (
                local_name.startswith("on")
                or local_name in {"href", "style"}
                or "url(" in normalized_value
                or "javascript:" in normalized_value
            ):
                raise DeliveryStorageError("Active SVG attributes are not supported")
    return "image/svg+xml"


def image_mime_type(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix == ".svg":
        return _svg_mime(content)
    expected = _RASTER_FORMATS.get(suffix)
    if expected is None:
        raise DeliveryStorageError("Image type or file signature is unsupported")
    mime_type, image_format = expected
    try:
        with Image.open(io.BytesIO(content)) as image:
            _validate_image_dimensions(image)
            if image.format != image_format:
                raise DeliveryStorageError("Image type or file signature is unsupported")
            image.verify()
        with Image.open(io.BytesIO(content)) as image:
            _validate_image_dimensions(image)
            if image.format != image_format:
                raise DeliveryStorageError("Image type or file signature is unsupported")
            image.load()
    except DeliveryStorageError:
        raise
    except (OSError, ValueError, SyntaxError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise DeliveryStorageError("Image content is invalid or incomplete") from exc
    return mime_type


def _validate_image_dimensions(image: Image.Image) -> None:
    width, height = image.size
    if (
        width <= 0
        or height <= 0
        or width > _IMAGE_DIMENSION_LIMIT
        or height > _IMAGE_DIMENSION_LIMIT
        or width * height > _IMAGE_PIXEL_LIMIT
    ):
        raise DeliveryStorageError("Image dimensions are invalid")


def read_task_image(stored_name: str, original_name: str) -> tuple[bytes, str, str]:
    path = task_file_path(stored_name)
    content = path.read_bytes()
    if not content or len(content) > _IMAGE_LIMIT:
        raise DeliveryStorageError("TaskFile image size is invalid")
    mime_type = image_mime_type(original_name, content)
    return content, mime_type, hashlib.sha256(content).hexdigest()


def create_staging_directory(workflow_id: str, step_id: str) -> tuple[Path, Path]:
    if not _SAFE_ID.fullmatch(workflow_id) or not _SAFE_ID.fullmatch(step_id):
        raise DeliveryStorageError("Workflow or step ID is invalid")
    root = artifact_root()
    staging_parent = root / ".staging" / workflow_id
    final_parent = root / workflow_id
    staging_parent.mkdir(parents=True, exist_ok=True)
    final_parent.mkdir(parents=True, exist_ok=True)
    staging = staging_parent / step_id
    final = final_parent / step_id
    staging.mkdir(exist_ok=False)
    return staging, final


def write_staging_files(directory: Path, files: Mapping[str, bytes]) -> None:
    allowed_types = set(DELIVERY_FILES) - {"quality_report_json"}
    if set(files) not in (allowed_types, set(DELIVERY_FILES)):
        raise DeliveryStorageError("Delivery bundle must contain four files before the quality report")
    for artifact_type, filename in DELIVERY_FILES.items():
        if artifact_type not in files:
            continue
        path = directory / filename
        with path.open("xb") as handle:
            handle.write(files[artifact_type])
            handle.flush()
            os.fsync(handle.fileno())


def publish_staging_directory(staging: Path, final: Path) -> None:
    if final.exists():
        raise DeliveryStorageError("Delivery version directory already exists")
    os.replace(staging, final)


def stored_file_path(workflow_id: str, step_id: str, filename: str) -> str:
    if filename not in DELIVERY_FILES.values():
        raise DeliveryStorageError("Delivery filename is not allowed")
    if not _SAFE_ID.fullmatch(workflow_id) or not _SAFE_ID.fullmatch(step_id):
        raise DeliveryStorageError("Workflow or step ID is invalid")
    relative = f"{workflow_id}/{step_id}/{filename}"
    _contained_path(artifact_root(), relative)
    return relative


def resolve_artifact_file(relative: str) -> Path:
    path = _contained_path(artifact_root(), relative)
    if not path.is_file():
        raise FileNotFoundError("Registered delivery file is missing")
    return path

def write_native_artifact(content: bytes, version_id: str) -> tuple[str, Path]:
    """Publish one uniquely named native artifact under the existing root."""
    import uuid
    if str(uuid.UUID(version_id)) != version_id:
        raise DeliveryStorageError('Invalid native version ID')
    root = artifact_root()
    relative = f'native/{version_id}/content'
    final = _contained_path(root, relative)
    final.parent.mkdir(parents=True, exist_ok=False)
    try:
        with final.open('xb') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        import shutil
        shutil.rmtree(final.parent)
        raise
    return relative, final

"""Fail-closed bridge to the canonical JavaScript workflow definition validator."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
from django.conf import settings

MAX_INPUT = 2 * 1024 * 1024 + 4096
MAX_OUTPUT = 2 * 1024 * 1024 + 8192
SCRIPT = Path(__file__).with_suffix('.mjs')
MAX_SAFE_INTEGER = 9007199254740991


class ValidationUnavailable(RuntimeError):
    code = 'workflow_validation_unavailable'


class WorkflowDefinitionInvalid(ValueError):
    code = 'invalid_workflow'


def _trusted_file(path):
    if not path.is_absolute() or not path.is_file():
        raise ValidationUnavailable()
    for part in (path, *path.parents):
        if getattr(part.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValidationUnavailable()
    return path


def validate_workflow_definition(document):
    try:
        node = _trusted_file(Path(getattr(settings, 'TRADELOOM_ARTIFACT_NODE', os.environ.get('TRADELOOM_ARTIFACT_NODE', ''))))
        expected = getattr(settings, 'TRADELOOM_ARTIFACT_NODE_SHA256', os.environ.get('TRADELOOM_ARTIFACT_NODE_SHA256', ''))
        if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected):
            raise ValidationUnavailable()
        with node.open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != expected:
                raise ValidationUnavailable()
        script = _trusted_file(SCRIPT.absolute())
        body = json.dumps({'document': document}, ensure_ascii=True, separators=(',', ':')).encode('ascii')
        if len(body) > MAX_INPUT:
            raise WorkflowDefinitionInvalid()
        env = {key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP') if key in os.environ}
        proc = subprocess.Popen(
            [str(node), str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=str(script.parent), env=env, shell=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        output = bytearray()

        def read_output():
            output.extend(proc.stdout.read(MAX_OUTPUT + 1))
            if len(output) > MAX_OUTPUT:
                proc.kill()

        def write_input():
            try:
                proc.stdin.write(body)
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass

        reader = threading.Thread(target=read_output, daemon=True)
        writer = threading.Thread(target=write_input, daemon=True)
        reader.start()
        writer.start()
        try:
            code = proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise ValidationUnavailable() from None
        reader.join(timeout=1)
        writer.join(timeout=1)
        if reader.is_alive() or writer.is_alive() or code != 0 or len(output) > MAX_OUTPUT:
            raise ValidationUnavailable()
        try:
            result = json.loads(bytes(output).decode('utf-8'))
        except (json.JSONDecodeError, UnicodeError):
            raise ValidationUnavailable() from None
        if not isinstance(result, dict) or result.get('ok') is not True or set(result) != {'ok', 'document', 'definitionRevision'}:
            code = result.get('code') if isinstance(result, dict) else None
            if code == 'invalid_workflow':
                raise WorkflowDefinitionInvalid()
            raise ValidationUnavailable()
        normalized = result['document']
        digest = result['definitionRevision']
        if not isinstance(normalized, dict) or not isinstance(normalized.get('id'), str):
            raise ValidationUnavailable()
        if normalized.get('confirmed') is True:
            if not isinstance(digest, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
                raise ValidationUnavailable()
        elif digest is not None:
            raise ValidationUnavailable()
        return normalized, digest
    except (WorkflowDefinitionInvalid, ValidationUnavailable):
        raise
    except (OSError, UnicodeError, TypeError, ValueError, subprocess.SubprocessError):
        raise ValidationUnavailable() from None

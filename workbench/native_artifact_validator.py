"""Fixed, fail-closed bridge to the canonical native projection."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
from django.conf import settings

MAX_INPUT = 2 * 1024 * 1024 + 4096
MAX_OUTPUT = 8192
SCRIPT = Path(__file__).with_suffix('.mjs')

class ValidationUnavailable(ValueError):
    pass

def _trusted_file(path):
    if not path.is_absolute() or not path.is_file():
        raise ValidationUnavailable('source_validation_unavailable')
    for part in (path, *path.parents):
        if getattr(part.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValidationUnavailable('source_validation_unavailable')
    return path

def validate_native_source(snapshot, node_id, attempt, seq, file_index):
    try:
        node = _trusted_file(Path(getattr(settings, 'TRADELOOM_ARTIFACT_NODE', os.environ.get('TRADELOOM_ARTIFACT_NODE', ''))))
        expected = getattr(settings, 'TRADELOOM_ARTIFACT_NODE_SHA256', os.environ.get('TRADELOOM_ARTIFACT_NODE_SHA256', ''))
        if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected): raise ValidationUnavailable('source_validation_unavailable')
        with node.open('rb') as handle:
            digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        if digest != expected: raise ValidationUnavailable('source_validation_unavailable')
        script = _trusted_file(SCRIPT.absolute())
        body = json.dumps({'snapshot':snapshot,'nodeId':node_id,'attempt':attempt,'seq':seq,'fileIndex':file_index},ensure_ascii=False,separators=(',',':')).encode('utf-8')
        if len(body) > MAX_INPUT: raise ValidationUnavailable('source_validation_unavailable')
        env = {key: os.environ[key] for key in ('SYSTEMROOT','WINDIR','TEMP','TMP') if key in os.environ}
        proc = subprocess.Popen([str(node), str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=str(script.parent), env=env, shell=False, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        result = bytearray()
        def read_output():
            result.extend(proc.stdout.read(MAX_OUTPUT + 1))
            if len(result) > MAX_OUTPUT: proc.kill()
        def write_input():
            try:
                proc.stdin.write(body); proc.stdin.close()
            except (BrokenPipeError, OSError): pass
        reader = threading.Thread(target=read_output, daemon=True); writer = threading.Thread(target=write_input, daemon=True)
        reader.start(); writer.start()
        try: code = proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait(); raise ValidationUnavailable('source_validation_unavailable')
        reader.join(timeout=1); writer.join(timeout=1)
        if reader.is_alive() or writer.is_alive() or code or len(result) > MAX_OUTPUT: raise ValidationUnavailable('source_validation_unavailable')
        try: value = json.loads(bytes(result))
        except (json.JSONDecodeError, UnicodeError): raise ValidationUnavailable('source_validation_unavailable') from None
        keys = {'ok','runId','nodeId','attempt','childSessionId','nativeRunId','requestId','toolCallId','parentAgentId','parentSessionId','bindingRevision','definitionRevision','seq','fileIndex','callId','turn','name'}
        if not isinstance(value,dict) or set(value) != keys or value.get('ok') is not True: raise ValueError('source_unverified')
        if any(type(value[k]) is not int for k in ('attempt','seq','fileIndex','turn')): raise ValueError('source_unverified')
        if (value['runId'], value['nodeId'], value['attempt'], value['seq'], value['fileIndex']) != (snapshot.get('id'),node_id,attempt,seq,file_index): raise ValueError('source_unverified')
        if any(not isinstance(value[k],str) or not value[k] or len(value[k]) > 256 for k in keys - {'ok','attempt','seq','fileIndex','turn'}): raise ValueError('source_unverified')
        if type(value['turn']) is not int or value['turn'] < 1: raise ValueError('source_unverified')
        return value
    except ValueError:
        raise
    except (OSError, UnicodeError, TypeError, json.JSONDecodeError):
        raise ValidationUnavailable('source_validation_unavailable') from None

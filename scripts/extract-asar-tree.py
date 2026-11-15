import json
import sys
from pathlib import Path


def read_header(handle):
    head = handle.read(64)
    offset = head.index(b'{"files"')
    handle.seek(offset)
    # grow until the JSON object balances
    chunk = handle.read(96 * 1024 * 1024)
    depth = 0
    in_string = False
    escaped = False
    end = -1
    for index, byte in enumerate(chunk):
        if in_string:
            if escaped:
                escaped = False
            elif byte == 0x5c:
                escaped = True
            elif byte == 0x22:
                in_string = False
            continue
        if byte == 0x22:
            in_string = True
        elif byte == 0x7b:
            depth += 1
        elif byte == 0x7d:
            depth -= 1
            if depth == 0:
                end = index + 1
                break
    if end < 0:
        raise RuntimeError('asar header not balanced')
    header = json.loads(chunk[:end].decode('utf-8', 'ignore'))
    pad = (4 - ((4 + end) % 4)) % 4
    return header, offset + end + pad


def walk(node, prefix=''):
    for name, child in node.get('files', {}).items():
        path = f'{prefix}/{name}'
        if 'files' in child:
            yield from walk(child, path)
        else:
            yield path, child


def main():
    asar_path = Path(sys.argv[1])
    out_root = Path(sys.argv[2])
    prefix_filter = sys.argv[3] if len(sys.argv) > 3 else '/dsh/'
    written = 0
    skipped = 0
    total_bytes = 0
    with asar_path.open('rb') as handle:
        header, base = read_header(handle)
        for path, meta in walk(header):
            if not path.startswith(prefix_filter):
                continue
            if 'offset' not in meta:
                skipped += 1
                continue
            target = out_root / path.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            handle.seek(base + int(meta['offset']))
            remaining = int(meta['size'])
            with target.open('wb') as sink:
                while remaining > 0:
                    block = handle.read(min(4 * 1024 * 1024, remaining))
                    if not block:
                        break
                    sink.write(block)
                    remaining -= len(block)
            written += 1
            total_bytes += int(meta['size'])
    print(json.dumps({'asar': str(asar_path), 'root': str(out_root), 'prefix': prefix_filter,
                      'files': written, 'skipped': skipped, 'bytes': total_bytes}))


if __name__ == '__main__':
    main()
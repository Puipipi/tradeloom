"""把换过 DSH 基座的 dsh/ 树重新打包成 asar（一键升级的最后一步）。

  --base-asar    当前 TradeLoom app.asar（提供 /lib、/renderer、/package.json 等非基座条目）
  --new-dsh      新基座目录（形如 <root>/dsh/...，已打好补丁）
  --unpacked-src 新基座 app.asar.unpacked 目录
  --output       输出 asar

规则：
  * /dsh/** 一律取自 --new-dsh；命中 --unpacked-src 的文件写成 unpacked 条目（不进主体）
  * 其余条目沿用旧 asar 的字节与元数据，仅重算 offset
  * 头部按 asar 实测格式写：[4][json+10][json+6][json][json]
"""
import argparse
import json
import struct
from pathlib import Path


def read_asar(path):
    with path.open('rb') as handle:
        head = handle.read(64)
        offset = head.index(b'{"files"')
        handle.seek(offset)
        chunk = handle.read(96 * 1024 * 1024)
        depth = 0
        in_string = False
        escaped = False
        end = -1
        for index, byte in enumerate(chunk):
            if in_string:
                if escaped:
                    escaped = False
                elif byte == 0x5C:
                    escaped = True
                elif byte == 0x22:
                    in_string = False
                continue
            if byte == 0x22:
                in_string = True
            elif byte == 0x7B:
                depth += 1
            elif byte == 0x7D:
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
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-asar', required=True)
    parser.add_argument('--new-dsh', required=True)
    parser.add_argument('--unpacked-src', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()

    base = Path(args.base_asar)
    new_dsh = Path(args.new_dsh)
    unpacked_src = Path(args.unpacked_src)
    output = Path(args.output)

    header, data_start = read_asar(base)
    old_entries = dict(walk(header))

    staged_root = new_dsh / 'dsh'
    staged = {}
    for path in staged_root.rglob('*'):
        if path.is_file():
            staged['/dsh/' + path.relative_to(staged_root).as_posix()] = path

    unpacked = set()
    if unpacked_src.is_dir():
        for path in unpacked_src.rglob('*'):
            if path.is_file():
                unpacked.add('/' + path.relative_to(unpacked_src).as_posix())

    with base.open('rb') as source:
        def read_old(meta):
            source.seek(data_start + int(meta['offset']))
            return source.read(meta['size'])

        items = []
        for rel, meta in old_entries.items():
            if rel.startswith('/dsh/'):
                continue
            if meta.get('unpacked') is True or 'link' in meta:
                items.append((rel, {k: meta[k] for k in ('size', 'unpacked', 'link') if k in meta}, None))
            else:
                items.append((rel, {'size': meta['size']}, read_old(meta)))
        staged_keys = set(staged)
        for rel, path in sorted(staged.items()):
            if rel in unpacked:
                items.append((rel, {'size': path.stat().st_size, 'unpacked': True}, None))
            else:
                items.append((rel, {'size': path.stat().st_size}, path.read_bytes()))
        # 新基座以 unpacked 形式提供、但未出现在内联树里的文件必须补进条目表
        unpacked_root = Path(unpacked_src)
        for rel in sorted(unpacked):
            if rel in staged_keys:
                continue
            disk = unpacked_root / rel.lstrip('/')
            if not disk.is_file():
                continue
            items.append((rel, {'size': disk.stat().st_size, 'unpacked': True}, None))

    # 构造头部树
    files_tree = {}
    cursor = 0
    for rel, meta, payload in items:
        node = files_tree
        parts = [p for p in rel.split('/') if p]
        for part in parts[:-1]:
            node = node.setdefault(part, {'files': {}})['files']
        entry = dict(meta)
        if payload is not None:
            entry['offset'] = str(cursor)
            cursor += len(payload)
        node[parts[-1]] = entry

    header_json = json.dumps({'files': files_tree}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    size = len(header_json)
    # asar：内层 pickle = [jsonLen][json][pad] 且 4 字节对齐；外层 pickle 再包一层
    pad = (4 - ((4 + size) % 4)) % 4
    inner = 4 + size + pad
    outer = 4 + inner
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('wb') as sink:
        sink.write(struct.pack('<I', 4))
        sink.write(struct.pack('<I', outer))
        sink.write(struct.pack('<I', inner))
        sink.write(struct.pack('<I', size))
        sink.write(header_json)
        sink.write(b'\0' * pad)
        written = 0
        for rel, meta, payload in items:
            if payload is None:
                continue
            sink.write(payload)
            written += len(payload)
    print(json.dumps({'output': str(output), 'entries': len(items), 'inlineBytes': written,
                      'headerBytes': size, 'asarBytes': output.stat().st_size}))


if __name__ == '__main__':
    main()
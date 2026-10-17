"""环境自检：本机这条「样品图 → 印刷级 PDF」的流水线到底能不能跑。

用法：
    .venv\\Scripts\\python.exe scripts\\check_env.py

检查项：
    1. Python 依赖（Pillow / ReportLab / pikepdf / PyMuPDF）
    2. 中文 TTF 能否被 ReportLab 加载（含中文排版）
    3. Ghostscript 是否可用（版本）
    4. RGB → CMYK 转换能否成功，并验证转换后确实是 DeviceCMYK
    5. 字体文件清单

全部通过返回 0，任一项失败返回 1。失败不抛异常，逐项报告——这份输出本身就是答辩材料。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = ROOT / "assets" / "fonts"

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))


# ---------------------------------------------------------------- 1. 依赖
def check_deps() -> None:
    try:
        from PIL import __version__ as pillow_v

        record("Pillow", True, pillow_v)
    except Exception as exc:  # noqa: BLE001
        record("Pillow", False, str(exc))

    try:
        import reportlab

        record("ReportLab", True, reportlab.Version)
    except Exception as exc:  # noqa: BLE001
        record("ReportLab", False, str(exc))

    try:
        import pikepdf

        record("pikepdf", True, pikepdf.__version__)
    except Exception as exc:  # noqa: BLE001
        record("pikepdf", False, str(exc))

    try:
        import pymupdf

        record("PyMuPDF", True, pymupdf.__version__)
    except Exception as exc:  # noqa: BLE001
        record("PyMuPDF", False, str(exc))


# ---------------------------------------------------------------- 2. 字体
def font_files() -> list[Path]:
    if not FONT_DIR.is_dir():
        return []
    return sorted(FONT_DIR.glob("*.ttf")) + sorted(FONT_DIR.glob("*.otf"))


def check_fonts(tmp: Path) -> Path | None:
    files = font_files()
    record("字体文件", bool(files), ", ".join(f.name for f in files) or f"{FONT_DIR} 为空")

    ttf = next((f for f in files if f.suffix.lower() == ".ttf"), None)
    if ttf is None:
        record("中文 TTF 加载", False, "没有 .ttf 字体可测（ReportLab 不支持 OTF/CFF）")
        return None

    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas

        pdfmetrics.registerFont(TTFont("CJKTest", str(ttf)))
        out = tmp / "font_test.pdf"
        c = canvas.Canvas(str(out), pagesize=A4)
        c.setFont("CJKTest", 24)
        c.drawString(60, 700, "样品图 → 画册页 中文排版自检")
        c.setFont("CJKTest", 12)
        c.drawString(60, 670, "Christmas Ornament / 圣诞挂饰 · 报价单 2026")
        # 故意放两块 RGB 色块：转换后必须变成 CMYK 算子，否则说明 CMYK 转换没生效
        c.setFillColorRGB(0.95, 0.45, 0.10)
        c.rect(60, 600, 200, 40, stroke=0, fill=1)
        c.setFillColorRGB(0.10, 0.30, 0.60)
        c.rect(280, 600, 120, 40, stroke=0, fill=1)
        c.showPage()
        c.save()
        record("中文 TTF 加载", out.is_file() and out.stat().st_size > 0, f"{ttf.name} → {out.name}")
        return out
    except Exception as exc:  # noqa: BLE001
        record("中文 TTF 加载", False, f"{ttf.name}: {exc}")
        return None


# ---------------------------------------------------------------- 3. Ghostscript
def find_ghostscript() -> Path | None:
    env = os.environ.get("GS_BIN")
    candidates = []
    if env:
        candidates.append(Path(env))
    for name in ("gswin64c", "gswin32c", "gs"):
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))
    # 本项目惯用位置（与仓库同级）
    candidates += [
        ROOT.parent / "tools" / "gs" / "bin" / "gswin64c.exe",
        Path(r"C:\Program Files\gs\gs10.08.0\bin\gswin64c.exe"),
    ]
    for c in candidates:
        if c and c.is_file():
            return c
    return None


def check_ghostscript(tmp: Path, src: Path | None) -> None:
    gs = find_ghostscript()
    if gs is None:
        record("Ghostscript", False, "未找到 gswin64c（装好后把 GS_BIN 指向它，或放 tools/gs/bin/）")
        record("RGB → CMYK", False, "依赖 Ghostscript，跳过")
        return

    try:
        ver = subprocess.run(
            [str(gs), "--version"], capture_output=True, text=True, timeout=30
        ).stdout.strip()
        record("Ghostscript", True, f"{ver} @ {gs}")
    except Exception as exc:  # noqa: BLE001
        record("Ghostscript", False, str(exc))
        record("RGB → CMYK", False, "Ghostscript 无法执行")
        return

    if src is None or not src.is_file():
        record("RGB → CMYK", False, "没有可转换的样例 PDF")
        return

    out = tmp / "font_test_cmyk.pdf"
    cmd = [
        str(gs),
        "-dBATCH",
        "-dNOPAUSE",
        "-dQUIET",
        "-sDEVICE=pdfwrite",
        "-dProcessColorModel=/DeviceCMYK",
        "-sColorConversionStrategy=CMYK",
        "-dCompatibilityLevel=1.6",
        f"-sOutputFile={out}",
        str(src),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0 or not out.is_file():
            record("RGB → CMYK", False, f"gs 退出码 {proc.returncode}: {proc.stderr[:300]}")
            return
        record("RGB → CMYK", True, f"输出 {out.stat().st_size} 字节")
    except Exception as exc:  # noqa: BLE001
        record("RGB → CMYK", False, str(exc))
        return

    # 4. 验证确实是 CMYK：内容流里的 k/K 算子 + 资源里的 /DeviceCMYK
    try:
        import pikepdf

        cmyk_ops = rgb_ops = 0
        with pikepdf.open(out) as pdf:
            for page in pdf.pages:
                try:
                    for _operands, operator in pikepdf.parse_content_stream(page):
                        op = str(operator)
                        if op in ("k", "K"):
                            cmyk_ops += 1
                        elif op in ("rg", "RG"):
                            rgb_ops += 1
                except Exception:  # noqa: BLE001
                    continue
            cs_cmyk = sum(1 for o in pdf.objects if isinstance(o, pikepdf.Name) and str(o) == "/DeviceCMYK")
            cs_rgb = sum(1 for o in pdf.objects if isinstance(o, pikepdf.Name) and str(o) == "/DeviceRGB")

        ok = cmyk_ops > 0 or cs_cmyk > 0
        detail = (
            f"CMYK 算子 {cmyk_ops} 处，RGB 算子 {rgb_ops} 处；"
            f"资源 /DeviceCMYK {cs_cmyk} 处，/DeviceRGB {cs_rgb} 处"
        )
        record("CMYK 验证", ok, detail)
    except Exception as exc:  # noqa: BLE001
        record("CMYK 验证", False, str(exc))


def main() -> int:
    print(f"工作目录: {ROOT}")
    print(f"Python  : {sys.version.split()[0]} ({sys.executable})\n")

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        check_deps()
        src = check_fonts(tmp)
        check_ghostscript(tmp, src)

    width = max(len(n) for n, _, _ in results)
    failed = 0
    for name, ok, detail in results:
        if not ok:
            failed += 1
        print(f"[{'PASS' if ok else 'FAIL'}] {name.ljust(width)}  {detail}")

    print(f"\n{len(results) - failed}/{len(results)} 项通过")
    if failed:
        print("有失败项，先补齐再写代码。")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

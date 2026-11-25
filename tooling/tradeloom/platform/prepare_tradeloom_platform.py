#!/usr/bin/env python3
"""Apply TradeLoom-only native identities to an isolated archived source tree."""

from __future__ import annotations

import argparse
from pathlib import Path
import plistlib
import sys


IOS_BUNDLE = "io.github.ccch1mneyyy.tradeloom"
IOS_GROUP = f"group.{IOS_BUNDLE}"
OHOS_BUNDLE = IOS_BUNDLE


def patch_tree(root: Path, platform: str) -> dict[str, int | str]:
    app = root / "app"
    if not app.is_dir():
        raise SystemExit(f"Expected repository root with app/: {root}")

    base = app / ("ios" if platform == "ios" else "ohos")
    if not base.is_dir():
        raise SystemExit(f"Missing platform source: {base}")

    suffixes = (
        {".pbxproj", ".entitlements", ".plist", ".swift", ".m", ".h", ".strings", ".xcconfig", ".md"}
        if platform == "ios"
        else {".ets", ".json", ".json5", ".md", ".yaml", ".yml", ".cpp", ".h"}
    )
    replacements = {
        "io.github.ccch1mneyyy.dshgo": IOS_BUNDLE,
        "DSH Go": "TradeLoom",
        "dshgo://": "tradeloom://",
    }
    if platform == "ios":
        replacements['<string>dshgo</string>'] = '<string>tradeloom</string>'
        replacements['"dshgo"'] = '"tradeloom"'
    else:
        replacements.update(
            {
                "ccchimneyyy.dsh.go": OHOS_BUNDLE,
                "'dshgo'": "'tradeloom'",
                '"dshgo"': '"tradeloom"',
            }
        )

    changed = 0
    files = 0
    for path in base.rglob("*"):
        if path.is_symlink() or not path.is_file() or path.suffix.lower() not in suffixes:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        original = text
        for old, new in replacements.items():
            text = text.replace(old, new)
        if text != original:
            path.write_text(text, encoding="utf-8", newline="")
            files += 1
            changed += len(original) - len(text)

    if platform == "ohos":
        config = app / "ohos" / "AppScope" / "app.json5"
        if OHOS_BUNDLE not in config.read_text(encoding="utf-8"):
            raise SystemExit("Harmony bundleName was not changed")
        build_script = root / "tooling" / "ohos" / "build-hap.sh"
        script = build_script.read_text(encoding="utf-8")
        original = '"$FLUTTER" build hap "$MODE" --target-platform ohos-arm64 --no-tree-shake-icons --dart-define=ENABLE_FLEX_OVERFLOW=false'
        branded = original + ' --dart-define=TRADELOOM_BRAND=true'
        if script.count(original) != 1:
            raise SystemExit("Could not identify the single upstream Harmony build command")
        script = script.replace(original, branded)
        build_script.write_text(script, encoding="utf-8", newline="")

    content = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in base.rglob("*")
        if path.is_file() and not path.is_symlink() and path.suffix.lower() in suffixes
    )
    if "io.github.ccch1mneyyy.dshgo" in content or "DSH Go" in content or "dshgo://" in content:
        raise SystemExit("TradeLoom platform identity check failed")
    if platform == "ios":
        expected_ids = (
            IOS_BUNDLE,
            IOS_BUNDLE + ".ShareExtension",
            IOS_BUNDLE + ".CompanionWidget",
            IOS_BUNDLE + ".PhoneRunner",
        )
        missing = [identity for identity in expected_ids if identity not in content]
        if missing or IOS_GROUP not in content:
            raise SystemExit(
                "TradeLoom iOS identity rewrite incomplete "
                f"(missingTargets={missing}, appGroup={IOS_GROUP in content})"
            )
    if platform == "ohos" and (OHOS_BUNDLE not in content or "TRADELOOM_BRAND=true" not in script):
        raise SystemExit(
            "TradeLoom Harmony identity check failed "
            f"(bundle={OHOS_BUNDLE in content}, brandDefine={'TRADELOOM_BRAND=true' in script})"
        )
    return {"platform": platform, "textFilesChanged": files, "netTextBytesChanged": changed}


def validate_ios_export_options(path: Path, team_id: str, source_root: Path) -> dict[str, str | bool]:
    resolved = path.resolve(strict=True)
    source = source_root.resolve(strict=True)
    try:
        resolved.relative_to(source)
    except ValueError:
        pass
    else:
        raise SystemExit("Keep the local export options plist outside the source checkout")
    if not resolved.is_file():
        raise SystemExit("TRADELOOM_IOS_EXPORT_OPTIONS_PLIST must be a readable plist file")
    try:
        with resolved.open("rb") as stream:
            options = plistlib.load(stream)
    except Exception as error:
        raise SystemExit("TRADELOOM_IOS_EXPORT_OPTIONS_PLIST is not a valid plist") from error
    if not isinstance(options, dict):
        raise SystemExit("Export options plist must contain a dictionary")
    if options.get("destination") != "export":
        raise SystemExit("Export options must set destination=export; upload is disabled")
    if options.get("method") not in {"development", "ad-hoc", "enterprise"}:
        raise SystemExit("Export method must create an installable development, ad-hoc, or enterprise IPA")
    if options.get("signingStyle") != "manual" or options.get("teamID") != team_id:
        raise SystemExit("Export options must use manual signing and the selected Apple team")
    profiles = options.get("provisioningProfiles")
    required_ids = (
        IOS_BUNDLE,
        IOS_BUNDLE + ".ShareExtension",
        IOS_BUNDLE + ".CompanionWidget",
    )
    if not isinstance(profiles, dict) or any(
        not isinstance(profiles.get(identity), str) or not profiles[identity].strip()
        for identity in required_ids
    ):
        raise SystemExit("Export options must map the TradeLoom app and both embedded extensions to local profiles")
    return {"destination": "export", "method": str(options["method"]), "teamMatch": True, "bundleProfilesMatch": True}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, help="isolated repository archive root")
    parser.add_argument("--platform", choices=("ios", "ohos"))
    parser.add_argument("--validate-ios-export-options", type=Path)
    parser.add_argument("--team-id")
    parser.add_argument("--source-root", type=Path)
    args = parser.parse_args()
    if args.validate_ios_export_options is not None:
        if not args.team_id or not args.source_root:
            parser.error("export options validation requires --team-id and --source-root")
        print(validate_ios_export_options(args.validate_ios_export_options, args.team_id, args.source_root))
    elif args.root is not None and args.platform is not None:
        print(patch_tree(args.root.resolve(), args.platform))
    else:
        parser.error("provide --root with --platform, or validate export options")


if __name__ == "__main__":
    main()

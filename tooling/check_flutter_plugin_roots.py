#!/usr/bin/env python3
"""Verify Android native plugin roots agree with Dart's package configuration."""

import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import url2pathname


def package_root(config_path, root_uri):
    uri = urlsplit(root_uri)
    if uri.scheme == "file":
        location = f"//{uri.netloc}{uri.path}" if uri.netloc else uri.path
        return Path(url2pathname(location)).resolve()
    if not uri.scheme and not uri.netloc:
        return (config_path.parent / url2pathname(uri.path)).resolve()
    raise ValueError(f"unsupported package root URI: {root_uri}")


def check_plugins(app):
    config_path = app / ".dart_tool/package_config.json"
    registry_path = app / ".flutter-plugins-dependencies"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    roots = {package["name"]: package["rootUri"] for package in config["packages"]}

    issues = []
    # Flutter omits the Android list altogether when there are no Android plugins.
    for plugin in registry["plugins"].get("android", []):
        if plugin.get("native_build") is False:
            continue
        name = plugin["name"]
        actual = Path(plugin["path"]).resolve()
        if name not in roots:
            issues.append(f"{name}: missing from package_config.json")
            continue
        expected = package_root(config_path, roots[name])
        if actual != expected:
            issues.append(f"{name}: registry root {actual} differs from Dart root {expected}")
        elif not actual.is_dir():
            issues.append(f"{name}: plugin root does not exist: {actual}")
    # These Java plugins initialize the native JNI bridge before Dart starts.
    registrant = app / "android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java"
    if not registrant.is_file():
        issues.append(f"missing generated Java plugin registrant: {registrant}")
        return issues

    registrations = {line.strip() for line in registrant.read_text(encoding="utf-8").splitlines()}
    android_plugins = {plugin["name"] for plugin in registry["plugins"].get("android", [])}
    jni_plugin_classes = {
        "jni": "com.github.dart_lang.jni.JniPlugin",
        "jni_flutter": "com.github.dart_lang.jni_flutter.JniFlutterPlugin",
    }
    for name, java_class in jni_plugin_classes.items():
        if name in android_plugins and f"flutterEngine.getPlugins().add(new {java_class}());" not in registrations:
            issues.append(f"{name}: missing Java registration for {java_class} in {registrant.name}")
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    args = parser.parse_args()
    try:
        issues = check_plugins(args.app)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        issues = [str(error)]
    if issues:
        parser.exit(
            1,
            "build-apk: --no-pub requires matching generated Android plugin metadata. "
            "Regenerate it from the locked dependency graph.\n"
            + "\n".join(issues)
            + "\n",
        )


if __name__ == "__main__":
    main()

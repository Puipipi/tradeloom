#!/usr/bin/env python3
"""The report scripts/stats.sh prints, from the rows it fetched.

    python3 scripts/stats-report.py <dir with downloads.json, checks.json, usage.json> <days> [today]

Rows are Analytics Engine SQL API answers ({"data": [...]}, numbers maybe as
strings). Days are UTC+8 dates; [today] defaults to today there.
"""

import datetime
import json
import os
import sys
import unicodedata
from collections import Counter, defaultdict

FEATURES = [("turns", "对话轮次"), ("voice", "语音输入"), ("phone", "手机操控"), ("share", "分享"), ("gen", "生成"), ("plugins", "插件")]
# v3 (1.0.17 on); 0 in older reports. stats.sh names the call count "calls".
FEATURES_V3 = [("tavern", "酒馆"), ("room", "伙伴小屋"), ("calls", "通话")]
TOKENS = [("tok_in", "输入"), ("tok_out", "输出")]
MERGED = [f for f, _ in FEATURES + FEATURES_V3 + TOKENS] + ["v"]
ROUTES = [("cn", "国内"), ("global", "海外"), ("github", "GitHub")]


def load(folder, name):
    try:
        with open(os.path.join(folder, f"{name}.json"), encoding="utf-8") as f:
            return json.load(f).get("data") or []
    except FileNotFoundError:
        return []


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def shift(day, n):
    return (datetime.date.fromisoformat(day) + datetime.timedelta(days=n)).isoformat()


def width(text):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def table(headers, rows):
    """Left-aligned first column, the rest right-aligned; CJK counts double."""
    cells = [[str(c) for c in r] for r in [headers, *rows]]
    widths = [max(width(r[i]) for r in cells) for i in range(len(headers))]
    out = []
    for r in cells:
        parts = []
        for i, c in enumerate(r):
            gap = " " * (widths[i] - width(c))
            parts.append(c + gap if i == 0 or i == len(r) - 1 and not c.replace(",", "").isdigit() else gap + c)
        out.append("  ".join(parts).rstrip())
    return "\n".join(out)


# Fewest installs a model or system must share to be named in the report.
MIN_GROUP = 20


def spread(counter, top=6, unknown="未上报"):
    total = sum(counter.values())
    if not total:
        return "—"
    items = counter.most_common()
    shown = items[:top]
    rest = sum(n for _, n in items[top:])
    parts = [f"{k or unknown} {round(100 * n / total)}%" for k, n in shown]
    if rest:
        parts.append(f"其他 {round(100 * rest / total)}%")
    return " · ".join(parts)


def fmt(n):
    return f"{int(round(n)):,}"


def main():
    folder, days = sys.argv[1], int(sys.argv[2])
    today = (sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else
             (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)).date().isoformat())
    window = [shift(today, -i) for i in range(days - 1, -1, -1)]
    inside = set(window)
    print(f"DSH Go 统计 · {window[0]} – {window[-1]}（UTC+8）")

    # ── Downloads ──
    clicks = defaultdict(float)
    by_route = defaultdict(float)
    by_version = defaultdict(Counter)
    people = defaultdict(set)
    countries = Counter()
    for r in load(folder, "downloads"):
        day = r.get("day")
        if day not in inside:
            continue
        n = num(r.get("n"))
        clicks[day] += n
        by_route[(day, r.get("route"))] += n
        by_version[day][r.get("version") or "?"] += n
        countries[r.get("country") or "XX"] += n
        if r.get("device"):
            people[day].add(r["device"])
    print("\n下载（点下载按钮的次数；人 = 当天去重的设备码）")
    rows = []
    for day in window:
        if not clicks[day]:
            continue
        versions = " ".join(f"{v}×{fmt(n)}" for v, n in by_version[day].most_common(3))
        rows.append([day, fmt(clicks[day]), fmt(len(people[day])), *[fmt(by_route[(day, k)]) for k, _ in ROUTES], versions])
    if rows:
        rows.append(["合计", fmt(sum(clicks.values())), "", *[fmt(sum(v for (d, k2), v in by_route.items() if k2 == k)) for k, _ in ROUTES], ""])
        print(table(["日期", "次数", "人", *[label for _, label in ROUTES], "版本"], rows))
        print(f"国家/地区：{spread(countries, top=8, unknown='XX')}")
    else:
        print("（没有数据）")

    # ── Update checks: near-daily-active ──
    devices = defaultdict(set)
    checks = defaultdict(float)
    app_of = defaultdict(dict)
    for r in load(folder, "checks"):
        day = r.get("day")
        if day not in inside:
            continue
        checks[day] += num(r.get("n"))
        if r.get("device"):
            devices[day].add(r["device"])
            app_of[day][r["device"]] = r.get("app") or ""
    print("\n近似日活（App 检查更新，只含带通道令牌的包；同一 IP 与 UA 算一台，NAT 下会低估）")
    rows = []
    for day in window:
        if not checks[day]:
            continue
        rows.append([day, fmt(len(devices[day])), fmt(checks[day]), spread(Counter(app_of[day].values()), top=3)])
    print(table(["日期", "设备", "检查次数", "版本（按设备）"], rows) if rows else "（没有数据）")

    # ── The app's own reports ──
    reports = {}
    for r in load(folder, "usage"):
        day, device = r.get("day"), r.get("device")
        if not day or not device:
            continue
        key = (day, device)
        have = reports.get(key)
        if have is None or num(r.get("build")) > num(have.get("build")):
            merged = dict(r)
            if have:
                for f in MERGED:
                    merged[f] = max(num(have.get(f)), num(r.get(f)))
            reports[key] = merged
        else:
            for f in MERGED:
                have[f] = max(num(have.get(f)), num(r.get(f)))
    seen = defaultdict(set)
    for day, device in reports:
        seen[device].add(day)
    print("\nApp 统计（0.9.9 起，用户可关闭；同一安装同一天只算一次）")
    rows = []
    for day in window:
        today_reports = [v for (d, _), v in reports.items() if d == day]
        if not today_reports:
            continue
        rows.append([day, fmt(len(today_reports)), *[fmt(sum(num(v.get(f)) for v in today_reports)) for f, _ in FEATURES]])
    print(table(["日期", "日活", *[label for _, label in FEATURES]], rows) if rows else "（没有数据）")

    # v3: who used the tavern, the room and calls, and the tokens model
    # replies reported. Only v3 reports say; older ones are left out.
    v3_days = []
    for day in window:
        v3 = [v for (d, _), v in reports.items() if d == day and num(v.get("v")) >= 3]
        if v3:
            v3_days.append((day, v3))
    if v3_days:
        print("\n酒馆、伙伴小屋、通话（1.0.17 起；台 = 当天用过的安装数，次 = 合计；只算 v3 报告）")
        rows = []
        for day, v3 in v3_days:
            cells = []
            for f, _ in FEATURES_V3:
                cells += [fmt(sum(1 for v in v3 if num(v.get(f)) > 0)), fmt(sum(num(v.get(f)) for v in v3))]
            rows.append([day, fmt(len(v3)), *cells])
        heads = [h for _, label in FEATURES_V3 for h in (f"{label}·台", f"{label}·次")]
        print(table(["日期", "v3 日活", *heads], rows))
        print("\nToken（模型回复里报了用量的才算，不估算；人均 = 合计 ÷ 有 token 记录的安装）")
        rows = []
        for day, v3 in v3_days:
            spent = [v for v in v3 if num(v.get("tok_in")) + num(v.get("tok_out")) > 0]
            totals = [sum(num(v.get(f)) for v in spent) for f, _ in TOKENS]
            per = [fmt(t / len(spent)) if spent else "—" for t in totals]
            rows.append([day, fmt(len(spent)), *[fmt(t) for t in totals], *per])
        print(table(["日期", "有记录的安装", *[f"{label}合计" for _, label in TOKENS], *[f"人均{label}" for _, label in TOKENS]], rows))

    if reports:
        print("\n7 日留存（D 天新出现的安装中，D+7 天仍上报的比例；此前 21 天没出现过算新安装，所以是粗略值）")
        rows = []
        for day in window:
            if shift(day, 7) > today:
                continue
            earlier = {shift(day, -i) for i in range(1, 22)}
            new = [d for d, active in seen.items() if day in active and not active & earlier]
            if not new:
                continue
            back = sum(1 for d in new if shift(day, 7) in seen[d])
            rows.append([day, fmt(len(new)), fmt(back), f"{round(100 * back / len(new))}%"])
        print(table(["日期", "新安装", "第 7 天", "留存"], rows) if rows else "（还不满 7 天）")

        latest = {}
        for (day, device), v in reports.items():
            if day in inside and (device not in latest or day > latest[device][0]):
                latest[device] = (day, v)
        print(f"\n分布（窗口内 {fmt(len(latest))} 个安装，各取最近一次上报）")
        for field, label in [("app", "版本"), ("abi", "ABI"), ("maker", "厂商"), ("engine", "运行方式"), ("lang", "语言"), ("sdk", "系统 API")]:
            values = Counter(str(int(num(v.get(field)))) if field == "sdk" else (v.get(field) or "") for _, v in latest.values())
            print(f"{label}：{spread(values)}")
        # Model and system come from 1.0.15 on. A value fewer than MIN_GROUP
        # installs share would point at too few people: it goes under 其他.
        for field, label in [("model", "机型"), ("rom", "系统版本")]:
            values = Counter(v.get(field) for _, v in latest.values() if v.get(field))
            if not values:
                print(f"{label}：—（1.0.15 起才上报）")
                continue
            kept = Counter({k: n for k, n in values.items() if n >= MIN_GROUP})
            kept["其他"] = 0
            small = sum(n for k, n in values.items() if n < MIN_GROUP)
            if small:
                kept["其他"] = small
            else:
                del kept["其他"]
            print(f"{label}（{fmt(sum(values.values()))} 个安装上报）：{spread(kept, top=10)}")


if __name__ == "__main__":
    main()

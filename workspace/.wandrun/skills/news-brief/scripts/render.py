#!/usr/bin/env python3
"""把 brief.json 渲染为可预览的 brief.html，并逐页截成 1080x1440 PNG。

用法：python3 render.py brief.json 输出目录 [--html-only]
退出码：0 成功；1 输入或版面问题（stderr 说明哪一页、怎么改）；2 环境问题。
只用标准库和本机 Chrome（google-chrome / chromium，或环境变量 CHROME）。
"""

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
ASSETS = SKILL / "assets"
FONTS = [
    ("Inter", 400, "normal", "inter-latin-400-normal.woff2"),
    ("Inter", 600, "normal", "inter-latin-600-normal.woff2"),
    ("Inter", 800, "normal", "inter-latin-800-normal.woff2"),
    ("Instrument Serif", 400, "normal", "instrument-serif-latin-400-normal.woff2"),
    ("Instrument Serif", 400, "italic", "instrument-serif-latin-400-italic.woff2"),
]
# 字数上限按版面实测；超出时多半会溢出，提前给出可操作的提示。
LIMITS = {"headline": 22, "title": 40, "short_title": 18, "summary": 90, "point": 48, "why": 80, "tag": 6}


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    sys.exit(code)


def plain_len(text: str) -> float:
    """按显示宽度计字数：汉字与全角符号记 1，ASCII 记 0.55。"""
    return sum(0.55 if ord(c) < 128 else 1 for c in re.sub(r"\*\*", "", text or ""))


def validate(data: dict) -> list[str]:
    problems = []
    for key in ("masthead", "issue", "date_label", "headline", "stories"):
        if not data.get(key):
            problems.append(f"缺少字段 {key}")
    stories = data.get("stories") or []
    if not 1 <= len(stories) <= 8:
        problems.append(f"stories 需要 1～8 条，现在 {len(stories)} 条")
    if plain_len(data.get("headline", "")) > LIMITS["headline"]:
        problems.append(f"headline 超过 {LIMITS['headline']} 字")
    for i, st in enumerate(stories, 1):
        for key in ("title", "tag", "source"):
            if not st.get(key):
                problems.append(f"第 {i} 条缺少 {key}")
        for key in ("title", "short_title", "summary", "why", "tag"):
            if plain_len(st.get(key, "")) > LIMITS[key]:
                problems.append(f"第 {i} 条 {key} 超过 {LIMITS[key]} 字，请改短")
        points = st.get("points") or []
        if len(points) > 4:
            problems.append(f"第 {i} 条 points 最多 4 条")
        for p in points:
            if plain_len(p) > LIMITS["point"]:
                problems.append(f"第 {i} 条有要点超过 {LIMITS['point']} 字：{p[:20]}…")
        facts = st.get("facts") or []
        if len(facts) > 3:
            problems.append(f"第 {i} 条 facts 最多 3 个")
        # 三列时格子窄，数值超过约 7 个汉字宽就会折行。
        width = {1: 20, 2: 11, 3: 7}.get(len(facts), 7)
        for f in facts:
            if plain_len(str(f.get("value", ""))) > width:
                problems.append(f"第 {i} 条 facts 值“{f.get('value')}”过长（{len(facts)} 列时 ≤ {width}），把说明移到 label")
        if not st.get("short_title") and plain_len(st.get("title", "")) > LIMITS["short_title"]:
            problems.append(f"第 {i} 条标题较长，请补 short_title（≤{LIMITS['short_title']} 字）用于封面目录")
    return problems


def build_html(data: dict) -> str:
    faces = []
    for family, weight, style, name in FONTS:
        encoded = base64.b64encode((ASSETS / "fonts" / name).read_bytes()).decode()
        faces.append(
            f'@font-face{{font-family:"{family}";font-weight:{weight};font-style:{style};'
            f'src:url(data:font/woff2;base64,{encoded}) format("woff2");}}'
        )
    template = (ASSETS / "template.html").read_text(encoding="utf-8")
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    return template.replace("/*__FONTS__*/", "\n".join(faces)).replace("/*__DATA__*/", payload)


def chrome_binary() -> str:
    for candidate in (os.environ.get("CHROME"), "google-chrome", "chromium", "chromium-browser"):
        if candidate and shutil.which(candidate):
            return shutil.which(candidate)
    fail("找不到 Chrome：请安装 google-chrome，或设置环境变量 CHROME", 2)


def run_chrome(args: list[str], profile: str) -> subprocess.CompletedProcess:
    command = [chrome_binary(), "--headless=new", "--no-first-run", "--hide-scrollbars",
               "--disable-gpu", f"--user-data-dir={profile}", "--virtual-time-budget=4000", *args]
    return subprocess.run(command, capture_output=True, text=True, timeout=90)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        fail(__doc__)
    source, out = Path(args[0]), Path(args[1])
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"读取 {source} 失败：{error}")
    problems = validate(data)
    if problems:
        fail("内容不符合版面要求：\n- " + "\n- ".join(problems))

    out.mkdir(parents=True, exist_ok=True)
    html_path = (out / "brief.html").resolve()
    html_path.write_text(build_html(data), encoding="utf-8")
    url = html_path.as_uri()

    with tempfile.TemporaryDirectory(prefix="news-brief-") as profile:
        dom = run_chrome(["--window-size=600,900", "--dump-dom", f"{url}#check"], profile)
        pages = re.search(r'data-pages="(\d+)"', dom.stdout)
        if not pages:
            fail(f"Chrome 未能完成排版：{dom.stderr.strip()[-400:]}", 2)
        overflow = re.search(r'data-overflow="([\d,]*)"', dom.stdout).group(1)
        if overflow:
            fail(f"第 {overflow} 页内容超出版面：删减该页 summary / points / why，或减少 facts 后重试")
        print(f"预览：{html_path}")
        if "--html-only" in sys.argv:
            return
        for old in out.glob("page-*.png"):
            old.unlink()
        for n in range(1, int(pages.group(1)) + 1):
            target = out / f"page-{n:02d}.png"
            shot = run_chrome(["--window-size=540,720", "--force-device-scale-factor=2",
                               f"--screenshot={target}", f"{url}#page={n}"], profile)
            if not target.exists():
                fail(f"第 {n} 页截图失败：{shot.stderr.strip()[-400:]}", 2)
            print(target)


if __name__ == "__main__":
    main()

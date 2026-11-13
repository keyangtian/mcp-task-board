#!/usr/bin/env python3
"""Render docs/demo.gif from real transcripts captured in tools/.

The transcripts are real stdout of `node examples/demo.mjs` and
`node examples/a2a-client.mjs`; this script only prettifies them into a
terminal-style animation. Regenerate after changing the examples:

    node examples/demo.mjs   > tools/demo-output.txt
    node examples/a2a-client.mjs > tools/a2a-output.txt
    python tools/make-demo-gif.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "demo.gif"
PREVIEW = Path(sys.argv[1]) if len(sys.argv) > 1 else None

WIDTH, HEIGHT = 1120, 720
PAD_X, PAD_TOP, PAD_BOTTOM = 30, 70, 34
BG = (13, 17, 23)
BAR = (22, 27, 34)
FG = (201, 209, 217)
DIM = (139, 148, 158)
CYAN = (121, 192, 255)
GREEN = (126, 231, 135)
YELLOW = (227, 179, 65)
RED = (255, 123, 114)
FONT_SIZE = 17
LINE_H = 25

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\consola.ttf",
    r"C:\Windows\Fonts\CascadiaMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
]


def load_font(size: int):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def read_lines(name: str) -> list[str]:
    p = ROOT / "tools" / name
    return p.read_text(encoding="utf-8-sig").splitlines()


def scrub(lines: list[str]) -> list[str]:
    ids: dict[str, str] = {}

    def id_sub(m: re.Match) -> str:
        raw = m.group(0)
        if raw not in ids:
            ids[raw] = f"ab-20261113-1654-{len(ids) + 1:02d}"
        return ids[raw]

    out = []
    for line in lines:
        line = re.sub(r"[A-Za-z]:\\[^\s\"']*?(?:Temp|tmp)[^\s\"']*", "<tmp>/mcp-task-board", line)
        line = re.sub(r"ab-\d{8}-\d{6}-[0-9a-f]{6}", id_sub, line)
        line = re.sub(r"127\.0\.0\.1:\d{4,5}", "127.0.0.1:7801", line)
        line = re.sub(r"mcp-task-board-a2a-demo-[A-Za-z0-9]+", "mcp-task-board-demo", line)
        out.append(line.rstrip("\r"))
    return out


def color_for(line: str) -> tuple[int, int, int]:
    stripped = line.strip()
    if stripped.startswith("$ "):
        return CYAN
    if "winner" in stripped or "COMPLETED" in stripped or "completed: done" in stripped:
        return GREEN
    if "failed=" in stripped and "failed=0" not in stripped:
        return RED
    if stripped.startswith("{") or stripped.startswith("}"):
        return DIM
    if stripped.startswith("artifact:") or stripped.startswith("  \"") or stripped.startswith("  }"):
        return YELLOW
    if stripped.startswith("[") or " claimed " in stripped or " saw:" in stripped:
        return GREEN
    return FG


def script_lines() -> list[tuple[str, tuple[int, int, int]]]:
    demo = scrub(read_lines("demo-output.txt"))
    a2a = scrub(read_lines("a2a-output.txt"))
    lines: list[tuple[str, tuple[int, int, int]]] = []
    lines.append(("$ node examples/demo.mjs", CYAN))
    lines.append(("", FG))
    lines.extend((line, color_for(line)) for line in demo)
    lines.append(("", FG))
    lines.append(("$ node examples/a2a-client.mjs", CYAN))
    lines.append(("", FG))
    lines.extend((line, color_for(line)) for line in a2a)
    return lines


def draw_frame(lines, visible: int, cursor: bool, font):
    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    d = ImageDraw.Draw(img)

    # window bar
    d.rectangle([0, 0, WIDTH, 46], fill=BAR)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([22 + i * 22, 17, 34 + i * 22, 29], fill=c)
    d.text((WIDTH // 2, 23), "mcp-task-board  -  one board, both agents", font=font, fill=DIM, anchor="mm")

    # terminal body
    d.rectangle([0, 46, WIDTH, HEIGHT], fill=BG)
    max_lines = (HEIGHT - PAD_TOP - PAD_BOTTOM) // LINE_H
    shown = lines[:visible]
    if len(shown) > max_lines:
        shown = shown[-max_lines:]
    y = PAD_TOP
    for i, (text, color) in enumerate(shown):
        x = PAD_X
        d.text((x, y), text, font=font, fill=color)
        if cursor and i == len(shown) - 1:
            w = d.textlength(text, font=font)
            d.rectangle([x + w + 4, y + 2, x + w + 12, y + LINE_H - 4], fill=FG)
        y += LINE_H

    # footer
    d.text((PAD_X, HEIGHT - 26), "atomic claims · leases · capability routing · A2A", font=font, fill=DIM)
    d.text((WIDTH - PAD_X, HEIGHT - 26), "github.com/keyangtian/mcp-task-board", font=font, fill=DIM, anchor="ra")
    return img


def main():
    font = load_font(FONT_SIZE)
    lines = script_lines()
    frames = []
    durations = []

    for i in range(1, len(lines) + 1):
        frames.append(draw_frame(lines, i, cursor=True, font=font))
        durations.append(70)
    # hold the full screen
    full = draw_frame(lines, len(lines), cursor=False, font=font)
    for _ in range(3):
        frames.append(full.copy())
        durations.append(900)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        OUT,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )
    if PREVIEW:
        frames[-1].save(PREVIEW)
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KiB, {len(frames)} frames)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Parse IRA Harvester themes from THEMES.md (often RTF-wrapped)."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def _replace_unicode_escape(match: re.Match[str]) -> str:
    n = int(match.group(1))
    if n < 0:
        n += 65536
    if 0 <= n < 0x110000 and not (0xD800 <= n <= 0xDFFF):
        return chr(n)
    return ""


def rtf_to_plain(raw: bytes) -> str:
    text = raw.decode("cp1252", errors="replace")
    text = re.sub(r"\\u(-?\d+)\s?", _replace_unicode_escape, text)
    text = re.sub(
        r"\\'([0-9a-fA-F]{2})",
        lambda m: bytes.fromhex(m.group(1)).decode("cp1252", "replace"),
        text,
    )

    out: list[str] = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == "\\":
            if text.startswith("\\par", i):
                out.append("\n")
                i += 4
                continue
            if text.startswith("\\tab", i):
                out.append("\t")
                i += 4
                continue
            if text.startswith("\\\n", i) or text.startswith("\\\r", i):
                out.append("\n")
                i += 2
                continue
            i += 1
            while i < len(text) and text[i].isalpha():
                i += 1
            if i < len(text) and text[i] == "-":
                i += 1
                while i < len(text) and text[i].isdigit():
                    i += 1
            elif i < len(text) and text[i].isdigit():
                while i < len(text) and text[i].isdigit():
                    i += 1
            if i < len(text) and text[i] == " ":
                i += 1
            continue
        if c in "{}":
            i += 1
            continue
        if 0xD800 <= ord(c) <= 0xDFFF:
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def parse_themes(path: Path) -> list[dict[str, str]]:
    raw = path.read_bytes()
    if raw.lstrip().startswith(b"{\\rtf"):
        plain = rtf_to_plain(raw)
    else:
        plain = raw.decode("utf-8", errors="replace")

    rows: list[dict[str, str]] = []
    for line in plain.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line.startswith("|"):
            continue
        if "Theme Name" in line:
            continue
        if re.match(r"^\|[\s\-|]+\|$", line):
            continue
        parts = [p.strip() for p in line.strip("|").split("|")]
        if len(parts) >= 3 and parts[0]:
            rows.append(
                {
                    "theme": parts[0],
                    "previous_score": parts[1],
                    "tier": parts[2],
                }
            )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="Path to THEMES.md")
    parser.add_argument(
        "--format",
        choices=("json", "tsv", "count"),
        default="json",
        help="Output format",
    )
    args = parser.parse_args()
    if not args.path.is_file():
        print(f"error: missing themes file: {args.path}", file=sys.stderr)
        return 2

    rows = parse_themes(args.path)
    if args.format == "count":
        print(len(rows))
        return 0 if rows else 1
    if args.format == "tsv":
        for row in rows:
            print(f"{row['theme']}\t{row['previous_score']}\t{row['tier']}")
        return 0 if rows else 1
    print(json.dumps(rows, indent=2, ensure_ascii=True))
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())

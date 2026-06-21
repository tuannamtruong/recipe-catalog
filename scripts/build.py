#!/usr/bin/env python3
"""Build dist/recipes.html — a single self-contained HTML file with
CSS + JS + recipe data inlined. Copies recipe_images/ next to it.

Open dist/recipes.html directly from disk (or AirDrop the dist/ folder to
a phone) for read-only browsing. No server needed in that mode.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

# Reuse the server's markdown parser so the baked data has identical shape
# to what the API would return.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import load_conversions, parse_markdown  # noqa: E402

SRC = ROOT / "src"
RECIPES_DIR = ROOT / "recipes"
IMAGES_DIR = ROOT / "recipe_images"
DIST = ROOT / "dist"


def load_recipes() -> list[dict]:
    out = []
    if not RECIPES_DIR.exists():
        return out
    for path in sorted(RECIPES_DIR.glob("*.md")):
        rec = parse_markdown(path.read_text(encoding="utf-8"))
        rec["slug"] = path.stem
        out.append(rec)
    return out


def main() -> int:
    html = (SRC / "recipes.html").read_text(encoding="utf-8")
    css = (SRC / "style.css").read_text(encoding="utf-8")
    js = (SRC / "app.js").read_text(encoding="utf-8")
    recipes = load_recipes()

    # Replace external <link rel="stylesheet" href="/style.css"> with inline <style>.
    # Use lambda to avoid re.sub interpreting \w/\s in the replacement.
    style_block = f"<style>\n{css}\n</style>"
    html = re.sub(
        r'<link\s+rel="stylesheet"\s+href="/style\.css"\s*/?\s*>',
        lambda _: style_block,
        html,
        count=1,
    )

    # Replace external <script src="/app.js"></script> with inline data + script.
    baked = (
        "const __BAKED_RECIPES__ = " + json.dumps(recipes, ensure_ascii=False) + ";\n"
        + "const __BAKED_CONVERSIONS__ = " + json.dumps(load_conversions(), ensure_ascii=False) + ";"
    )
    inline_script = f"<script>\n{baked}\n{js}\n</script>"
    html = re.sub(
        r'<script\s+src="/app\.js"\s*></script>',
        lambda _: inline_script,
        html,
        count=1,
    )

    DIST.mkdir(parents=True, exist_ok=True)
    out_html = DIST / "recipes.html"
    out_html.write_text(html, encoding="utf-8")

    # Mirror recipe_images/ into dist/ so <img src="/recipe_images/..."> works
    # when the file is opened from disk (sibling folder).
    out_images = DIST / "recipe_images"
    if out_images.exists():
        shutil.rmtree(out_images)
    if IMAGES_DIR.exists():
        shutil.copytree(IMAGES_DIR, out_images)
    else:
        out_images.mkdir(parents=True, exist_ok=True)

    print(f"wrote {out_html} ({out_html.stat().st_size:,} bytes, {len(recipes)} recipes)")
    print(f"wrote {out_images}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())

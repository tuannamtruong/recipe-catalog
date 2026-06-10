#!/usr/bin/env python3
"""One-shot import: Cooking.docx -> recipes/*.md.

Run once after cloning. Re-running overwrites only NEW recipes;
existing files are left alone so manual edits survive.

Best-effort: each recipe body is classified line-by-line into
ingredients vs steps. ~20-30% will need manual cleanup.
"""
from __future__ import annotations

import re
import sys
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
DOCX = ROOT / "Cooking.docx"
OUT = ROOT / "recipes"

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}

# Keywords that hint at the category section currently being read.
# Order matters slightly — first match wins, evaluated against the most
# recent ~3 paragraphs of plain text leading up to a heading.
CATEGORY_HINTS = [
    ("beef", "Beef"), ("steak", "Beef"), ("meatball", "Beef"),
    ("meatloaf", "Beef"), ("burrito", "Beef"), ("goulasch", "Beef"),
    ("goulash", "Beef"), ("stroganoff", "Beef"), ("sirloin", "Beef"),
    ("tenderloin", "Pork"), ("pork", "Pork"), ("ham", "Pork"),
    ("sausage", "Pork"), ("rib", "Pork"), ("char siu", "Pork"),
    ("chicken", "Chicken"), ("drumstick", "Chicken"), ("wing", "Chicken"),
    ("shrimp", "Seafood"), ("tuna", "Seafood"), ("fish", "Seafood"),
    ("salmon", "Seafood"), ("cod", "Seafood"), ("squid", "Seafood"),
    ("cauliflower", "Vegetables"), ("eggplant", "Vegetables"),
    ("zucchini", "Vegetables"), ("kohlrabi", "Vegetables"),
    ("tofu", "Vegetables"), ("vegetable", "Vegetables"),
    ("salad", "Salad"),
    ("soup", "Soup"), ("stew", "Soup"), ("pho", "Soup"),
    ("rice", "Rice & Noodles"), ("noodle", "Rice & Noodles"),
    ("pasta", "Rice & Noodles"), ("pho", "Rice & Noodles"),
    ("curry", "Curry"),
    ("sauce", "Sauce"), ("dressing", "Sauce"),
    ("bread", "Bread & Baking"), ("pizza", "Bread & Baking"),
    ("dough", "Bread & Baking"),
    ("cake", "Dessert"), ("cookie", "Dessert"), ("pancake", "Dessert"),
    ("oat", "Dessert"), ("dessert", "Dessert"),
    ("smoothie", "Drink"), ("drink", "Drink"),
    ("breakfast", "Breakfast"),
]

# Regexes for classifying a body line.
INGREDIENT_HINTS = re.compile(
    r"^\s*(?:[-•*•]\s*)?(?:"
    r"\d+[,.]?\d*\s*(?:g|kg|ml|l|tbs|tsp|tbsp|tps|cup|cups|oz|lb|pinch|nhúm|"
    r"củ|quả|trái|miếng|nhánh|cái|cốc|bát|chén|thìa|muỗng|gram)\b"
    r"|\d+/\d+\s*(?:g|cup|tbs|tsp|tbsp)"
    r"|\d+\s*(?:-|–)\s*\d+\s*\S+"
    r"|½|¼|¾|⅓|⅔"
    r")",
    re.IGNORECASE,
)
URL_RE = re.compile(r"https?://[^\s)>\]]+")
DURATION_RE = re.compile(
    r"(\d+)\s*(?:-\s*\d+\s*)?(min|mins|minute|minutes|phút|hour|hours|h\b)",
    re.IGNORECASE,
)


P_TAG = f"{{{W_NS}}}p"
TBL_TAG = f"{{{W_NS}}}tbl"
TR_TAG = f"{{{W_NS}}}tr"
TC_TAG = f"{{{W_NS}}}tc"
T_TAG = f"{{{W_NS}}}t"
BR_TAG = f"{{{W_NS}}}br"
TAB_TAG = f"{{{W_NS}}}tab"


def paragraph_lines(p: ET.Element) -> list[str]:
    """Extract text from a <w:p>, respecting <w:br/> as a line separator."""
    buf: list[str] = [""]
    for el in p.iter():
        if el.tag == T_TAG:
            buf[-1] += el.text or ""
        elif el.tag == BR_TAG:
            buf.append("")
        elif el.tag == TAB_TAG:
            buf[-1] += "\t"
    return [s.strip() for s in buf if s.strip()]


def paragraph_style(p: ET.Element) -> str | None:
    ppr = p.find("w:pPr", NS)
    if ppr is None:
        return None
    ps = ppr.find("w:pStyle", NS)
    if ps is None:
        return None
    return ps.get(f"{{{W_NS}}}val")


def cell_lines(tc: ET.Element) -> list[str]:
    out: list[str] = []
    for p in tc.findall("w:p", NS):
        out.extend(paragraph_lines(p))
    return out


def table_columns(tbl: ET.Element) -> list[list[str]]:
    """Return one list of lines per column, reading rows top-to-bottom.
    Most recipe tables are 1 row x 2 cells; some are 1x1 or larger.
    """
    rows = tbl.findall("w:tr", NS)
    if not rows:
        return []
    max_cols = max(len(r.findall("w:tc", NS)) for r in rows)
    cols: list[list[str]] = [[] for _ in range(max_cols)]
    for r in rows:
        for ci, tc in enumerate(r.findall("w:tc", NS)):
            cols[ci].extend(cell_lines(tc))
    return cols


def slugify(title: str) -> str:
    # Strip diacritics (Vietnamese tones, German umlauts) for the filename.
    norm = unicodedata.normalize("NFKD", title)
    norm = "".join(c for c in norm if not unicodedata.combining(c))
    norm = norm.replace("đ", "d").replace("Đ", "d")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", norm).strip("-").lower()
    return slug or "untitled"


def guess_category(history: list[str]) -> str:
    blob = " ".join(history[-5:]).lower()
    for keyword, cat in CATEGORY_HINTS:
        if keyword in blob:
            return cat
    return "Uncategorized"


def extract_url(lines: list[str]) -> tuple[str | None, list[str]]:
    """Return first URL found across lines, plus lines with that URL removed."""
    url: str | None = None
    out: list[str] = []
    for raw in lines:
        m = URL_RE.search(raw)
        if m and url is None:
            url = m.group(0)
            stripped = URL_RE.sub("", raw).strip(" :|—-")
            if stripped:
                out.append(stripped)
            continue
        out.append(raw)
    return url, out


def extract_duration(lines: list[str]) -> int | None:
    for raw in lines:
        m = DURATION_RE.search(raw)
        if m:
            val = int(m.group(1))
            if m.group(2).lower().startswith("h"):
                val *= 60
            return val
    return None


def classify_heuristic(lines: list[str]) -> tuple[list[str], list[str]]:
    """Fallback for recipes with no table: classify each line as ingredient or step."""
    ingredients: list[str] = []
    steps: list[str] = []
    seen_step = False
    for raw in lines:
        line = raw.strip().strip("•-*").strip()
        if not line:
            continue
        looks_ing = bool(INGREDIENT_HINTS.match(raw))
        if looks_ing and not seen_step:
            ingredients.append(line)
        else:
            steps.append(line)
            if not looks_ing:
                seen_step = True
    return ingredients, steps


def clean_lines(lines: list[str]) -> list[str]:
    out: list[str] = []
    for L in lines:
        s = L.strip().strip("•-*").strip()
        if s:
            out.append(s)
    return out


def yaml_escape(s: str) -> str:
    if any(c in s for c in ':#"\'\n[]{},&*!|>%@`'):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def emit_markdown(slug: str, title: str, category: str,
                  ingredients: list[str], steps: list[str],
                  source_url: str | None, duration: int | None) -> str:
    parts = [
        "---",
        f"title: {yaml_escape(title)}",
        f"categories: [{yaml_escape(category)}]",
    ]
    parts.append(f"duration_minutes: {duration}" if duration else "duration_minutes: null")
    parts.append("image: null")
    parts.append(f"source_url: {yaml_escape(source_url)}" if source_url else "source_url: null")
    parts.append("---")
    parts.append("")
    parts.append("## Ingredients")
    parts.extend(f"- {item}" for item in ingredients) if ingredients else parts.append("- ")
    parts.append("")
    parts.append("## Steps")
    if steps:
        for i, step in enumerate(steps, 1):
            parts.append(f"{i}. {step}")
    else:
        parts.append("1. ")
    parts.append("")
    return "\n".join(parts)


def main() -> int:
    if not DOCX.exists():
        print(f"missing {DOCX}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(DOCX) as zf:
        with zf.open("word/document.xml") as f:
            tree = ET.parse(f)
    root = tree.getroot()

    body = root.find("w:body", NS)
    if body is None:
        print("no <w:body> in document", file=sys.stderr)
        return 1

    # Walk body children in document order. Heading2/Heading3 paragraphs open
    # a recipe; the recipe owns the following paragraphs AND the next <w:tbl>
    # (whose 2 cells are ingredients [left] and steps [right]).
    recipes: list[dict] = []
    current: dict | None = None
    pre_history: list[str] = []

    for child in body:
        if child.tag == P_TAG:
            style = paragraph_style(child)
            lines = paragraph_lines(child)
            title = lines[0] if lines else ""
            if style in ("Heading2", "Heading3") and title:
                if current is not None:
                    recipes.append(current)
                current = {
                    "title": title,
                    "category": guess_category(pre_history + [title]),
                    "prelude": [],
                    "table_cols": [],
                    "post": [],
                }
                pre_history.append(title)
                continue
            pre_history.extend(lines)
            if current is None:
                continue
            target = "post" if current["table_cols"] else "prelude"
            current[target].extend(lines)
        elif child.tag == TBL_TAG:
            cols = table_columns(child)
            for c in cols:
                pre_history.extend(c)
            if current is None:
                continue
            if not current["table_cols"]:
                current["table_cols"] = cols
            else:
                for c in cols:
                    current["post"].extend(c)

    if current is not None:
        recipes.append(current)

    written = skipped = 0
    for r in recipes:
        slug = slugify(r["title"])
        path = OUT / f"{slug}.md"
        if path.exists():
            skipped += 1
            continue

        freeform = r["prelude"] + r["post"]
        url, freeform = extract_url(freeform)
        cols = r["table_cols"]

        if len(cols) >= 2:
            ingredients = clean_lines(cols[0])
            steps = clean_lines(cols[1])
            for extra in cols[2:]:
                steps.extend(clean_lines(extra))
        elif len(cols) == 1:
            ingredients, steps = classify_heuristic(cols[0])
        else:
            ingredients, steps = classify_heuristic(freeform)
            freeform = []

        leftover = clean_lines(freeform)
        if leftover:
            steps.extend(leftover)

        duration = extract_duration(ingredients + steps)

        path.write_text(
            emit_markdown(slug, r["title"], r["category"], ingredients, steps, url, duration),
            encoding="utf-8",
        )
        written += 1

    print(f"recipes: {len(recipes)}, written: {written}, skipped (existed): {skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

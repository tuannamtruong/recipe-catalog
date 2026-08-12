#!/usr/bin/env python3
"""Runtime HTTP server for the cooking app. Python 3 stdlib only.

Layout served:
  GET  /                   -> src/recipes.html (dev) or dist/recipes.html (built)
  GET  /<static>           -> matching file from src/ or dist/
  GET  /recipe_images/...  -> file from recipe_images/
  GET  /api/recipes        -> JSON list of all recipes
  GET  /api/recipes/{slug} -> JSON of one recipe
  POST /api/recipes        -> write recipes/{slug}.md  (409 if slug exists)
  PUT  /api/recipes/{slug} -> overwrite recipes/{slug}.md
  DEL  /api/recipes/{slug} -> delete recipes/{slug}.md (+ matching image)
  POST /api/images         -> body {filename, data_base64} -> saves to recipe_images/
  POST /api/quit           -> stop the server and exit the process

Binds to 127.0.0.1 only. No auth.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import unicodedata
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
RECIPES_DIR = ROOT / "recipes"
IMAGES_DIR = ROOT / "recipe_images"
SRC_DIR = ROOT / "src"
DIST_DIR = ROOT / "dist"
CONVERSIONS_FILE = ROOT / "conversions.json"
LOG_FILE = ROOT / "cooking-app.log"
PORT = 36637

# Set by main(); POST /api/quit needs it to stop serve_forever(). There is no
# console under pythonw.exe, so the Quit button is the only graceful way out.
SERVER: ThreadingHTTPServer | None = None

# Per-cup gram weights for known dry ingredients. Editable via the UI and
# persisted to conversions.json; these are the fallback when the file is
# missing or invalid. Anything not listed converts to a flat 240 ml.
DEFAULT_CUP_GRAMS = {"flour": 120, "sugar": 200, "oat": 90}

# Index page: prefer src/ in dev. If src/recipes.html is missing, fall back to dist/.
def static_root() -> Path:
    return SRC_DIR if (SRC_DIR / "recipes.html").exists() else DIST_DIR


# --- Minimal frontmatter parser. We only support our own emitted format. ---

_LIST_RE = re.compile(r"^\[(.*)\]$")


def _yaml_value(raw: str):
    raw = raw.strip()
    if raw == "" or raw.lower() == "null":
        return None
    if raw.lower() in ("true", "false"):
        return raw.lower() == "true"
    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        return raw[1:-1].encode("utf-8").decode("unicode_escape")
    m = _LIST_RE.match(raw)
    if m:
        inner = m.group(1)
        if not inner.strip():
            return []
        items = []
        # naive split honoring quoted items
        cur = ""
        quote = None
        for ch in inner:
            if quote:
                if ch == quote:
                    quote = None
                else:
                    cur += ch
            elif ch in ('"', "'"):
                quote = ch
            elif ch == ",":
                items.append(_yaml_value(cur))
                cur = ""
            else:
                cur += ch
        if cur.strip():
            items.append(_yaml_value(cur))
        return items
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw


def parse_markdown(text: str) -> dict:
    """Split frontmatter + body. Body is preserved verbatim."""
    fm: dict = {}
    body = text
    if text.startswith("---\n") or text.startswith("---\r\n"):
        end = text.find("\n---", 4)
        if end != -1:
            block = text[4:end]
            body = text[end + 4:].lstrip("\n")
            for line in block.splitlines():
                if ":" not in line:
                    continue
                key, _, val = line.partition(":")
                fm[key.strip()] = _yaml_value(val)
    return {"frontmatter": fm, "body": body}


def _format_yaml_value(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        return "[" + ", ".join(_format_yaml_value(x) for x in v) + "]"
    s = str(v)
    if any(c in s for c in ':#"\'\n[]{},&*!|>%@`'):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def serialize_markdown(recipe: dict) -> str:
    """Inverse of parse_markdown. Body is taken verbatim from recipe['body']."""
    fm = recipe.get("frontmatter", {})
    order = ["title", "categories", "prep_minutes", "cook_minutes", "image", "source_url"]
    lines = ["---"]
    for k in order:
        if k in fm:
            lines.append(f"{k}: {_format_yaml_value(fm[k])}")
    for k, v in fm.items():
        if k in order:
            continue
        lines.append(f"{k}: {_format_yaml_value(v)}")
    lines.append("---")
    lines.append("")
    body = recipe.get("body", "").rstrip() + "\n"
    return "\n".join(lines) + "\n" + body


def slugify(title: str) -> str:
    norm = unicodedata.normalize("NFKD", title)
    norm = "".join(c for c in norm if not unicodedata.combining(c))
    norm = norm.replace("đ", "d").replace("Đ", "d")
    s = re.sub(r"[^a-zA-Z0-9]+", "-", norm).strip("-").lower()
    return s or "untitled"


def load_all_recipes() -> list[dict]:
    out = []
    if not RECIPES_DIR.exists():
        return out
    for path in sorted(RECIPES_DIR.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        rec = parse_markdown(text)
        rec["slug"] = path.stem
        out.append(rec)
    return out


def load_recipe(slug: str) -> dict | None:
    path = RECIPES_DIR / f"{slug}.md"
    if not path.exists():
        return None
    rec = parse_markdown(path.read_text(encoding="utf-8"))
    rec["slug"] = slug
    return rec


def sanitize_cup_grams(raw) -> dict:
    """Keep only {non-empty lowercased name: positive number} entries."""
    out: dict = {}
    if not isinstance(raw, dict):
        return out
    for name, grams in raw.items():
        if not isinstance(name, str):
            continue
        key = name.strip().lower()
        if not key:
            continue
        if isinstance(grams, bool) or not isinstance(grams, (int, float)):
            continue
        if grams <= 0:
            continue
        out[key] = int(grams) if float(grams).is_integer() else grams
    return out


def load_conversions() -> dict:
    """Return {"cup_grams": {name: grams}}, falling back to defaults."""
    if CONVERSIONS_FILE.exists():
        try:
            data = json.loads(CONVERSIONS_FILE.read_text(encoding="utf-8"))
            cg = sanitize_cup_grams(data.get("cup_grams") if isinstance(data, dict) else None)
            if cg:
                return {"cup_grams": cg}
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    return {"cup_grams": dict(DEFAULT_CUP_GRAMS)}


def save_conversions(data: dict) -> dict:
    """Validate and overwrite conversions.json. Returns the stored payload."""
    cg = sanitize_cup_grams((data or {}).get("cup_grams"))
    payload = {"cup_grams": cg}
    CONVERSIONS_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return payload


def find_recipe_by_url(source_url: str) -> dict | None:
    """Return the first recipe whose source_url matches, or None."""
    target = (source_url or "").strip()
    if not target:
        return None
    for rec in load_all_recipes():
        if (rec.get("frontmatter", {}).get("source_url") or "").strip() == target:
            return rec
    return None


def safe_image_filename(name: str) -> str | None:
    """Allow only simple basenames with image extensions."""
    if "/" in name or "\\" in name or name.startswith("."):
        return None
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        return None
    if not re.search(r"\.(jpe?g|png|gif|webp)$", name, re.IGNORECASE):
        return None
    return name


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    # --- helpers ---

    def _send_json(self, code: int, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, code: int, msg: str):
        self._send_json(code, {"error": msg})

    def _send_file(self, path: Path, status: int = HTTPStatus.OK):
        if not path.is_file():
            return self._send_error(HTTPStatus.NOT_FOUND, "not found")
        ctype, _ = mimetypes.guess_type(str(path))
        if not ctype:
            ctype = "application/octet-stream"
        data = path.read_bytes()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    # --- routes ---

    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)

        if path == "/" or path == "/recipes.html":
            return self._send_file(static_root() / "recipes.html")
        if path == "/api/conversions":
            return self._send_json(HTTPStatus.OK, load_conversions())
        if path == "/api/recipes":
            params = parse_qs(url.query)
            source_url = params.get("source_url", [None])[0]
            if source_url is not None:
                rec = find_recipe_by_url(source_url)
                if rec is None:
                    return self._send_error(HTTPStatus.NOT_FOUND, "recipe not found")
                return self._send_json(HTTPStatus.OK, rec)
            return self._send_json(HTTPStatus.OK, load_all_recipes())
        if path.startswith("/api/recipes/"):
            slug = path[len("/api/recipes/"):]
            rec = load_recipe(slug)
            if rec is None:
                return self._send_error(HTTPStatus.NOT_FOUND, "recipe not found")
            return self._send_json(HTTPStatus.OK, rec)
        if path.startswith("/recipe_images/"):
            name = path[len("/recipe_images/"):]
            safe = safe_image_filename(name)
            if not safe:
                return self._send_error(HTTPStatus.BAD_REQUEST, "bad image name")
            return self._send_file(IMAGES_DIR / safe)
        # Plain static files (CSS, JS) from src/ or dist/
        if path.startswith("/") and ".." not in path:
            candidate = static_root() / path.lstrip("/")
            if candidate.is_file():
                return self._send_file(candidate)
        return self._send_error(HTTPStatus.NOT_FOUND, "not found")

    def do_POST(self):
        url = urlparse(self.path)
        path = unquote(url.path)

        if path == "/api/recipes":
            data = self._read_json()
            if not data:
                return self._send_error(HTTPStatus.BAD_REQUEST, "json body required")
            return self._write_recipe(data, overwrite=False)
        if path == "/api/images":
            data = self._read_json()
            if not data or "filename" not in data or "data_base64" not in data:
                return self._send_error(HTTPStatus.BAD_REQUEST, "filename and data_base64 required")
            return self._save_image(data["filename"], data["data_base64"])
        if path == "/api/quit":
            return self._quit()
        return self._send_error(HTTPStatus.NOT_FOUND, "not found")

    def do_PUT(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        if path == "/api/conversions":
            data = self._read_json()
            if data is None:
                return self._send_error(HTTPStatus.BAD_REQUEST, "json body required")
            return self._send_json(HTTPStatus.OK, save_conversions(data))
        if path.startswith("/api/recipes/"):
            slug = path[len("/api/recipes/"):]
            data = self._read_json()
            if not data:
                return self._send_error(HTTPStatus.BAD_REQUEST, "json body required")
            return self._write_recipe(data, overwrite=True, expected_slug=slug)
        return self._send_error(HTTPStatus.NOT_FOUND, "not found")

    def do_DELETE(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        if path.startswith("/api/recipes/"):
            slug = path[len("/api/recipes/"):]
            recipe_path = RECIPES_DIR / f"{slug}.md"
            if not recipe_path.exists():
                return self._send_error(HTTPStatus.NOT_FOUND, "recipe not found")
            # Delete linked image, if any.
            rec = parse_markdown(recipe_path.read_text(encoding="utf-8"))
            img = rec["frontmatter"].get("image")
            if isinstance(img, str):
                safe = safe_image_filename(img)
                if safe:
                    img_path = IMAGES_DIR / safe
                    if img_path.exists():
                        img_path.unlink()
            recipe_path.unlink()
            return self._send_json(HTTPStatus.OK, {"ok": True})
        return self._send_error(HTTPStatus.NOT_FOUND, "not found")

    # --- write helpers ---

    def _write_recipe(self, data: dict, overwrite: bool, expected_slug: str | None = None):
        fm = data.get("frontmatter") or {}
        title = fm.get("title")
        if not title:
            return self._send_error(HTTPStatus.BAD_REQUEST, "title required")
        slug = data.get("slug") or slugify(title)
        if expected_slug and slug != expected_slug:
            return self._send_error(HTTPStatus.BAD_REQUEST, "slug mismatch")
        if overwrite:
            path = RECIPES_DIR / f"{slug}.md"
            if not path.exists():
                return self._send_error(HTTPStatus.NOT_FOUND, "recipe not found")
        else:
            # On create, never collide: if the name is taken, append "-2", "-3",
            # ... to the slug and mirror the number in the displayed title.
            base_slug = slug
            n = 1
            while (RECIPES_DIR / f"{slug}.md").exists():
                n += 1
                slug = f"{base_slug}-{n}"
            if n > 1:
                fm = dict(fm)
                fm["title"] = f"{title} {n}"
            path = RECIPES_DIR / f"{slug}.md"
        RECIPES_DIR.mkdir(parents=True, exist_ok=True)
        text = serialize_markdown({"frontmatter": fm, "body": data.get("body", "")})
        path.write_text(text, encoding="utf-8")
        return self._send_json(HTTPStatus.OK, {"slug": slug})

    def _save_image(self, filename: str, data_base64: str):
        safe = safe_image_filename(filename)
        if not safe:
            return self._send_error(HTTPStatus.BAD_REQUEST, "bad image filename")
        try:
            blob = base64.b64decode(data_base64, validate=True)
        except (ValueError, base64.binascii.Error):
            return self._send_error(HTTPStatus.BAD_REQUEST, "invalid base64")
        if len(blob) > 25 * 1024 * 1024:
            return self._send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "image too large (25MB max)")
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        (IMAGES_DIR / safe).write_bytes(blob)
        return self._send_json(HTTPStatus.OK, {"filename": safe})

    def _quit(self):
        # Answer first so the browser sees a clean 200, then stop from another
        # thread -- shutdown() blocks until serve_forever() returns, and
        # serve_forever() is what is waiting on this very request.
        self._send_json(HTTPStatus.OK, {"stopped": True})
        self.wfile.flush()
        print("quit requested from the UI")
        if SERVER is not None:
            threading.Thread(target=SERVER.shutdown, daemon=True).start()


def _ensure_streams() -> None:
    """Give the process usable stdout/stderr.

    Windows' pythonw.exe (used by the desktop launcher so no console window
    appears) hands us sys.stdout == sys.stderr == None. log_message() writes to
    sys.stderr on every request, so without this the server would raise
    AttributeError on the first hit. Send both to a log file beside the recipes.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        stream = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
    except OSError:
        stream = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


def _already_running() -> bool:
    """True if something is already listening on our port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.25)
        return probe.connect_ex(("127.0.0.1", PORT)) == 0


def main(open_browser: bool = True) -> int:
    global SERVER
    _ensure_streams()
    url = f"http://localhost:{PORT}/"

    # Double-clicking the launcher a second time should focus the running app,
    # not die on "address already in use" behind a hidden console.
    if _already_running():
        print(f"cooking app already running: {url}")
        if open_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        return 0

    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as exc:  # lost the race, or port taken by something else
        print(f"cannot bind port {PORT}: {exc}")
        return 1
    SERVER = server

    print(f"cooking app: {url}")
    print(f"  recipes:  {RECIPES_DIR}")
    print(f"  images:   {IMAGES_DIR}")
    print(f"  serving:  {static_root()}")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    server.server_close()
    print("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main(open_browser="--no-browser" not in sys.argv))

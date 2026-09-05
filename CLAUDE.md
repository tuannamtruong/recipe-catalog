# Cooking App

A local, single-user webapp for browsing and managing recipes.

## Goals

- Browse, search, and filter recipes by dish type and by ingredient.
- Pick a random recipe — globally or within the current filters.
- Add new recipes through a UI form (no hand-editing required for the common case).
- Upload an image per recipe; store locally in `recipe_images/`.
- Keep recipes in plain text so they remain readable/editable without the app.

## UX rules

- **Images are collapsed by default** on the list view. A global "Show images" toggle reveals them in every card at once.
- Categories come in two kinds and are filtered separately (see [Categories](#categories)):
  - **Types** — dish types (`Main dish`, `Dessert`, `Salad`, `Sauce`, …). A dropdown of the types that actually appear across the recipes. One at a time.
  - **Ingredient tags** — what the recipe is made of. Never in the dropdown; they have their own multi-select filter, so several ingredients can be stacked.
- The ingredient filter is a text box with suggestions; each accepted suggestion becomes a removable chip. Several chips are **ANDed** — every one of them must match, so adding chips narrows the list. A chip matches as a substring, so `tomato` finds `cherry tomatoes`.
- Ingredient tags are also shown as chips on a recipe's detail page; clicking one goes back to the list filtered by it.
- The "Random" button respects both filters (or picks across all recipes if neither is set).
- The grouped view groups by type; recipes with no type land in "Uncategorized".
- **Ingredient tags are extracted from the "## Ingredients" lines** when adding a recipe — the name only, no amount (`3 cloves garlic, minced` → `garlic`). The field refills as you type in the ingredients box and stops the moment you edit it yourself, so a manual correction is never overwritten; the "Re-extract from ingredients" button forces a refill. See [Categories](#categories).
- **Imperial → metric is auto-applied when saving** (add or edit). `oz`/`lb`/`°F` are **replaced** with metric. `cup`/`cups` are **kept** with metric appended in parens. `tsp`/`tbs` are intentionally left alone. Examples: `3 oz cream cheese` → `85 g cream cheese`; `350°F` → `177 °C`; `1 cup of milk` → `1 cup (240 ml) of milk`; `2 cups flour` → `2 cups (240 g) flour`. Known dry ingredients convert to grams; everything else converts to a flat 240 ml (a cup is a fixed volume). The dry-ingredient gram table lives in `conversions.json` and is **editable from the reference panel** on the add/edit form (persisted via `PUT /api/conversions`). `src/app.js` holds built-in defaults used until the table loads and as a fallback.

## Categories

A recipe carries two independent, 0..n tag lists in its frontmatter:

| Field             | Holds                     | Example                        | Filtered by                       |
| ----------------- | ------------------------- | ------------------------------ | --------------------------------- |
| `types`           | dish types                | `[Main dish, Salad]`           | the dropdown (one at a time)      |
| `ingredient_tags` | ingredient names, no amount | `[chicken thigh, garlic]`    | the multi-select chips (ANDed)    |

Types are free-form — anything typed into the form is kept. Both the filter
dropdown and the form's autocomplete offer **only the types that some recipe
actually carries**, so the list never advertises a type nothing uses; a new
type comes into existence by being typed into the form, and disappears when the
last recipe holding it drops it. Ingredient tags are lowercased on save; types
keep their capitalisation.

**Extraction.** `extract_ingredient_names()` turns ingredient lines into bare
names: it drops parentheticals, cuts at the first comma / dash / `or`, strips
leading amounts and units and trailing preparation words, splits on `and`, and
discards anything still longer than four words (that is a sentence, not an
ingredient). `juice of 1 lemon` becomes `lemon juice`. It lives in `src/app.js`
and runs in the browser as you fill in the add/edit form.

## Stack decisions

| Concern        | Choice                                                                 | Why                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Storage layout | One file per recipe under `recipes/`, images under `recipe_images/`    | Drop a file = new recipe. Trivial backup. Per-recipe diffs. No DB.                                                                        |
| Recipe format  | Markdown with YAML frontmatter                                         | Steps/ingredients are naturally prose. Frontmatter holds structured fields. Hand-editable.                                                |
| Frontend       | Vanilla HTML + CSS + JS (no framework, no npm at all)                  | Single-user local app; React/Svelte/Vite is overkill.                                                                                     |
| Build tool     | Python stdlib script (`scripts/build.py`)                              | Zero npm/node. Inlines CSS + JS + recipes into one `recipes.html`.                                                                        |
| Runtime server | Python 3 stdlib `http.server` subclass (`server.py`)                   | Zero pip installs ever. Browsers cannot write files from `file://`, so a small server is required for the add-recipe / image-upload flow. |
| Port           | **36637**                                                              | Fixed; reserved for this app.                                                                                                             |
| Built output   | Single self-contained `recipes.html` + sibling `recipe_images/` folder | Easy to AirDrop/USB the pair to a phone for read-only browsing.                                                                           |

### Why a server at all?

`file://` pages cannot write to disk, and even reading sibling files is CORS-blocked.
The runtime server is the smallest thing that makes the add-recipe form work without
any installed dependencies. It is launched by `./run.sh` (or `python3 server.py`)
and opens the browser to `http://localhost:36637`.

## File layout

```
cooking_app/
├── recipes/                  # one .md per recipe (source of truth)
├── recipe_images/            # recipe photos, referenced by frontmatter `image:` field
├── conversions.json          # editable cup→gram table for dry ingredients
├── src/                      # frontend source
├── dist/                     # build output (tracked)
│   ├── recipes.html          # single self-contained file (CSS + JS + recipes inlined)
├── build/                    # desktop-bundle output (gitignored)
│   └── macos/                # Cooking App.app + cooking-app-macos.zip
├── scripts/                  # build.py, appicon.py, make_*_bundle.*
├── run.sh                    # launcher: starts server.py and opens browser
```

## Recipe format

Each recipe is one Markdown file with YAML frontmatter:

```markdown
---
title: Cassoulet
types: [Main dish, Stew]
ingredient_tags: [white beans, sausage, chicken leg]
prep_minutes: 20
cook_minutes: 70
image: cassoulet.jpg # filename inside images/, or null
source_url: https://www.youtube.com/watch?v=g_Huy-0Xeek
---

## Ingredients

- 200g white beans
- 200g sausage
- 500g chicken leg
- ...

## Steps

1. Soak white beans in salt for 2 hours.
2. Brown ham with no oil.
3. ...

## Notes

Optional free-form notes (cook's tips, substitutions).
```

Filename: kebab-case of the title (e.g. `swedish-meatballs.md`). The server enforces
uniqueness and slug generation when saving via the UI.

## HTTP API (runtime, served by `server.py`)

| Method | Path                    | Body                           | Effect                                                                                                                                          |
| ------ | ----------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/` and static paths    | —                              | Serves `dist/` files                                                                                                                            |
| GET    | `/api/recipes`          | —                              | Returns JSON array of all parsed recipes (front-matter + body)                                                                                  |
| GET    | `/api/recipes/{slug}`   | —                              | Returns one recipe                                                                                                                              |
| POST   | `/api/recipes`          | JSON recipe                    | Writes `recipes/{slug}.md`. If the slug is taken, appends `-2`/`-3`/… to the slug and ` 2`/` 3`/… to the title; returns the slug actually used. |
| PUT    | `/api/recipes/{slug}`   | JSON recipe                    | Overwrites the file.                                                                                                                            |
| DELETE | `/api/recipes/{slug}`   | —                              | Deletes file (and orphaned image).                                                                                                              |
| POST   | `/api/images`           | JSON `{filename, data_base64}` | Saves to `recipe_images/{slug}.{ext}`. Returns filename. Base64 avoids multipart parsing in stdlib.                                             |
| GET    | `/recipe_images/{name}` | —                              | Serves images.                                                                                                                                  |
| GET    | `/api/conversions`      | —                              | Returns `{cup_grams: {name: grams}}` from `conversions.json` (or built-in defaults).                                                            |
| PUT    | `/api/conversions`      | JSON `{cup_grams}`             | Validates (drops empty names / non-positive / non-numeric, lowercases keys) and overwrites `conversions.json`.                                  |
| POST   | `/api/quit`             | —                              | Answers `{stopped: true}`, then stops `serve_forever()` from a background thread and exits. Backs the **Quit** button.                          |

CORS / auth: none. Server binds to `127.0.0.1` only.

## Running

```bash
make run                      # or: ./run.sh / python3 server.py
# browser opens at http://localhost:36637
```

Browse-only fallback (no server, no add/edit):

- After a build, `dist/recipes.html` can be opened from disk on desktop or phone.
  Recipes are baked into the file; `recipe_images/` sits next to it and is loaded
  via `<img>` tags. Add/edit UI is hidden in this mode.

### Desktop launchers (codegen)

| Build host  | Target  | Command            | Script                            |
| ----------- | ------- | ------------------ | --------------------------------- |
| Linux / WSL | Windows | `make exe-win`     | `scripts/make_windows_bundle.py`  |
| Windows     | Windows | `make exe-win-win` | `scripts/make_windows_bundle.ps1` |
| Linux / WSL | macOS   | `make exe-mac`     | `scripts/make_macos_bundle.py`    |

The app icon is drawn from scratch in `scripts/appicon.py` (shared): the same
raster renderer feeds `build_ico()` for Windows and `build_icns()` (PNG-payload
chunks) for macOS. No image library, no checked-in binary.

#### Windows launcher

```bash
make exe-win                      # execute scripts/make_windows_bundle.py
```

Stages an official Python **embeddable** distribution (a plain zip from
python.org — still no pip, ever) into `C:\Tools\CookingApp\python\`, generates
`cooking.ico`, and creates a "Cooking App" desktop shortcut. The shortcut runs
`pythonw.exe server.py` so there is no console window. Full add/edit works.

The recipes are **not copied**. The shortcut points at `server.py` where it
already lives, so when the repo is in WSL the shortcut targets
`\\wsl.localhost\<distro>\home\...\server.py` and `recipes/` stays the single
source of truth with git untouched. Re-run `make exe-win` after moving the repo.

`make exe-win` re-stages `C:\Tools\CookingApp\python\`, and Windows locks the DLLs of a
running instance — over drvfs that failure surfaces as a bare
`OSError: [Errno 5] Input/output error` on `vcruntime140.dll`, not as "file in use".
So the script first looks for interpreters running out of that folder and asks them to
quit via `POST /api/quit`; if that fails (an instance older than the route answers 404)
it stops with the PID and a `taskkill` line instead of the opaque error.

Three things `server.py` does specifically for this mode:

- `_ensure_streams()` — `pythonw.exe` sets `sys.stdout`/`sys.stderr` to `None`,
  which would make `log_message()` raise on every request. Both are redirected
  to `cooking-app.log` beside the recipes; check it first when debugging.
- `_already_running()` — double-clicking the shortcut again focuses the running
  app instead of dying on a port collision behind a hidden console.
- `POST /api/quit` — with no console there is no Ctrl+C, so the header's
  **Quit** button is the graceful way to stop the process (the alternative is
  killing `pythonw.exe` in Task Manager). The button is hidden in static mode.

#### Building the Windows launcher on Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make_windows_bundle.ps1
```

`make exe-win-win` is the same thing invoked through `powershell.exe`. It works
from either host: the Makefile resolves the script path itself (`wslpath -w`
under WSL, a plain relative path when `OS=Windows_NT`), because a Windows make
runs recipes through `cmd.exe`, which does no `$(...)` substitution and would
pass the literal text to `-File`. The `.ps1` exists because stock Windows has
neither `make` nor a `python3` command, so on a machine without them the
`powershell -File` line above is the entry point; it is a front end only — the
bundler is still `make_windows_bundle.py`, which already handles both hosts.
It uses an installed Python if one answers a version probe (running it, not
just `Get-Command` — the Store's `python.exe` stub is on `PATH` by default and
would otherwise be picked), else unpacks the embeddable zip into
`.build-cache/python-bootstrap/` and bundles with that. That bootstrap
interpreter must stay out of `C:\Tools\CookingApp\python\`, which the bundler
wipes. Built this way the shortcut points at the repo's real Windows path
instead of `\\wsl.localhost\...`.

### macOS bundle (codegen)

```bash
make exe-mac                  # → build/macos/Cooking App.app + cooking-app-macos.zip
```

The Mac is a **different machine**, so this bundle inverts the Windows rule:
`server.py`, `src/`, `recipes/`, `recipe_images/` and `conversions.json` are
**copied** into `Contents/Resources/app/`. Recipes on the Mac are a snapshot;
rebuilding replaces them. `dist/` is deliberately not copied — `server.py`
serves `src/` whenever `src/recipes.html` exists.

No runtime is staged (there is no macOS equivalent of the embeddable zip to
unpack from Linux). `Contents/MacOS/cooking-app` is a `/bin/sh` script that
probes for a python3 and `exec`s `server.py` with output appended to
`cooking-app.log`, like the Windows path. Details that matter:

- Finder hands a `.app` a minimal `PATH`, so Homebrew pythons are probed by
  absolute path; `/usr/bin/python3` is tried **last** because without the
  Command Line Tools it is a stub that pops the "install developer tools"
  dialog when run. No python at all → an `osascript` dialog.
- The bundle is unsigned: the first launch needs right-click → **Open** or
  `xattr -dr com.apple.quarantine`. Left quarantined, App Translocation runs it
  from a read-only shadow copy and added recipes silently vanish — hence
  `READ-ME-FIRST.txt` in the output folder and the `LOG=/dev/null` fallback in
  the launcher.
- The zip is written entry-by-entry with `create_system = 3` and a `0o755` mode
  on the launcher; `shutil.make_archive` would drop the executable bit and the
  Mac would refuse to open the app.
- Output goes to `build/` (gitignored), not `dist/` — `dist/recipes.html` is
  tracked.

## Build

```bash
make build                    # → dist/recipes.html + dist/recipe_images/
```

There are **no npm/node and no pip dependencies — ever.** Only Python 3 stdlib.

## Conventions

- Slugs are kebab-case, lowercase, ASCII (Vietnamese diacritics are stripped for the filename only; the `title:` field keeps the original).
- Types are free-form strings; the UI builds the dropdown from whatever appears across all recipes.
- Ingredient tags are lowercase and hold names only — never amounts or preparation.
- Image filenames are tied to the recipe slug. Deleting a recipe removes its images.
- `recipes/` and `recipe_images/` are the source of truth. The UI never holds unsaved state across restarts.
- When importing, never overwrite an existing `recipes/{slug}.md`. The import script skips collisions so manual edits survive re-runs.
- Recipe filenames should not encode duration — keep durations in the `prep_minutes` / `cook_minutes` frontmatter fields.

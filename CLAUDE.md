# Cooking App

A local, single-user webapp for browsing and managing recipes.

## Goals

- Browse, search, and filter recipes by category.
- Pick a random recipe — globally or within the current category filter.
- Add new recipes through a UI form (no hand-editing required for the common case).
- Upload an image per recipe; store locally in `recipe_images/`.
- Keep recipes in plain text so they remain readable/editable without the app.

## UX rules

- **Images are collapsed by default** on the list view. A global "Show images" toggle reveals them in every card at once.
- The category filter is a dropdown of all categories that actually appear across the recipes.
- The "Random" button respects the current category filter (or picks across all recipes if no filter is set).
- **Imperial → metric is auto-applied when saving** (add or edit). `oz`/`lb`/`°F` are **replaced** with metric. `cup`/`cups` are **kept** with metric appended in parens. `tsp`/`tbs` are intentionally left alone. Examples: `3 oz cream cheese` → `85 g cream cheese`; `350°F` → `177 °C`; `1 cup of milk` → `1 cup (240 ml) of milk`; `2 cups flour` → `2 cups (240 g) flour`. Cup is ml for liquids, g for known dry ingredients; default ml. The ingredient lookup table is in `src/app.js` under `CUP_GRAMS` / `CUP_ML`.

## Stack decisions

| Concern | Choice | Why |
|---|---|---|
| Storage layout | One file per recipe under `recipes/`, images under `recipe_images/` | Drop a file = new recipe. Trivial backup. Per-recipe diffs. No DB. |
| Recipe format | Markdown with YAML frontmatter | Steps/ingredients are naturally prose. Frontmatter holds structured fields. Hand-editable. |
| Frontend | Vanilla HTML + CSS + JS (no framework, no npm at all) | Single-user local app; React/Svelte/Vite is overkill. |
| Build tool | Python stdlib script (`scripts/build.py`) | Zero npm/node. Inlines CSS + JS + recipes into one `recipes.html`. |
| Runtime server | Python 3 stdlib `http.server` subclass (`server.py`) | Zero pip installs ever. Browsers cannot write files from `file://`, so a small server is required for the add-recipe / image-upload flow. |
| Port | **36637** | Fixed; reserved for this app. |
| Built output | Single self-contained `recipes.html` + sibling `recipe_images/` folder | Easy to AirDrop/USB the pair to a phone for read-only browsing. |

### Why a server at all?

`file://` pages cannot write to disk, and even reading sibling files is CORS-blocked.
The runtime server is the smallest thing that makes the add-recipe form work without
any installed dependencies. It is launched by `./run.sh` (or `python3 server.py`)
and opens the browser to `http://localhost:36637`.

## File layout

```
cooking_app/
├── Cooking.docx              # original source document (optional after first import)
├── CLAUDE.md                 # this file
├── recipes/                  # one .md per recipe (source of truth)
│   ├── cassoulet.md
│   └── ...
├── recipe_images/            # recipe photos, referenced by frontmatter `image:` field
│   └── cassoulet.jpg
├── src/                      # frontend source
│   ├── recipes.html
│   ├── app.js
│   └── style.css
├── dist/                     # build output
│   ├── recipes.html          # single self-contained file (CSS + JS + recipes inlined)
│   └── recipe_images/        # copied from project root
├── scripts/
│   ├── import_docx.py        # one-time conversion from Cooking.docx → recipes/*.md
│   └── build.py              # bundles src/ + recipes/ → dist/recipes.html
├── server.py                 # runtime: stdlib HTTP server on port 36637
├── run.sh                    # launcher: starts server.py and opens browser
└── Makefile                  # `make run | build | import | clean`
```

## Recipe format

Each recipe is one Markdown file with YAML frontmatter:

```markdown
---
title: Cassoulet
categories: [Beef, Stew]
duration_minutes: 90
image: cassoulet.jpg          # filename inside images/, or null
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

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/` and static paths | — | Serves `dist/` files |
| GET | `/api/recipes` | — | Returns JSON array of all parsed recipes (front-matter + body) |
| GET | `/api/recipes/{slug}` | — | Returns one recipe |
| POST | `/api/recipes` | JSON recipe | Writes `recipes/{slug}.md`. If the slug is taken, appends `-2`/`-3`/… to the slug and ` 2`/` 3`/… to the title; returns the slug actually used. |
| PUT | `/api/recipes/{slug}` | JSON recipe | Overwrites the file. |
| DELETE | `/api/recipes/{slug}` | — | Deletes file (and orphaned image). |
| POST | `/api/images` | JSON `{filename, data_base64}` | Saves to `recipe_images/{slug}.{ext}`. Returns filename. Base64 avoids multipart parsing in stdlib. |
| GET | `/recipe_images/{name}` | — | Serves images. |

CORS / auth: none. Server binds to `127.0.0.1` only.

## Import pipeline

`scripts/import_docx.py` is a one-shot script (run during initial setup; not invoked at runtime).

1. Unzip `Cooking.docx`, parse `word/document.xml`.
2. Split paragraphs at every `Heading2` / `Heading3` — each one starts a new recipe.
3. For each recipe body, best-effort classify lines:
   - leading quantity (digit, `tbs`, `tsp`, `cup`, `g`, `ml`, fractions, etc.) → ingredients
   - lines starting with imperative verbs or numbered → steps
   - first `http(s)://…` URL → `source_url`
   - regex `(\d+)\s*(min|mins|phút|hour|hours)` → `duration_minutes`
4. Category guessed from nearest preceding section keyword in the document
   (beef / pork / chicken / seafood / vegetables / dessert / sauce / …).
5. Emit `recipes/{slug}.md`. Expect ~20–30% of recipes to need manual cleanup
   after first import — that's accepted ("best-effort auto-import, accept messy results").

## Running

```bash
make run                      # or: ./run.sh / python3 server.py
# browser opens at http://localhost:36637
```

Browse-only fallback (no server, no add/edit):
- After a build, `dist/recipes.html` can be opened from disk on desktop or phone.
  Recipes are baked into the file; `recipe_images/` sits next to it and is loaded
  via `<img>` tags. Add/edit UI is hidden in this mode.

## Build

```bash
make build                    # → dist/recipes.html + dist/recipe_images/
```

There are **no npm/node and no pip dependencies — ever.** Only Python 3 stdlib.

## Conventions

- Slugs are kebab-case, lowercase, ASCII (Vietnamese diacritics are stripped for the filename only; the `title:` field keeps the original).
- Categories are free-form strings; the UI builds the filter list from whatever appears across all recipes.
- Image filenames are tied to the recipe slug. Deleting a recipe removes its images.
- `recipes/` and `images/` are the source of truth. The UI never holds unsaved state across restarts.
- When importing, never overwrite an existing `recipes/{slug}.md`. The import script writes to a temp directory first and reports collisions.

## Open work

- [ ] Manual cleanup pass over imported recipes as you actually cook them.

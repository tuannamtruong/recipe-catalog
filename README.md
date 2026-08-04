# Cooking

A local, single-user webapp for browsing and managing recipes. 
Only Python 3 stdlib at runtime.

## Quick start

```bash
make run
```

Opens [http://localhost:36637](http://localhost:36637) in your browser.

## Features

- Browse, search, and filter recipes by category.
- Pick a random recipe — globally or within the current category filter.
- Add, edit, and delete recipes through a UI form.
- Upload a picture per recipe (stored in `recipe_images/`).
- Images are **collapsed by default** in the list — toggle "Show images" in the header to reveal all at once.
- **Auto imperial → metric conversion on save:**
  - `oz`, `lb`, `°F` are replaced — `3 oz cream cheese` → `85 g cream cheese`, `350°F` → `177 °C`.
  - `cup` / `cups` are kept with metric in parens — `1 cup of milk` → `1 cup (240 ml) of milk`, `2 cups flour` → `2 cups (240 g) flour`.
  - `tsp` / `tbs` are intentionally left alone.

## Make targets

| Command | What it does |
|---|---|
| `make run` | Start the server on `http://localhost:36637`. |
| `make build` | Bundle `src/` + `recipes/` into a single `dist/recipes.html` (with `dist/recipe_images/` alongside). Open this file directly from disk — or AirDrop it to a phone — for read-only browsing without a server. |
| `make import` | Parse `Cooking.docx` into `recipes/*.md` (requires the docx in the project root). Already run once; safe to re-run — skips files that exist. |
| `make clean` | Remove `dist/` and `__pycache__/`. |
| `make` (no args) | Print the target list. |

## Recipe format

Each recipe is one Markdown file with YAML frontmatter:

```markdown
---
title: Cassoulet
categories: [Beef]
prep_minutes: 20
cook_minutes: 70
image: cassoulet.jpg
source_url: https://www.youtube.com/watch?v=g_Huy-0Xeek
---

## Ingredients
- 200g white beans
- 500g chicken leg

## Steps
1. Soak white beans in salt for 2 hours.
2. ...
```

The app re-reads them on every request, so hand-made changes show up on the next page refresh.

## Phone use (read-only)

```bash
make build
# copy dist/ to your phone
# open dist/recipes.html on the phone
```

The bundle is one self-contained HTML file, that shows the recipes.

## Architecture notes

- Port `36637` is fixed.
- The server binds to `127.0.0.1` only — not accessible from other devices on
  your network.
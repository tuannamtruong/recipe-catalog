# Cooking

A local, single-user webapp for browsing and managing recipes.
Only Python 3 stdlib at runtime.

## Quick start

```bash
make run
```

Opens [http://localhost:36637](http://localhost:36637) in your browser.

## Features

- Browse, search, and filter recipes by **dish type** (Main dish, Dessert, Salad, Sauce…) from the dropdown.
- Filter by **ingredients** — pick several at once and only recipes containing all of them are shown.
- Ingredient tags are filled in automatically from a recipe's ingredient list when you add it, and can be edited afterwards.
- Pick a random recipe — globally or within the current filters.
- Add, edit, and delete recipes through a UI form.
- Upload a picture per recipe (stored in `recipe_images/`).
- Images are **collapsed by default** in the list — toggle "Show images" in the header to reveal all at once.
- **Auto imperial → metric conversion on save:**
  - `oz`, `lb`, `°F` are replaced — `3 oz cream cheese` → `85 g cream cheese`, `350°F` → `177 °C`.
  - `cup` / `cups` are kept with metric in parens — `1 cup of milk` → `1 cup (240 ml) of milk`, `2 cups flour` → `2 cups (240 g) flour`.
  - `tsp` / `tbs` are intentionally left alone.

## Make targets

| Command            | What it does                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `make run`         | Start the server on `http://localhost:36637`.                                                                                                                                                                |
| `make build`       | Bundle `src/` + `recipes/` into a single `dist/recipes.html` (with `dist/recipe_images/` alongside). Open this file directly from disk — or AirDrop it to a phone — for read-only browsing without a server. |
| `make exe-win`     | Windows desktop launcher + shortcut, built **from here** (Linux/WSL).                                                                                                                                        |
| `make exe-win-win` | The same launcher, built **by Windows itself** — see below.                                                                                                                                                  |
| `make exe-mac`     | Self-contained macOS `.app` + transfer zip in `build/macos/`.                                                                                                                                                |
| `make clean`       | Remove `dist/`, `build/` and `__pycache__/`.                                                                                                                                                                 |
| `make` (no args)   | Print the target list.                                                                                                                                                                                       |

## Recipe format

Each recipe is one Markdown file with YAML frontmatter:

```markdown
---
title: Cassoulet
types: [Main dish, Stew]
ingredient_tags: [white beans, sausage, chicken leg]
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

## Desktop launchers

| Build on    | For     | Command            | Result                                                                                                                                                                                                                                                                                    |
| ----------- | ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux / WSL | Windows | `make exe-win`     | Stages an embeddable Python in `C:\Tools\CookingApp\` and puts a **Cooking App** shortcut on the desktop. Recipes are **not** copied — the shortcut points at `server.py` in this repo (over `\\wsl.localhost\...` when it lives in WSL), so `recipes/` stays the single source of truth. |
| Windows     | Windows | `make exe-win-win` | Same bundler, run natively — the shortcut points at this repo's Windows path, no `\\wsl.localhost` hop.                                                                                                                                                                                   |
| Linux / WSL | macOS   | `make exe-mac`     | `build/macos/Cooking App.app` + `cooking-app-macos.zip`.                                                                                                                                                                                                                                  |

`make exe-win-win` wraps a PowerShell script, which exists because stock Windows
has neither `make` nor a `python3` command. On a Windows box without `make`, run
that script directly:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make_windows_bundle.ps1
```

It uses an installed Python if there is one and otherwise downloads the official
embeddable distribution into `.build-cache/` — a bare Windows machine needs
nothing installed. (From WSL, `make exe-win-win` invokes that same script through
`powershell.exe`.)

### macOS

The Mac is a different machine, so unlike the Windows launcher the `.app`
**carries its own copy** of `server.py`, `src/`, `recipes/`, `recipe_images/`
and `conversions.json` inside `Contents/Resources/app/`. Recipes added on the
Mac live there and do not flow back to this repo; a rebuilt bundle replaces
them. No runtime is staged — the launcher script finds the Mac's own `python3`
(3.8+) and says so in a dialog if there is none.

The app is unsigned, so the first launch needs a right-click → **Open**, or:

```bash
xattr -dr com.apple.quarantine "/Applications/Cooking App.app"
```

Do that before adding recipes: left quarantined, macOS may run the app from a
read-only shadow copy. `READ-ME-FIRST.txt` ships alongside the app with the same
notes.

## Architecture notes

- Port `36637` is fixed.
- The server binds to `127.0.0.1` only — not accessible from other devices on
  your network.

.PHONY: help run build exe exe-win exe-mac import clean
.DEFAULT_GOAL := run

help:
	@echo "make run      - start the server on http://localhost:36637"
	@echo "make build    - bundle src/ + recipes/ into dist/recipes.html"
	@echo "make exe-win      - Windows launcher + desktop shortcut"
	@echo "make exe-win-win  - same, but built by Windows itself"
	@echo "make exe-mac  - self-contained macOS .app + transfer zip in build/macos/"
	@echo "make clean    - remove dist/, build/ and __pycache__/"

run:
	python3 server.py

build:
	python3 scripts/build.py

exe-win:
	python3 scripts/make_windows_bundle.py

# Windows-native path: hands off to powershell.exe, which finds (or downloads)
# a Python on the Windows side. Same bundler, no WSL path translation -- the
# shortcut points at this repo's Windows-visible location.
exe-win-win:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
	  "$$(wslpath -w scripts/make_windows_bundle.ps1 2>/dev/null || echo scripts\\make_windows_bundle.ps1)"

exe-mac:
	python3 scripts/make_macos_bundle.py

clean:
	rm -rf dist build __pycache__ scripts/__pycache__

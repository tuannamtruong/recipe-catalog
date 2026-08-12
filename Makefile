.PHONY: help run build exe-win exe-win-win exe-mac import clean
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
#
# The path is resolved by make, not by the recipe's shell: run from a Windows
# make the shell is cmd.exe, which does not do `$(...)` substitution and would
# hand powershell the literal text (it answers "illegal characters in path",
# exit 0xFFFD0000). Windows also cannot chdir into \\wsl.localhost, so a
# relative path only works when make itself runs on Windows -- hence the split.
ifeq ($(OS),Windows_NT)
PS_BUNDLER = scripts/make_windows_bundle.ps1
else
PS_BUNDLER = $(or $(shell wslpath -w scripts/make_windows_bundle.ps1 2>/dev/null),scripts/make_windows_bundle.ps1)
endif

exe-win-win:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(PS_BUNDLER)"

exe-mac:
	python3 scripts/make_macos_bundle.py

clean:
	rm -rf dist build __pycache__ scripts/__pycache__

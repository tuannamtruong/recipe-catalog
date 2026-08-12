.PHONY: help run build exe import clean
.DEFAULT_GOAL := run

help:
	@echo "make run     - start the server on http://localhost:36637"
	@echo "make build   - bundle src/ + recipes/ into dist/recipes.html"
	@echo "make exe     - create a Windows launcher + desktop shortcut"
	@echo "make clean   - remove dist/ and __pycache__/"

run:
	python3 server.py

build:
	python3 scripts/build.py

exe:
	python3 scripts/make_windows_bundle.py

clean:
	rm -rf dist __pycache__ scripts/__pycache__

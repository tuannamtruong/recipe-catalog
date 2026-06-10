.PHONY: help run build import clean

help:
	@echo "make run     - start the server on http://localhost:36637"
	@echo "make build   - bundle src/ + recipes/ into dist/recipes.html"
	@echo "make import  - parse Cooking.docx into recipes/*.md (skips existing)"
	@echo "make clean   - remove dist/ and __pycache__/"

run:
	python3 server.py

build:
	python3 scripts/build.py

import:
	python3 scripts/import_docx.py

clean:
	rm -rf dist __pycache__ scripts/__pycache__

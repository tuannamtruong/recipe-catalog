#!/usr/bin/env python3
"""Build a self-contained Windows launcher for the cooking app.

Stages an official Python embeddable distribution (no pip, no installer) into
a folder on the Windows side, generates an icon, and creates a desktop
shortcut that runs server.py with pythonw.exe -- no console window.

The recipes are NOT copied. The shortcut points at server.py where it already
lives, so recipes/, recipe_images/ and conversions.json stay the single source
of truth and git keeps working normally.

Runs from WSL or from native Windows. Python 3 stdlib only.

    python3 scripts/make_windows_bundle.py [--target C:\\Tools\\CookingApp]
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from appicon import build_ico  # noqa: E402  (after sys.path fixup)

PYTHON_VERSION = "3.12.10"
DEFAULT_TARGET = r"C:\Tools\CookingApp"
APP_NAME = "Cooking App"
PORT = 36637

REPO = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO / ".build-cache"

IS_WINDOWS = os.name == "nt"


def _is_wsl() -> bool:
    if IS_WINDOWS:
        return False
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False


IS_WSL = _is_wsl()


# --- Path translation between the WSL and Windows views of the filesystem ---

def to_windows_path(path: Path) -> str:
    """Windows spelling of a path we can see locally."""
    path = path.resolve()
    if IS_WINDOWS:
        return str(path)
    parts = path.parts  # ('/', 'home', 'nam', ...)
    if len(parts) >= 3 and parts[1] == "mnt" and len(parts[2]) == 1:
        drive = parts[2].upper()
        rest = "\\".join(parts[3:])
        return f"{drive}:\\{rest}" if rest else f"{drive}:\\"
    # Native WSL filesystem: reachable from Windows over the 9p bridge.
    distro = os.environ.get("WSL_DISTRO_NAME", "Ubuntu")
    return "\\\\wsl.localhost\\" + distro + "\\" + "\\".join(parts[1:])


def to_local_path(win: str) -> Path:
    """Local path for a Windows path, so we can write to it from here."""
    if IS_WINDOWS:
        return Path(win)
    m = re.match(r"^([A-Za-z]):[\\/](.*)$", win)
    if not m:
        raise SystemExit(
            f"--target must be a drive-letter path like {DEFAULT_TARGET!r}, got {win!r}"
        )
    return Path("/mnt") / m.group(1).lower() / m.group(2).replace("\\", "/")


# --- Preflight: nothing may be running out of the folder we are about to wipe ---
#
# Windows locks the DLLs of a loaded process, so re-staging the runtime while the
# app is up fails on python\vcruntime140.dll. Over drvfs that surfaces as a bare
# OSError: [Errno 5] Input/output error, which reads like a broken filesystem
# rather than "the app is open" -- hence this check.

def _powershell_available() -> bool:
    return not IS_WSL or any(
        Path(d, "powershell.exe").exists()
        for d in ("/mnt/c/Windows/System32/WindowsPowerShell/v1.0",
                  "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0")
    )


def _powershell(script: str, timeout: int = 30) -> str:
    """Run a snippet on the Windows side. Empty string if that did not work."""
    if not _powershell_available():
        return ""
    try:
        # On a localized Windows the error text comes back in the OEM codepage,
        # not UTF-8: ask for UTF-8 output, and never let a stray byte raise here.
        res = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command",
             "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " + script],
            capture_output=True, text=True, errors="replace", timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return res.stdout if res.returncode == 0 else ""


def running_from(py_dir_win: str) -> list[int]:
    """PIDs of interpreters started from py_dir_win -- those hold the locks."""
    out = _powershell(
        "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' or Name='python.exe'\""
        " | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }"
    )
    prefix = py_dir_win.lower().rstrip("\\") + "\\"
    pids = []
    for line in out.splitlines():
        pid, _, exe = line.strip().partition("|")
        if exe.lower().startswith(prefix) and pid.isdigit():
            pids.append(int(pid))
    return pids


def _quit_request() -> str:
    """POST /api/quit, the same call the header's Quit button makes.

    Returns "" on success, otherwise a short reason. The request has to leave
    from the Windows side: the server binds 127.0.0.1 there, which under WSL2's
    default NAT networking is not the loopback we see from here.
    """
    url = f"http://127.0.0.1:{PORT}/api/quit"
    if IS_WINDOWS:
        try:
            urllib.request.urlopen(urllib.request.Request(url, method="POST"), timeout=5).read()
            return ""
        except urllib.error.HTTPError as exc:
            return f"HTTP {exc.code}"
        except OSError as exc:
            return str(exc)
    out = _powershell(
        "try { Invoke-WebRequest -UseBasicParsing -Method POST -TimeoutSec 5 -Uri "
        f"'{url}' | Out-Null; 'ok' }} catch {{ \"fail $($_.Exception.Message)\" }}"
    ).strip()
    if out == "ok":
        return ""
    return out[5:] if out.startswith("fail ") else "could not reach it"


def ensure_not_running(py_dir_win: str) -> None:
    pids = running_from(py_dir_win)
    if not pids:
        return
    listed = ", ".join(str(p) for p in pids)
    print(f"  {APP_NAME} is running from {py_dir_win} (PID {listed}); asking it to quit")
    reason = _quit_request()
    if not reason:
        for _ in range(20):
            time.sleep(0.25)
            if not running_from(py_dir_win):
                print("  stopped")
                return
        reason = "it did not exit"
    pids = running_from(py_dir_win) or pids
    listed = ", ".join(str(p) for p in pids)
    raise SystemExit(
        f"\n{APP_NAME} is running -- quit it first, then re-run.\n"
        f"  Its files are locked, so the runtime cannot be re-staged.\n"
        f"  /api/quit did not work: {reason}\n"
        f"  (an instance started before that route existed answers 404 -- kill it)\n"
        f"  Use the Quit button in the app header, or:\n"
        f"      taskkill.exe /PID {listed.replace(', ', ' /PID ')} /F"
    )


# --- Embeddable Python ---

def fetch_embed_zip(version: str) -> Path:
    url = f"https://www.python.org/ftp/python/{version}/python-{version}-embed-amd64.zip"
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dest = CACHE_DIR / f"python-{version}-embed-amd64.zip"
    if dest.exists() and dest.stat().st_size > 1_000_000:
        print(f"  cached {dest.name} ({dest.stat().st_size // 1024} KB)")
        return dest
    print(f"  downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "cooking-app-build"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            blob = resp.read()
    except Exception as exc:
        raise SystemExit(
            f"download failed: {exc}\n"
            f"Fetch it manually and save as: {dest}"
        )
    dest.write_bytes(blob)
    print(f"  saved {dest.name} ({len(blob) // 1024} KB)")
    return dest


def install_python(zip_path: Path, py_dir: Path, app_dir_win: str) -> None:
    if py_dir.exists():
        try:
            for p in sorted(py_dir.rglob("*"), reverse=True):
                p.unlink() if p.is_file() else p.rmdir()
            py_dir.rmdir()
        except OSError as exc:
            # Windows holds this open; see the preflight note above. Reached only
            # when the holder is something we could not identify by process.
            raise SystemExit(
                f"\ncould not clear {py_dir}: {exc}\n"
                f"  Something has {getattr(exc, 'filename', '?')} open -- close any running\n"
                f"  {APP_NAME}, Explorer window, or terminal sitting in that folder."
            )
    py_dir.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(py_dir)

    # An embeddable distro pins sys.path via python3XX._pth and skips site.py.
    # server.py imports nothing local, but add the app dir so future local
    # modules resolve too.
    for pth in py_dir.glob("python*._pth"):
        text = pth.read_text(encoding="utf-8")
        if app_dir_win not in text:
            pth.write_text(text.rstrip("\n") + "\n" + app_dir_win + "\n", encoding="utf-8")
        print(f"  patched {pth.name}")


# --- Launcher + shortcut ---

BAT = """@echo off
rem Generated by scripts/make_windows_bundle.py -- do not edit by hand.
rem Fallback launcher; the desktop shortcut is the normal way in.
start "" "%~dp0python\\pythonw.exe" "{server}"
"""

PS1 = """$ErrorActionPreference = 'Stop'
$target    = '{pythonw}'
$arguments = '"{server}"'
$icon      = '{icon}'
$workdir   = '{workdir}'
$shell     = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), $workdir)) {{
    $lnk = Join-Path $dir '{name}.lnk'
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath        = $target
    $s.Arguments         = $arguments
    $s.IconLocation      = $icon
    $s.WorkingDirectory  = $workdir
    $s.Description       = 'Cooking app - browse and edit recipes'
    $s.Save()
    Write-Output "  shortcut: $lnk"
}}
"""


def make_shortcuts(ps1_local: Path, ps1_win: str) -> None:
    powershell = "powershell.exe"
    if IS_WSL and not any(
        Path(d, "powershell.exe").exists()
        for d in ("/mnt/c/Windows/System32/WindowsPowerShell/v1.0",
                  "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0")
    ):
        print("  ! powershell.exe not found; skipping shortcut")
        print(f"    run it yourself: powershell -ExecutionPolicy Bypass -File {ps1_win}")
        return
    try:
        res = subprocess.run(
            [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1_win],
            capture_output=True, text=True, errors="replace", timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"  ! could not run powershell ({exc}); skipping shortcut")
        return
    if res.returncode != 0:
        print(f"  ! shortcut creation failed:\n{res.stderr.strip()}")
        return
    print(res.stdout.rstrip())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target", default=DEFAULT_TARGET,
                    help=f"Windows folder for the runtime (default: {DEFAULT_TARGET})")
    ap.add_argument("--python-version", default=PYTHON_VERSION)
    ap.add_argument("--no-shortcut", action="store_true")
    args = ap.parse_args()

    if not (IS_WINDOWS or IS_WSL):
        return int(bool(print("This builds a Windows launcher; run it on Windows or WSL.")))

    target_win = args.target.rstrip("\\")
    target_local = to_local_path(target_win)
    app_dir_win = to_windows_path(REPO)
    server_win = to_windows_path(REPO / "server.py")

    print(f"app:    {app_dir_win}")
    print(f"target: {target_win}")
    if app_dir_win.startswith("\\\\wsl"):
        print("        (recipes stay in WSL; shortcut reaches them over \\\\wsl.localhost)")

    target_local.mkdir(parents=True, exist_ok=True)

    print("python runtime:")
    py_dir = target_local / "python"
    if py_dir.exists():
        ensure_not_running(f"{target_win}\\python")
    install_python(fetch_embed_zip(args.python_version), py_dir, app_dir_win)

    icon_local = target_local / "cooking.ico"
    icon_local.write_bytes(build_ico())
    print(f"icon:   {icon_local.name} ({icon_local.stat().st_size // 1024} KB)")

    (target_local / f"{APP_NAME}.bat").write_text(
        BAT.format(server=server_win), encoding="utf-8"
    )

    ps1_local = target_local / "make_shortcut.ps1"
    ps1_local.write_text(
        PS1.format(
            pythonw=f"{target_win}\\python\\pythonw.exe",
            server=server_win,
            icon=f"{target_win}\\cooking.ico",
            workdir=target_win,
            name=APP_NAME,
        ),
        encoding="utf-8",
    )
    if not args.no_shortcut:
        print("shortcuts:")
        make_shortcuts(ps1_local, f"{target_win}\\make_shortcut.ps1")

    print(f"\ndone. Launch '{APP_NAME}' from the desktop.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

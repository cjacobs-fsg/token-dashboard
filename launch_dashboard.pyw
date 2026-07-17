"""Desktop launcher for Token Dashboard.

Double-click target for the desktop shortcut. Idempotent and windowless:

  * If the dashboard server is already listening, just open the browser.
  * Otherwise start the server in the background with NO console window,
    wait for it to bind (the first run rescans, which can take a while),
    then open the browser.

A short-lived lock file prevents a second double-click from spawning a
second server while the first one is still scanning.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))
URL = f"http://{HOST}:{PORT}/"
REPO = Path(__file__).resolve().parent
LOCK = REPO / ".launch.lock"
CREATE_NO_WINDOW = 0x08000000


def is_up(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def wait_until_up(deadline_seconds: float) -> bool:
    deadline = time.time() + deadline_seconds
    while time.time() < deadline:
        if is_up(HOST, PORT):
            return True
        time.sleep(0.5)
    return is_up(HOST, PORT)


def lock_is_fresh(max_age_seconds: float = 120.0) -> bool:
    try:
        return (time.time() - LOCK.stat().st_mtime) < max_age_seconds
    except OSError:
        return False


def start_server() -> None:
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    exe = str(pythonw) if pythonw.exists() else sys.executable
    # --no-scan so the server binds immediately off the cached DB; its own
    # background thread rescans every 30s and pushes live updates.
    subprocess.Popen(
        [exe, str(REPO / "cli.py"), "dashboard", "--no-open", "--no-scan"],
        cwd=str(REPO),
        creationflags=CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        close_fds=True,
    )


def main() -> None:
    if is_up(HOST, PORT):
        webbrowser.open(URL)
        return

    if lock_is_fresh():
        # Another launch is already starting the server; just wait for it.
        wait_until_up(120)
        webbrowser.open(URL)
        return

    try:
        LOCK.write_text(str(os.getpid()))
    except OSError:
        pass

    try:
        start_server()
        wait_until_up(120)
    finally:
        try:
            LOCK.unlink()
        except OSError:
            pass

    webbrowser.open(URL)


if __name__ == "__main__":
    main()

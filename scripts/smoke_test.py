#!/usr/bin/env python3
"""Load adronin in headless Chromium and check a page with an ad slot."""

from __future__ import annotations

import http.server
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = 8765
PROFILE = Path("/tmp/adronin-chrome-profile")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main() -> int:
    port = free_port()
    os.chdir(ROOT / "tests" / "fixtures")
    handler = http.server.SimpleHTTPRequestHandler
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    import threading

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    if PROFILE.exists():
        subprocess.run(["rm", "-rf", str(PROFILE)], check=True)
    PROFILE.mkdir(parents=True)

    url = f"http://127.0.0.1:{port}/page.html"
    log_path = Path("/tmp/adronin-chrome.log")
    command = [
        "chromium",
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--enable-logging=stderr",
        f"--user-data-dir={PROFILE}",
        f"--disable-extensions-except={ROOT}",
        f"--load-extension={ROOT}",
        "--virtual-time-budget=8000",
        "--dump-dom",
        url,
    ]
    print("launch", " ".join(command), flush=True)
    completed = subprocess.run(
        command,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
    )
    log_path.write_text(completed.stderr, encoding="utf-8")
    server.shutdown()
    dom = completed.stdout
    if "Could not load extension" in completed.stderr or "Failed to load extension" in completed.stderr:
        print(completed.stderr[-4000:], file=sys.stderr)
        return 1
    match = re.search(r'<pre id="result">ADRONIN:(\{.*?\})</pre>', dom)
    if not match:
        print(dom[-2000:], file=sys.stderr)
        print(completed.stderr[-4000:], file=sys.stderr)
        print("fixture did not report a result", file=sys.stderr)
        return 1
    result = json.loads(match.group(1))
    print("result", result, flush=True)
    if result.get("display") != "none":
        print("ad slot was not hidden", file=sys.stderr)
        return 1
    if result.get("ins") not in {"none", "removed"}:
        print("adsbygoogle element was not removed", file=sys.stderr)
        return 1
    if result.get("script") != "blocked":
        print("ad script was not blocked", result, file=sys.stderr)
        return 1
    if result.get("tracker") != "blocked":
        print("tracker script was not blocked", result, file=sys.stderr)
        return 1
    if result.get("heading") != "Keep this heading":
        print("page content was damaged", file=sys.stderr)
        return 1
    rules = [line for line in completed.stderr.splitlines() if "Ruleset" in line or "adronin" in line.lower()]
    if any("error" in line.lower() for line in rules):
        print("\n".join(rules), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.TimeoutExpired as error:
        print(error, file=sys.stderr)
        sys.exit(1)

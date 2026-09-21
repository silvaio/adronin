#!/usr/bin/env python3
"""Build rules/hardening.json from filters/obfusgated-domains.json."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOMAINS_PATH = ROOT / "filters" / "obfusgated-domains.json"
OUT_PATH = ROOT / "rules" / "hardening.json"
START_ID = 3_000_000
PRIORITY = 500


def build() -> list[dict]:
    data = json.loads(DOMAINS_PATH.read_text(encoding="utf-8"))
    hosts: list[str] = []
    paths: list[str] = []
    for entry in data["uniq"]:
        entry = entry.strip().lower()
        if "/" in entry:
            paths.append(entry)
        else:
            hosts.append(entry)
    hosts = sorted(set(hosts))
    paths = sorted(set(paths))

    rules: list[dict] = []
    rid = START_ID
    for url in ("||dns.google/resolve?", "||dns.google.com/resolve?"):
        rules.append(
            {
                "id": rid,
                "priority": PRIORITY,
                "action": {"type": "block"},
                "condition": {
                    "urlFilter": url,
                    "resourceTypes": ["xmlhttprequest", "other"],
                    "initiatorDomains": ["obfusgated.com"],
                },
            }
        )
        rid += 1

    for offset in range(0, len(hosts), 200):
        chunk = hosts[offset : offset + 200]
        rules.append(
            {
                "id": rid,
                "priority": PRIORITY,
                "action": {"type": "block"},
                "condition": {
                    "requestDomains": chunk,
                    "excludedResourceTypes": ["main_frame"],
                },
            }
        )
        rid += 1

    for path in paths:
        rules.append(
            {
                "id": rid,
                "priority": PRIORITY,
                "action": {"type": "block"},
                "condition": {
                    "urlFilter": f"||{path}^",
                    "excludedResourceTypes": ["main_frame"],
                },
            }
        )
        rid += 1

    OUT_PATH.write_text(json.dumps(rules, separators=(",", ":")), encoding="utf-8")
    return rules


if __name__ == "__main__":
    built = build()
    print(f"wrote {OUT_PATH} ({len(built)} rules)")

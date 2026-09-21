#!/usr/bin/env python3
"""Compile EasyList and EasyPrivacy into Chromium declarativeNetRequest rules.

EasyList and EasyPrivacy are © their contributors and licensed CC BY-SA 3.0.
https://easylist.to/ and https://github.com/easylist/easylist
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIST_DIR = ROOT / "build" / "lists"
RULES_DIR = ROOT / "rules"
MANIFEST_PATH = ROOT / "manifest.json"

JSDELIVR = "https://cdn.jsdelivr.net/gh/easylist/easylist@master"

# Ad-server lists plus general network rules. CNAME-cloaking dumps are left
# out. They are huge and mostly first-party tracker aliases.
AD_NETWORK = [
    f"{JSDELIVR}/easylist/easylist_adservers.txt",
    f"{JSDELIVR}/easylist/easylist_general_block.txt",
    f"{JSDELIVR}/easylist/easylist_thirdparty.txt",
    f"{JSDELIVR}/easylist/easylist_specific_block.txt",
    f"{JSDELIVR}/easylist/easylist_allowlist.txt",
]
AD_COSMETIC = [
    f"{JSDELIVR}/easylist/easylist_general_hide.txt",
    f"{JSDELIVR}/easylist/easylist_specific_hide.txt",
    f"{JSDELIVR}/easylist/easylist_allowlist_general_hide.txt",
]
TRACKER_NETWORK = [
    f"{JSDELIVR}/easyprivacy/easyprivacy_trackingservers.txt",
    f"{JSDELIVR}/easyprivacy/easyprivacy_trackingservers_general.txt",
    f"{JSDELIVR}/easyprivacy/easyprivacy_trackingservers_international.txt",
    f"{JSDELIVR}/easyprivacy/easyprivacy_trackingservers_thirdparty.txt",
    f"{JSDELIVR}/easyprivacy/easyprivacy_thirdparty.txt",
    f"{JSDELIVR}/easyprivacy/easyprivacy_thirdparty_international.txt",
    f"{JSDELIVR}/easyprivacy/easyprivacy_general.txt",
    f"{JSDELIVR}/easyprivacy/easyprivacy_specific.txt",
    f"{JSDELIVR}/easyprivacy/easyprivacy_specific_international.txt",
    f"{JSDELIVR}/easyprivacy/easyprivacy_allowlist.txt",
    f"{JSDELIVR}/easyprivacy/easyprivacy_allowlist_international.txt",
]

MAX_DOMAINS_PER_RULE = 200
MAX_RULES_PER_FILE = 20000
MAX_URL_FILTER = 1000

PRIORITY_BLOCK = 10
PRIORITY_ALLOW = 20
PRIORITY_IMPORTANT_BLOCK = 30
PRIORITY_IMPORTANT_ALLOW = 40

RESOURCE_TYPES = {
    "script": "script",
    "image": "image",
    "stylesheet": "stylesheet",
    "object": "object",
    "object-subrequest": "object",
    "xmlhttprequest": "xmlhttprequest",
    "subdocument": "sub_frame",
    "document": "main_frame",
    "font": "font",
    "media": "media",
    "websocket": "websocket",
    "ping": "ping",
    "other": "other",
    "frame": "sub_frame",
    # Popup navigations are top-level loads. Blocking the main frame of an
    # ad URL stops the popup without a separate window API.
    "popup": "main_frame",
}

# Real options that are not network block types. Unknown options skip the rule
# so a filter is never widened by accident.
NON_NETWORK_OPTIONS = {"generichide", "match-case", "important", "third-party"}

HOST_RE = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)
IP_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")
BARE_GLOBAL = {"*", "html", "body", "head"}

PROCEDURAL_MARKERS = (
    ":-abp-",
    ":has-text(",
    ":xpath(",
    ":matches-css(",
    ":matches-css-before(",
    ":matches-css-after(",
    ":upward(",
    ":remove(",
    ":style(",
    ":min-text-length(",
)


class Stats:
    def __init__(self) -> None:
        self.skipped: dict[str, int] = defaultdict(int)

    def skip(self, reason: str) -> None:
        self.skipped[reason] += 1


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return
    request = urllib.request.Request(url, headers={"User-Agent": "adronin-filter-compile"})
    with urllib.request.urlopen(request, timeout=60) as response:
        dest.write_bytes(response.read())


def list_path(url: str) -> Path:
    name = url.rsplit("/", 1)[-1]
    return LIST_DIR / name


def fetch_all(urls: list[str]) -> list[Path]:
    paths = []
    for url in urls:
        dest = list_path(url)
        print(f"fetch {dest.name}", flush=True)
        download(url, dest)
        paths.append(dest)
    return paths


def valid_host(host: str) -> bool:
    if IP_RE.match(host):
        parts = [int(part) for part in host.split(".")]
        return all(0 <= part <= 255 for part in parts)
    return HOST_RE.match(host) is not None


def pure_host(pattern: str) -> str | None:
    if not pattern.startswith("||") or not pattern.endswith("^") or pattern.count("^") != 1:
        return None
    if any(token in pattern for token in "/*?&=%#"):
        return None
    host = pattern[2:-1].lower()
    if not valid_host(host):
        return None
    return host


def valid_url_filter(pattern: str) -> bool:
    if not pattern or pattern in {"*", "||", "|", "^"} or len(pattern) > MAX_URL_FILTER:
        return False
    if "||" in pattern[2:]:
        return False
    body = pattern
    if body.startswith("||"):
        body = body[2:]
    elif body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    if "|" in body:
        return False
    for char in pattern:
        if ord(char) < 33 or ord(char) > 126 or char in "\"'<>{}\\ ":
            return False
    return True


def options_are_known(options: str) -> bool:
    if options == "":
        return True
    for part in options.split(","):
        part = part.strip()
        if not part:
            return False
        name = part[1:] if part.startswith("~") else part
        if name.startswith("domain="):
            if part.startswith("~"):
                return False
            continue
        base = name.split("=", 1)[0]
        if base not in RESOURCE_TYPES and base not in NON_NETWORK_OPTIONS:
            return False
        if part.startswith("~") and base not in RESOURCE_TYPES and base != "third-party":
            return False
    return True


def split_pattern_options(body: str) -> tuple[str, str] | None:
    if "$" not in body:
        return body, ""
    index = len(body)
    while index > 0:
        index = body.rfind("$", 0, index)
        if index == -1:
            return None
        options = body[index + 1 :]
        if options_are_known(options):
            return body[:index], options
    return Nonedef parse_options(options: str) -> dict | None:
    included: list[str] = []
    excluded: list[str] = []
    party = None
    important = False
    case_sensitive = False
    generichide = False
    initiators: list[str] = []
    excluded_initiators: list[str] = []

    for part in options.split(",") if options else []:
        part = part.strip()
        if not part:
            return None
        negated = part.startswith("~")
        token = part[1:] if negated else part
        if token.startswith("domain="):
            if negated:
                return None
            for domain in token.split("=", 1)[1].split("|"):
                domain = domain.strip().lower()
                if not domain:
                    continue
                exclude_domain = domain.startswith("~")
                host = domain[1:] if exclude_domain else domain
                if not valid_host(host):
                    return None
                if exclude_domain:
                    excluded_initiators.append(host)
                else:
                    initiators.append(host)
            continue
        if token == "third-party" and not negated:
            party = "thirdParty"
            continue
        if token == "third-party" and negated:
            party = "firstParty"
            continue
        if token == "important":
            important = True
            continue
        if token == "match-case":
            case_sensitive = True
            continue
        if token == "generichide":
            generichide = True
            continue
        mapped = RESOURCE_TYPES.get(token)
        if mapped is None:
            return None
        if negated:
            excluded.append(mapped)
        else:
            included.append(mapped)

    return {
        "included": list(dict.fromkeys(included)),
        "excluded": list(dict.fromkeys(excluded)),
        "party": party,
        "important": important,
        "case_sensitive": case_sensitive,
        "generichide": generichide,
        "initiators": list(dict.fromkeys(initiators)),
        "excluded_initiators": list(dict.fromkeys(excluded_initiators)),
    }


def resource_condition(included: list[str], excluded: list[str]) -> dict | None:
    """Map ABP type options onto declarativeNetRequest resource fields.

    ABP network filters do not apply to top-level documents unless $document
    or $popup is set. Chrome cannot set resourceTypes and excludedResourceTypes
    on the same rule, so a negated type becomes an exclusion list.
    """
    include_main = "main_frame" in included
    included = [item for item in included if item != "main_frame" or include_main]
    if included:
        types = [item for item in included if item not in excluded]
        if not types:
            return None
        return {"resourceTypes": types}
    excluded_types = list(excluded)
    if not include_main and "main_frame" not in excluded_types:
        excluded_types.append("main_frame")
    return {"excludedResourceTypes": list(dict.fromkeys(excluded_types))}


def priority_for(allow: bool, important: bool) -> int:
    if allow and important:
        return PRIORITY_IMPORTANT_ALLOW
    if important:
        return PRIORITY_IMPORTANT_BLOCK
    if allow:
        return PRIORITY_ALLOW
    return PRIORITY_BLOCK


def parse_network_line(line: str, stats: Stats) -> dict | None:
    if line.startswith("@@"):
        allow = True
        body = line[2:]
    else:
        allow = False
        body = line
    split = split_pattern_options(body)
    if split is None:
        stats.skip("options")
        return None
    pattern, options = split
    parsed = parse_options(options)
    if parsed is None:
        stats.skip("options")
        return None
    condition_types = resource_condition(parsed["included"], parsed["excluded"])
    if condition_types is None:
        stats.skip("types")
        return None
    host = pure_host(pattern)
    catchall = pattern in {"", "*"}
    narrowing = bool(parsed["included"] or parsed["excluded"] or parsed["party"])
    # $generichide never whitelists network requests by itself.
    if parsed["generichide"] and not narrowing:
        return {
            "network": False,
            "allow": allow,
            "generichide": True,
            "host": host,
            "initiators": parsed["initiators"],
        }
    if host is None and not catchall and not valid_url_filter(pattern):
        stats.skip("pattern")
        return None
    if catchall and not parsed["included"]:
        # A type-less catch-all would block or allow the entire web.
        stats.skip("catchall")
        return {
            "network": False,
            "allow": allow,
            "generichide": parsed["generichide"],
            "host": None,
            "initiators": parsed["initiators"],
        }
    return {
        "network": True,
        "allow": allow,
        "important": parsed["important"],
        "generichide": parsed["generichide"],
        "host": host,
        "pattern": pattern,
        "catchall": catchall,
        "party": parsed["party"],
        "case_sensitive": parsed["case_sensitive"],
        "initiators": parsed["initiators"],
        "excluded_initiators": parsed["excluded_initiators"],
        "types": condition_types,
        "priority": priority_for(allow, parsed["important"]),
    }


def iter_filter_lines(paths: list[Path]):
    for path in paths:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line.startswith(("!", "[Adblock", "[uBlock")):
                    continue
                yield line


def compile_network(paths: list[Path], stats: Stats) -> tuple[list[dict], list[str]]:
    groups: dict[tuple, set[str]] = defaultdict(set)
    singles: list[dict] = []
    generichide: set[str] = set()
    seen_single: set[str] = set()

    for line in iter_filter_lines(paths):
        if any(marker in line for marker in ("##", "#@#", "#?#", "#$#")):
            continue
        parsed = parse_network_line(line, stats)
        if parsed is None:
            continue
        if parsed["generichide"] and parsed["allow"]:
            if parsed.get("host"):
                generichide.add(parsed["host"])
            for host in parsed.get("initiators") or []:
                generichide.add(host)
        if not parsed["network"]:
            stats.skip("cosmetic-only")
            continue
        if parsed["host"] and not parsed["catchall"]:
            key = (
                parsed["allow"],
                parsed["priority"],
                parsed["party"],
                tuple(parsed["types"].get("resourceTypes", ())),
                tuple(parsed["types"].get("excludedResourceTypes", ())),
                tuple(parsed["initiators"]),
                tuple(parsed["excluded_initiators"]),
                parsed["case_sensitive"],
            )
            groups[key].add(parsed["host"])
            continue
        fingerprint = json.dumps(
            {
                "allow": parsed["allow"],
                "priority": parsed["priority"],
                "pattern": "" if parsed["catchall"] else parsed["pattern"],
                "party": parsed["party"],
                "types": parsed["types"],
                "initiators": parsed["initiators"],
                "excluded_initiators": parsed["excluded_initiators"],
                "case": parsed["case_sensitive"],
            },
            sort_keys=True,
        )
        if fingerprint in seen_single:
            continue
        seen_single.add(fingerprint)
        singles.append(parsed)

    rules: list[dict] = []
    for key, hosts in groups.items():
        (
            allow,
            priority,
            party,
            resource_types,
            excluded_types,
            initiators,
            excluded_initiators,
            case_sensitive,
        ) = key
        ordered = sorted(hosts)
        for offset in range(0, len(ordered), MAX_DOMAINS_PER_RULE):
            chunk = ordered[offset : offset + MAX_DOMAINS_PER_RULE]
            condition: dict = {"requestDomains": chunk}
            if resource_types:
                condition["resourceTypes"] = list(resource_types)
            elif excluded_types:
                condition["excludedResourceTypes"] = list(excluded_types)
            if party:
                condition["domainType"] = party
            if initiators:
                condition["initiatorDomains"] = list(initiators)
            if excluded_initiators:
                condition["excludedInitiatorDomains"] = list(excluded_initiators)
            rules.append(
                {
                    "priority": priority,
                    "action": {"type": "allow" if allow else "block"},
                    "condition": condition,
                    "_case": case_sensitive,
                }
            )

    for parsed in singles:
        condition = dict(parsed["types"])
        if not parsed["catchall"]:
            condition["urlFilter"] = parsed["pattern"]
            if parsed["case_sensitive"]:
                condition["isUrlFilterCaseSensitive"] = True
        if parsed["party"]:
            condition["domainType"] = parsed["party"]
        if parsed["initiators"]:
            condition["initiatorDomains"] = parsed["initiators"]
        if parsed["excluded_initiators"]:
            condition["excludedInitiatorDomains"] = parsed["excluded_initiators"]
        rules.append(
            {
                "priority": parsed["priority"],
                "action": {"type": "allow" if parsed["allow"] else "block"},
                "condition": condition,
            }
        )

    rules.sort(key=lambda rule: json.dumps(rule, sort_keys=True))
    return rules, sorted(generichide)


def split_selector_list(selector: str) -> list[str] | None:
    parts: list[str] = []
    buf: list[str] = []
    paren = bracket = 0
    quote = ""
    for char in selector:
        if quote:
            buf.append(char)
            if char == "\\":
                return None
            if char == quote:
                quote = ""
            continue
        if char in "\"'":
            quote = char
            buf.append(char)
            continue
        if char == "(":
            paren += 1
        elif char == ")":
            paren = max(0, paren - 1)
        elif char == "[":
            bracket += 1
        elif char == "]":
            bracket = max(0, bracket - 1)
        if char == "," and paren == 0 and bracket == 0:
            part = "".join(buf).strip()
            if not part:
                return None
            parts.append(part)
            buf = []
            continue
        buf.append(char)
    if quote or paren or bracket:
        return None
    tail = "".join(buf).strip()
    if not tail:
        return None
    parts.append(tail)
    return parts


def selector_is_safe(selector: str) -> bool:
    if not selector or len(selector) > 1000:
        return False
    if any(marker in selector for marker in PROCEDURAL_MARKERS):
        return False
    if any(char in selector for char in "{}<>\\"):
        return False
    parts = split_selector_list(selector)
    if not parts:
        return False
    return True


def parse_domains(domain_text: str) -> tuple[list[str], list[str]] | None:
    if not domain_text:
        return [], []
    positive: list[str] = []
    negative: list[str] = []
    for part in domain_text.split(","):
        part = part.strip().lower()
        if not part:
            continue
        negated = part.startswith("~")
        host = part[1:] if negated else part
        if not valid_host(host):
            return None
        if negated:
            negative.append(host)
        else:
            positive.append(host)
    return positive, negative


def compile_cosmetic(paths: list[Path], generichide: list[str], stats: Stats) -> tuple[str, dict]:
    generic: list[str] = []
    generic_seen: set[str] = set()
    exceptions: dict[str, set[str]] = defaultdict(set)
    extra: dict[str, set[str]] = defaultdict(set)

    for line in iter_filter_lines(paths):
        if "#?#" in line or "#$#" in line:
            stats.skip("procedural")
            continue
        if "#@#" in line:
            kind = "except"
            domain_text, selector = line.split("#@#", 1)
        elif "##" in line:
            kind = "hide"
            domain_text, selector = line.split("##", 1)
        else:
            continue
        selector = selector.strip()
        if not selector_is_safe(selector):
            stats.skip("selector")
            continue
        domains = parse_domains(domain_text.strip())
        if domains is None:
            stats.skip("cosmetic-domain")
            continue
        positive, negative = domains
        if kind == "except":
            hosts = positive or []
            if not hosts:
                stats.skip("generic-unhide")
                continue
            for host in hosts:
                exceptions[host].add(selector)
            continue
        if positive:
            for host in positive:
                extra[host].add(selector)
            for host in negative:
                exceptions[host].add(selector)
            continue
        if selector in BARE_GLOBAL:
            stats.skip("broad-selector")
            continue
        if selector not in generic_seen:
            generic_seen.add(selector)
            generic.append(selector)
        for host in negative:
            exceptions[host].add(selector)

    excepted_selectors = {selector for selectors in exceptions.values() for selector in selectors}
    css_lines = [
        "/* Generic cosmetic filters derived from EasyList (CC BY-SA 3.0). */",
        "/* https://easylist.to/ */",
    ]
    conditional: list[str] = []
    for selector in generic:
        if selector in excepted_selectors:
            conditional.append(selector)
            continue
        parts = split_selector_list(selector)
        if not parts:
            continue
        prefixed = ",\n".join(
            f'html:not([data-adronin="off"]):not([data-adronin-generic="off"]) {part}'
            for part in parts
        )
        css_lines.append(f"{prefixed} {{\n  display: none !important;\n}}")

    sites = {
        "generichide": generichide,
        "conditional": conditional,
        "except": {host: sorted(selectors) for host, selectors in sorted(exceptions.items())},
        "extra": {host: sorted(selectors) for host, selectors in sorted(extra.items())},
    }
    return "\n".join(css_lines) + "\n", sites


def assign_ids(rules: list[dict], start: int) -> list[dict]:
    assigned = []
    next_id = start
    for rule in rules:
        clean = {key: value for key, value in rule.items() if not key.startswith("_")}
        clean["id"] = next_id
        next_id += 1
        assigned.append(clean)
    return assigned


def write_rulesets(name: str, rules: list[dict], start_id: int) -> list[dict]:
    assigned = assign_ids(rules, start_id)
    files = []
    for index in range(0, len(assigned), MAX_RULES_PER_FILE):
        chunk = assigned[index : index + MAX_RULES_PER_FILE]
        suffix = "" if index == 0 else f"-{index // MAX_RULES_PER_FILE + 1}"
        filename = f"{name}{suffix}.json"
        path = RULES_DIR / filename
        path.write_text(json.dumps(chunk, separators=(",", ":")), encoding="utf-8")
        files.append({"id": f"{name}{suffix}", "enabled": True, "path": f"rules/{filename}"})
        print(f"wrote {filename} ({len(chunk)} rules)", flush=True)
    return files


def update_manifest(resources: list[dict]) -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    manifest["declarative_net_request"] = {"rule_resources": resources}
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def build() -> None:
    RULES_DIR.mkdir(parents=True, exist_ok=True)
    local_extra = ROOT / "filters" / "extra.txt"
    ad_paths = fetch_all(AD_NETWORK) + [local_extra]
    ad_cosmetic_paths = fetch_all(AD_COSMETIC) + [local_extra]
    tracker_paths = fetch_all(TRACKER_NETWORK)

    stats = Stats()
    ad_rules, generichide = compile_network(ad_paths, stats)
    tracker_rules, tracker_generichide = compile_network(tracker_paths, stats)
    css, sites = compile_cosmetic(ad_cosmetic_paths, sorted(set(generichide)), stats)
    # Tracker lists rarely carry element-hiding exceptions. Keep ad generichide only.
    _ = tracker_generichide

    (RULES_DIR / "cosmetic-generic.css").write_text(css, encoding="utf-8")
    sites_js = "var ADRONIN_SITES = " + json.dumps(sites, separators=(",", ":")) + ";\n"
    (ROOT / "src" / "content" / "sites.js").write_text(sites_js, encoding="utf-8")

    resources = write_rulesets("ads", ad_rules, 1)
    resources += write_rulesets("trackers", tracker_rules, 1_000_000)
    groups = {
        "ads": [item["id"] for item in resources if item["id"].startswith("ads")],
        "trackers": [item["id"] for item in resources if item["id"].startswith("trackers")],
    }
    (RULES_DIR / "rulesets.json").write_text(json.dumps(groups, indent=2) + "\n", encoding="utf-8")
    update_manifest(resources)

    info = {
        "ads": len(ad_rules),
        "trackers": len(tracker_rules),
        "generic_selectors": css.count("{"),
        "conditional_selectors": len(sites["conditional"]),
        "site_selectors": sum(len(values) for values in sites["extra"].values()),
        "generichide": len(sites["generichide"]),
        "skipped": dict(stats.skipped),
        "license": "EasyList and EasyPrivacy are CC BY-SA 3.0. https://easylist.to/",
    }
    (RULES_DIR / "build-info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(info, indent=2))


def main() -> None:
    try:
        build()
    except Exception as error:  # noqa: BLE001 - top-level CLI boundary
        print(f"compile failed: {error}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()

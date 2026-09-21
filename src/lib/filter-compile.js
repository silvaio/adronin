/**
 * Compile EasyList / EasyPrivacy text into Chromium DNR rules and cosmetics.
 * Same job as scripts/compile_filters.py, for updates inside the service worker.
 */

const MAX_DOMAINS_PER_RULE = 200;
const MAX_URL_FILTER = 1000;
const PRIORITY_BLOCK = 10;
const PRIORITY_ALLOW = 20;
const PRIORITY_IMPORTANT_BLOCK = 30;
const PRIORITY_IMPORTANT_ALLOW = 40;

const RESOURCE_TYPES = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  object: "object",
  "object-subrequest": "object",
  xmlhttprequest: "xmlhttprequest",
  subdocument: "sub_frame",
  document: "main_frame",
  font: "font",
  media: "media",
  websocket: "websocket",
  ping: "ping",
  other: "other",
  frame: "sub_frame",
  popup: "main_frame",
};

const NON_NETWORK_OPTIONS = new Set(["generichide", "match-case", "important", "third-party"]);
const BARE_GLOBAL = new Set(["*", "html", "body", "head"]);
const PROCEDURAL_MARKERS = [
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
];

const HOST_RE =
  /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function validHost(host) {
  if (IP_RE.test(host)) {
    return host.split(".").every((part) => {
      const value = Number(part);
      return value >= 0 && value <= 255;
    });
  }
  return HOST_RE.test(host);
}

function pureHost(pattern) {
  if (!pattern.startsWith("||") || !pattern.endsWith("^") || pattern.split("^").length !== 2) {
    return null;
  }
  if (/[/*?&=%#]/.test(pattern)) return null;
  const host = pattern.slice(2, -1).toLowerCase();
  return validHost(host) ? host : null;
}

function validUrlFilter(pattern) {
  if (!pattern || ["*", "||", "|", "^"].includes(pattern) || pattern.length > MAX_URL_FILTER) {
    return false;
  }
  if (pattern.slice(2).includes("||")) return false;
  let body = pattern;
  if (body.startsWith("||")) body = body.slice(2);
  else if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  if (body.includes("|")) return false;
  for (const char of pattern) {
    const code = char.charCodeAt(0);
    if (code < 33 || code > 126 || "\"'<>{}\\ ".includes(char)) return false;
  }
  return true;
}

function optionsAreKnown(options) {
  if (!options) return true;
  for (const part of options.split(",")) {
    const token = part.trim();
    if (!token) return false;
    const name = token.startsWith("~") ? token.slice(1) : token;
    if (name.startsWith("domain=")) {
      if (token.startsWith("~")) return false;
      continue;
    }
    const base = name.split("=", 1)[0];
    if (!(base in RESOURCE_TYPES) && !NON_NETWORK_OPTIONS.has(base)) return false;
    if (token.startsWith("~") && !(base in RESOURCE_TYPES) && base !== "third-party") return false;
  }
  return true;
}

function splitPatternOptions(body) {
  if (!body.includes("$")) return [body, ""];
  let index = body.length;
  while (index > 0) {
    index = body.lastIndexOf("$", index - 1);
    if (index < 0) return null;
    const options = body.slice(index + 1);
    if (optionsAreKnown(options)) return [body.slice(0, index), options];
  }
  return null;
}

function parseOptions(options) {
  const included = [];
  const excluded = [];
  let party = null;
  let important = false;
  let caseSensitive = false;
  let generichide = false;
  const initiators = [];
  const excludedInitiators = [];

  for (const raw of options ? options.split(",") : []) {
    const part = raw.trim();
    if (!part) return null;
    const negated = part.startsWith("~");
    const token = negated ? part.slice(1) : part;
    if (token.startsWith("domain=")) {
      if (negated) return null;
      for (const domain of token.slice(7).split("|")) {
        const value = domain.trim().toLowerCase();
        if (!value) continue;
        const excludeDomain = value.startsWith("~");
        const host = excludeDomain ? value.slice(1) : value;
        if (!validHost(host)) return null;
        if (excludeDomain) excludedInitiators.push(host);
        else initiators.push(host);
      }
      continue;
    }
    if (token === "third-party") {
      party = negated ? "firstParty" : "thirdParty";
      continue;
    }
    if (token === "important") {
      important = true;
      continue;
    }
    if (token === "match-case") {
      caseSensitive = true;
      continue;
    }
    if (token === "generichide") {
      generichide = true;
      continue;
    }
    const mapped = RESOURCE_TYPES[token];
    if (!mapped) return null;
    if (negated) excluded.push(mapped);
    else included.push(mapped);
  }

  return {
    included: [...new Set(included)],
    excluded: [...new Set(excluded)],
    party,
    important,
    caseSensitive,
    generichide,
    initiators: [...new Set(initiators)],
    excludedInitiators: [...new Set(excludedInitiators)],
  };
}

function resourceCondition(included, excluded) {
  const includeMain = included.includes("main_frame");
  const positive = included.filter((item) => item !== "main_frame" || includeMain);
  if (positive.length) {
    const types = positive.filter((item) => !excluded.includes(item));
    if (!types.length) return null;
    return { resourceTypes: types };
  }
  const excludedTypes = [...excluded];
  if (!includeMain && !excludedTypes.includes("main_frame")) excludedTypes.push("main_frame");
  return { excludedResourceTypes: [...new Set(excludedTypes)] };
}

function priorityFor(allow, important) {
  if (allow && important) return PRIORITY_IMPORTANT_ALLOW;
  if (important) return PRIORITY_IMPORTANT_BLOCK;
  if (allow) return PRIORITY_ALLOW;
  return PRIORITY_BLOCK;
}

function parseNetworkLine(line) {
  const allow = line.startsWith("@@");
  const body = allow ? line.slice(2) : line;
  const split = splitPatternOptions(body);
  if (!split) return { skip: "options" };
  const [pattern, options] = split;
  const parsed = parseOptions(options);
  if (!parsed) return { skip: "options" };
  const types = resourceCondition(parsed.included, parsed.excluded);
  if (!types) return { skip: "types" };
  const host = pureHost(pattern);
  const catchall = pattern === "" || pattern === "*";
  const narrowing = Boolean(parsed.included.length || parsed.excluded.length || parsed.party);
  if (parsed.generichide && !narrowing) {
    return {
      network: false,
      allow,
      generichide: true,
      host,
      initiators: parsed.initiators,
    };
  }
  if (!host && !catchall && !validUrlFilter(pattern)) return { skip: "pattern" };
  if (catchall && !parsed.included.length) {
    return {
      network: false,
      allow,
      generichide: parsed.generichide,
      host: null,
      initiators: parsed.initiators,
    };
  }
  return {
    network: true,
    allow,
    important: parsed.important,
    generichide: parsed.generichide,
    host,
    pattern,
    catchall,
    party: parsed.party,
    caseSensitive: parsed.caseSensitive,
    initiators: parsed.initiators,
    excludedInitiators: parsed.excludedInitiators,
    types,
    priority: priorityFor(allow, parsed.important),
  };
}

function iterLines(texts) {
  const lines = [];
  for (const text of texts) {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("!") || line.startsWith("[Adblock") || line.startsWith("[uBlock")) {
        continue;
      }
      lines.push(line);
    }
  }
  return lines;
}

function compileNetwork(texts) {
  const groups = new Map();
  const singles = [];
  const generichide = new Set();
  const seenSingle = new Set();
  const skipped = {};

  const skip = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
  };

  for (const line of iterLines(texts)) {
    if (["##", "#@#", "#?#", "#$#"].some((marker) => line.includes(marker))) continue;
    const parsed = parseNetworkLine(line);
    if (parsed.skip) {
      skip(parsed.skip);
      continue;
    }
    if (parsed.generichide && parsed.allow) {
      if (parsed.host) generichide.add(parsed.host);
      for (const host of parsed.initiators || []) generichide.add(host);
    }
    if (!parsed.network) continue;
    if (parsed.host && !parsed.catchall) {
      const key = JSON.stringify([
        parsed.allow,
        parsed.priority,
        parsed.party,
        parsed.types.resourceTypes || [],
        parsed.types.excludedResourceTypes || [],
        parsed.initiators,
        parsed.excludedInitiators,
        parsed.caseSensitive,
      ]);
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(parsed.host);
      continue;
    }
    const fingerprint = JSON.stringify({
      allow: parsed.allow,
      priority: parsed.priority,
      pattern: parsed.catchall ? "" : parsed.pattern,
      party: parsed.party,
      types: parsed.types,
      initiators: parsed.initiators,
      excludedInitiators: parsed.excludedInitiators,
      case: parsed.caseSensitive,
    });
    if (seenSingle.has(fingerprint)) continue;
    seenSingle.add(fingerprint);
    singles.push(parsed);
  }

  const rules = [];
  for (const [key, hosts] of groups) {
    const [allow, priority, party, resourceTypes, excludedTypes, initiators, excludedInitiators, caseSensitive] =
      JSON.parse(key);
    const ordered = [...hosts].sort();
    for (let offset = 0; offset < ordered.length; offset += MAX_DOMAINS_PER_RULE) {
      const chunk = ordered.slice(offset, offset + MAX_DOMAINS_PER_RULE);
      const condition = { requestDomains: chunk };
      if (resourceTypes.length) condition.resourceTypes = resourceTypes;
      else if (excludedTypes.length) condition.excludedResourceTypes = excludedTypes;
      if (party) condition.domainType = party;
      if (initiators.length) condition.initiatorDomains = initiators;
      if (excludedInitiators.length) condition.excludedInitiatorDomains = excludedInitiators;
      rules.push({
        priority,
        action: { type: allow ? "allow" : "block" },
        condition,
        _case: caseSensitive,
      });
    }
  }

  for (const parsed of singles) {
    const condition = { ...parsed.types };
    if (!parsed.catchall) {
      condition.urlFilter = parsed.pattern;
      if (parsed.caseSensitive) condition.isUrlFilterCaseSensitive = true;
    }
    if (parsed.party) condition.domainType = parsed.party;
    if (parsed.initiators.length) condition.initiatorDomains = parsed.initiators;
    if (parsed.excludedInitiators.length) {
      condition.excludedInitiatorDomains = parsed.excludedInitiators;
    }
    rules.push({
      priority: parsed.priority,
      action: { type: parsed.allow ? "allow" : "block" },
      condition,
    });
  }

  // Rule order does not matter for DNR matching; skip an expensive sort.
  return { rules, generichide: [...generichide].sort(), skipped };
}

function splitSelectorList(selector) {
  const parts = [];
  let buf = "";
  let paren = 0;
  let bracket = 0;
  let quote = "";
  for (const char of selector) {
    if (quote) {
      buf += char;
      if (char === "\\") return null;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      buf += char;
      continue;
    }
    if (char === "(") paren += 1;
    else if (char === ")") paren = Math.max(0, paren - 1);
    else if (char === "[") bracket += 1;
    else if (char === "]") bracket = Math.max(0, bracket - 1);
    if (char === "," && paren === 0 && bracket === 0) {
      const part = buf.trim();
      if (!part) return null;
      parts.push(part);
      buf = "";
      continue;
    }
    buf += char;
  }
  if (quote || paren || bracket) return null;
  const tail = buf.trim();
  if (!tail) return null;
  parts.push(tail);
  return parts;
}

function selectorIsSafe(selector) {
  if (!selector || selector.length > 1000) return false;
  if (PROCEDURAL_MARKERS.some((marker) => selector.includes(marker))) return false;
  if (/[{}<>\\]/.test(selector)) return false;
  return Boolean(splitSelectorList(selector));
}

function parseDomains(domainText) {
  if (!domainText) return [[], []];
  const positive = [];
  const negative = [];
  for (const part of domainText.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const negated = token.startsWith("~");
    const host = negated ? token.slice(1) : token;
    if (!validHost(host)) return null;
    if (negated) negative.push(host);
    else positive.push(host);
  }
  return [positive, negative];
}

function compileCosmetic(texts, generichide) {
  const generic = [];
  const genericSeen = new Set();
  const exceptions = new Map();
  const extra = new Map();
  const skipped = {};
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
  };

  for (const line of iterLines(texts)) {
    if (line.includes("#?#") || line.includes("#$#")) {
      skip("procedural");
      continue;
    }
    let kind;
    let domainText;
    let selector;
    if (line.includes("#@#")) {
      kind = "except";
      [domainText, selector] = line.split("#@#");
    } else if (line.includes("##")) {
      kind = "hide";
      [domainText, selector] = line.split("##");
    } else {
      continue;
    }
    selector = selector.trim();
    if (!selectorIsSafe(selector)) {
      skip("selector");
      continue;
    }
    const domains = parseDomains(domainText.trim());
    if (!domains) {
      skip("cosmetic-domain");
      continue;
    }
    const [positive, negative] = domains;
    if (kind === "except") {
      if (!positive.length) {
        skip("generic-unhide");
        continue;
      }
      for (const host of positive) {
        if (!exceptions.has(host)) exceptions.set(host, new Set());
        exceptions.get(host).add(selector);
      }
      continue;
    }
    if (positive.length) {
      for (const host of positive) {
        if (!extra.has(host)) extra.set(host, new Set());
        extra.get(host).add(selector);
      }
      for (const host of negative) {
        if (!exceptions.has(host)) exceptions.set(host, new Set());
        exceptions.get(host).add(selector);
      }
      continue;
    }
    if (BARE_GLOBAL.has(selector)) {
      skip("broad-selector");
      continue;
    }
    if (!genericSeen.has(selector)) {
      genericSeen.add(selector);
      generic.push(selector);
    }
    for (const host of negative) {
      if (!exceptions.has(host)) exceptions.set(host, new Set());
      exceptions.get(host).add(selector);
    }
  }

  const exceptedSelectors = new Set();
  for (const selectors of exceptions.values()) {
    for (const selector of selectors) exceptedSelectors.add(selector);
  }

  const cssLines = [
    "/* Generic cosmetic filters derived from EasyList (CC BY-SA 3.0). */",
    "/* https://easylist.to/ */",
  ];
  const conditional = [];
  for (const selector of generic) {
    if (exceptedSelectors.has(selector)) {
      conditional.push(selector);
      continue;
    }
    const parts = splitSelectorList(selector);
    if (!parts) continue;
    const prefixed = parts
      .map(
        (part) =>
          `html:not([data-adronin="off"]):not([data-adronin-generic="off"]) ${part}`,
      )
      .join(",\n");
    cssLines.push(`${prefixed} {\n  display: none !important;\n}`);
  }

  const sites = {
    generichide,
    conditional,
    except: Object.fromEntries(
      [...exceptions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([host, selectors]) => [host, [...selectors].sort()]),
    ),
    extra: Object.fromEntries(
      [...extra.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([host, selectors]) => [host, [...selectors].sort()]),
    ),
  };

  return { css: `${cssLines.join("\n")}\n`, sites, skipped };
}

export function compileFilters({ adNetwork, adCosmetic, trackerNetwork, extra = "" }) {
  const adTexts = [...adNetwork, extra].filter(Boolean);
  const cosmeticTexts = [...adCosmetic, extra].filter(Boolean);
  const trackerTexts = [...trackerNetwork].filter(Boolean);
  const ads = compileNetwork(adTexts);
  const trackers = compileNetwork(trackerTexts);
  const cosmetic = compileCosmetic(cosmeticTexts, ads.generichide);
  return {
    ads: ads.rules.map(({ _case, ...rule }) => rule),
    trackers: trackers.rules.map(({ _case, ...rule }) => rule),
    css: cosmetic.css,
    sites: cosmetic.sites,
    stats: {
      ads: ads.rules.length,
      trackers: trackers.rules.length,
      genericSelectors: (cosmetic.css.match(/\{/g) || []).length,
      skipped: { ...ads.skipped, ...trackers.skipped, ...cosmetic.skipped },
    },
  };
}

export const LIST_SOURCES = {
  adNetwork: [
    "easylist/easylist_adservers.txt",
    "easylist/easylist_general_block.txt",
    "easylist/easylist_thirdparty.txt",
    "easylist/easylist_specific_block.txt",
    "easylist/easylist_allowlist.txt",
  ],
  adCosmetic: [
    "easylist/easylist_general_hide.txt",
    "easylist/easylist_specific_hide.txt",
    "easylist/easylist_allowlist_general_hide.txt",
  ],
  trackerNetwork: [
    "easyprivacy/easyprivacy_trackingservers.txt",
    "easyprivacy/easyprivacy_trackingservers_general.txt",
    "easyprivacy/easyprivacy_trackingservers_international.txt",
    "easyprivacy/easyprivacy_trackingservers_thirdparty.txt",
    "easyprivacy/easyprivacy_thirdparty.txt",
    "easyprivacy/easyprivacy_thirdparty_international.txt",
    "easyprivacy/easyprivacy_general.txt",
    "easyprivacy/easyprivacy_specific.txt",
    "easyprivacy/easyprivacy_specific_international.txt",
    "easyprivacy/easyprivacy_allowlist.txt",
    "easyprivacy/easyprivacy_allowlist_international.txt",
  ],
};

export const LIST_BASE = "https://cdn.jsdelivr.net/gh/easylist/easylist@master/";

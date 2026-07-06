#!/usr/bin/env node
/**
 * tw-sort — deterministic Tailwind class sorter for Hyvä (Magento 2) .phtml templates.
 *
 * Sorts the classes inside double-quoted  class="..."  attributes into Tailwind's
 * official "recommended" order, delegating the ordering to prettier-plugin-tailwindcss
 * (so it is byte-for-byte reproducible). Dynamic PHP inside a class attribute
 * (`<?= ... ?>`) is preserved and moved to the END of the class list. Anything risky
 * is left untouched. See README.md.
 *
 * Usage:  tw-sort [--write|--check] [--stylesheet <file>] [path ...]
 */

import prettier from "prettier";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Absolute path so plugin resolution never depends on the current working dir.
const TW_PLUGIN = require.resolve("prettier-plugin-tailwindcss");

// Directories never descended into during recursive discovery.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".idea", "var", "generated", "pub", "vendor", "dev",
]);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  let mode = "check";
  let stylesheet = null;
  let help = false;
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write" || a === "-w") mode = "write";
    else if (a === "--check" || a === "-c") mode = "check";
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--stylesheet" || a === "--config") stylesheet = argv[++i];
    else paths.push(a);
  }
  if (paths.length === 0) paths.push(".");
  return { mode, stylesheet, help, paths };
}

const HELP = `tw-sort — sort Tailwind classes inside class="..." in Hyvä .phtml files

Usage:
  tw-sort [--write|--check] [--stylesheet <file>] [path ...]

Options:
  -w, --write            Rewrite files in place (only when the order changes).
  -c, --check            Report files that would change; exit 1 if any (default).
      --stylesheet <f>   Force a Tailwind v4 stylesheet (or v3 config) for all files,
                         instead of auto-detecting each theme's web/tailwind entry.
  -h, --help             Show this help.

Paths may be files or directories (directories are scanned for *.phtml).
Default path is the current directory.`;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function collectPhtml(target, out) {
  let st;
  try { st = fs.statSync(target); } catch { return; }
  if (st.isDirectory()) {
    for (const ent of fs.readdirSync(target, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        collectPhtml(path.join(target, ent.name), out);
      } else if (ent.isFile() && ent.name.endsWith(".phtml")) {
        out.add(path.resolve(target, ent.name));
      }
    }
  } else if (st.isFile()) {
    // Explicitly named file: honor it even inside a skipped dir.
    out.add(path.resolve(target));
  }
}

// ---------------------------------------------------------------------------
// Per-theme Tailwind entry detection (walk up to <themeRoot>/web/tailwind/...)
// ---------------------------------------------------------------------------
const configCache = new Map(); // startDir -> { option, value } | null
function detectConfig(fileAbs, override) {
  if (override) {
    const abs = path.resolve(override);
    const option = abs.endsWith(".css") ? "tailwindStylesheet" : "tailwindConfig";
    return { option, value: abs };
  }
  let dir = path.dirname(fileAbs);
  const seen = [];
  while (true) {
    if (configCache.has(dir)) {
      const hit = configCache.get(dir);
      for (const d of seen) configCache.set(d, hit);
      return hit;
    }
    seen.push(dir);
    const v4 = path.join(dir, "web", "tailwind", "tailwind-source.css");
    const v3 = path.join(dir, "web", "tailwind", "tailwind.config.js");
    let hit = null;
    if (fs.existsSync(v4)) hit = { option: "tailwindStylesheet", value: v4 };
    else if (fs.existsSync(v3)) hit = { option: "tailwindConfig", value: v3 };
    if (hit) {
      for (const d of seen) configCache.set(d, hit);
      return hit;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const d of seen) configCache.set(d, null);
      return null;
    }
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Scan a file for eligible  class="..."  attributes.
// Returns [{ valueStart, valueEnd, raw }] with valueStart/valueEnd bounding the
// text between the quotes.  <?...?> islands are consumed opaquely (quotes inside
// them are ignored), and the value may span multiple lines.
// ---------------------------------------------------------------------------
const CLASS_ATTR = /(?<![\w:\-\[])class\s*=\s*"/g;
function findClassAttributes(content) {
  const found = [];
  let m;
  CLASS_ATTR.lastIndex = 0;
  while ((m = CLASS_ATTR.exec(content)) !== null) {
    const valueStart = m.index + m[0].length;
    let i = valueStart;
    let valueEnd = -1;
    while (i < content.length) {
      if (content.startsWith("<?", i)) {
        const close = content.indexOf("?>", i + 2);
        if (close === -1) { i = content.length; break; } // unterminated PHP
        i = close + 2;
        continue;
      }
      if (content[i] === '"') { valueEnd = i; break; }
      i++;
    }
    if (valueEnd === -1) continue; // no closing quote / unterminated: skip safely
    found.push({ valueStart, valueEnd, raw: content.slice(valueStart, valueEnd) });
    CLASS_ATTR.lastIndex = valueEnd + 1;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Split a class value into whitespace-separated tokens; a <?...?> island is
// glued into whatever token it touches (so `btn-<?= $x ?>` stays one token).
// ---------------------------------------------------------------------------
function tokenize(value) {
  const tokens = [];
  let cur = "";
  let i = 0;
  while (i < value.length) {
    if (value.startsWith("<?", i)) {
      const close = value.indexOf("?>", i + 2);
      const end = close === -1 ? value.length : close + 2;
      cur += value.slice(i, end);
      i = end;
      continue;
    }
    const ch = value[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
      if (cur) { tokens.push(cur); cur = ""; }
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// Decide whether a class value is eligible, and split into static vs dynamic.
// Returns null to skip (leave untouched), else { staticStr, dynamics }.
function classifyValue(value) {
  // Guard: every PHP island must be a short-echo `<?=`. Any `<?php`/`<?` block
  // (control flow, statements) is too risky (glued tokens) -> skip.
  let scan = 0;
  while (true) {
    const open = value.indexOf("<?", scan);
    if (open === -1) break;
    if (!value.startsWith("<?=", open)) return null; // not a short echo
    const close = value.indexOf("?>", open + 2);
    if (close === -1) return null; // unterminated
    scan = close + 2;
  }
  // Guard: braces almost always mean JS object / template, not a class list.
  const withoutPhp = value.replace(/<\?[\s\S]*?\?>/g, "");
  if (/[{}]/.test(withoutPhp)) return null;

  const tokens = tokenize(value);
  const staticTokens = [];
  const dynamics = [];
  for (const t of tokens) {
    if (t.includes("<?")) dynamics.push(t);
    else staticTokens.push(t);
  }
  if (staticTokens.length === 0) return null; // fully dynamic: nothing to sort
  return { staticStr: staticTokens.join(" "), dynamics };
}

// ---------------------------------------------------------------------------
// Ordering oracle: sort many unique static strings for one Tailwind config in a
// single prettier pass, using prettier-plugin-tailwindcss.
// ---------------------------------------------------------------------------
async function sortStrings(strings, config) {
  const list = [...strings];
  if (list.length === 0) return new Map();
  const doc =
    list.map((s) => `<div class="${s}"></div>`).join("\n") + "\n";
  const formatted = await prettier.format(doc, {
    parser: "html",
    plugins: [TW_PLUGIN],
    [config.option]: config.value,
    printWidth: 1000000,
  });
  const re = /class="([^"]*)"/g;
  const result = new Map();
  let m;
  let idx = 0;
  while ((m = re.exec(formatted)) !== null) {
    if (idx >= list.length) break;
    result.set(list[idx], m[1]);
    idx++;
  }
  if (idx !== list.length) {
    throw new Error(
      `oracle mapping mismatch: sent ${list.length}, got ${idx}`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { mode, stylesheet, help, paths } = parseArgs(process.argv.slice(2));
  if (help) { console.log(HELP); process.exit(0); }

  const files = new Set();
  for (const p of paths) collectPhtml(p, files);
  const fileList = [...files].sort();

  // Pass 1: parse every file, gather eligible attributes grouped by Tailwind config.
  const perFile = new Map(); // file -> { content, attrs: [{valueStart,valueEnd,staticStr,dynamics}] }
  const noConfig = [];
  const byConfig = new Map(); // configValue -> { config, strings:Set }

  for (const file of fileList) {
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (!content.includes("class")) continue;

    const config = detectConfig(file, stylesheet);
    const attrs = [];
    for (const at of findClassAttributes(content)) {
      const cls = classifyValue(at.raw);
      if (!cls) continue;
      attrs.push({ ...at, ...cls });
    }
    if (attrs.length === 0) continue;

    if (!config) { noConfig.push(file); continue; }

    perFile.set(file, { content, attrs, config });
    let bucket = byConfig.get(config.value);
    if (!bucket) { bucket = { config, strings: new Set() }; byConfig.set(config.value, bucket); }
    for (const a of attrs) bucket.strings.add(a.staticStr);
  }

  // Pass 2: run the oracle once per Tailwind config.
  const sortedByConfig = new Map(); // configValue -> Map(raw -> sorted)
  for (const [value, bucket] of byConfig) {
    try {
      sortedByConfig.set(value, await sortStrings(bucket.strings, bucket.config));
    } catch (e) {
      console.error(`ERROR ordering classes for ${value}: ${e.message}`);
      process.exit(2);
    }
  }

  // Pass 3: rebuild each file (apply edits right-to-left to keep offsets valid).
  let changedCount = 0;
  const changedFiles = [];
  for (const [file, info] of perFile) {
    const sortMap = sortedByConfig.get(info.config.value);
    let content = info.content;
    let fileChanged = false;
    for (const a of [...info.attrs].sort((x, y) => y.valueStart - x.valueStart)) {
      const sortedStatic = sortMap.get(a.staticStr) ?? a.staticStr;
      const parts = [sortedStatic, ...a.dynamics].filter(Boolean);
      const newValue = parts.join(" ");
      if (newValue === a.raw) continue;
      content = content.slice(0, a.valueStart) + newValue + content.slice(a.valueEnd);
      fileChanged = true;
    }
    if (!fileChanged) continue;
    changedCount++;
    changedFiles.push(file);
    if (mode === "write") fs.writeFileSync(file, content, "utf8");
  }

  // Report
  for (const f of changedFiles) {
    console.log(`${mode === "write" ? "sorted" : "would sort"}  ${f}`);
  }
  if (noConfig.length) {
    console.error(
      `\n${noConfig.length} file(s) skipped — no Tailwind entry (web/tailwind/tailwind-source.css) found above them. ` +
      `Pass --stylesheet <file> to force one.`
    );
  }
  const scanned = fileList.length;
  console.log(
    `\n${scanned} .phtml scanned, ${changedCount} ${mode === "write" ? "changed" : "would change"}.`
  );
  if (mode === "check" && changedCount > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });

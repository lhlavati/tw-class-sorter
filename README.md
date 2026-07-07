# tw-sort — Tailwind class sorter for Hyvä (Magento 2) `.phtml`

Deterministically sorts Tailwind classes inside double-quoted `class="..."` attributes into
Tailwind's official recommended order. Ordering is delegated to
`prettier-plugin-tailwindcss` (the same engine Prettier users get), so results are
byte-for-byte reproducible — no LLM, no hand-maintained order list. Versions are pinned
(`prettier` 3.9.4, `prettier-plugin-tailwindcss` 0.6.14) so every teammate sorts identically.

Works in **every** Hyvä project with no per-project files: for each `.phtml` it walks up to
the theme root and uses that theme's own Tailwind entry
(`web/tailwind/tailwind-source.css` for v4, or `tailwind.config.js` for v3).

## Behavior

- Only touches double-quoted `class="..."` HTML attributes.
- Dynamic PHP `<?= ... ?>` inside a class is **preserved verbatim and moved to the end**
  (attribute order never affects the CSS cascade, so this is safe).
- Multi-line `class="..."` attributes are collapsed to a single line.
- Duplicate classes are removed (standard `prettier-plugin-tailwindcss` behavior).
- **Left completely untouched** (safety guards): Alpine `:class` / `x-bind:class`,
  single-quoted `class='...'`, fully dynamic `class="<?= ... ?>"`, and any value containing a
  `<?php ... ?>` control block or `{`/`}`.

---

## Setup (each developer, once)

### 1. Install the CLI globally — works in every Hyvä project

```bash
npm i -g github:lhlavati/tw-class-sorter
tw-sort --help          # sanity check
```
Update later with the same command. To uninstall: `npm rm -g tw-class-sorter`.

### 2. Install the Claude Code plugin (adds the `/sort-tailwind` skill)

```
/plugin marketplace add lhlavati/tw-class-sorter
/plugin install tw-sort@lhlavati-tools
```
Invoke as `/tw-sort:sort-tailwind` (or just ask Claude to "sort the Tailwind classes").
Refresh after updates: `/plugin marketplace update lhlavati-tools`.
The skill calls the global `tw-sort`, and falls back to `npx` from the repo if it isn't installed.

### 3. (Optional) PHPStorm — sort on save, configured once for all projects

**Settings → Tools → File Watchers → `+` → custom** (or **File → New Projects Setup →
Settings for New Projects** to apply to future projects too):

- **Name:** Sort Tailwind (phtml)
- **File type:** PHP  ·  **Scope:** `file:*.phtml`
- **Program:** `tw-sort`  (or the absolute path from `which tw-sort` if PHPStorm can't find it)
- **Arguments:** `--write $FilePath$`
- **Working directory:** `$FileDir$`
- **Output paths to refresh:** `$FilePath$`

---

## Usage

```
tw-sort [--write|--check] [--stylesheet <file>] [path ...]
```

- `--check` (default): list files that would change; exit code 1 if any. Non-destructive.
- `--write`: rewrite files in place (only when the order actually changes).
- `--stylesheet <file>`: force a Tailwind entry for all files (for module templates in
  `app/code` that live outside a theme, where auto-detection can't find one).
- `path`: files or directories (dirs scanned recursively for `*.phtml`); `node_modules`,
  `.git`, `vendor`, `var`, `generated`, `pub`, `dev`, `.idea` are skipped during recursion
  (an explicitly named file inside them is still honored).

Examples:
```bash
tw-sort --check .                                   # preview whole project
tw-sort --write app/design/frontend/Vendor/theme    # sort one theme
tw-sort --write path/to/template.phtml              # sort one file (used by the watcher)
```

Changes land in your working tree — review with `git diff`, roll back with `git checkout`.

## Maintainer notes

- This repo is simultaneously: the npm-installable CLI (`bin: tw-sort`), a Claude Code plugin
  (`.claude-plugin/plugin.json` + `skills/`), and its marketplace
  (`.claude-plugin/marketplace.json`, `source: "./"`).
- `node_modules/` is gitignored; `package-lock.json` is committed for reproducible installs.
- Out of scope by design: single-quoted class attributes, Alpine `:class` object literals,
  `@apply` in CSS, and `<?php ?>` control blocks.

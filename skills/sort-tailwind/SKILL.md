---
name: sort-tailwind
description: Sort Tailwind CSS classes into the official recommended order inside class="..." attributes of Hyvä (Magento 2) .phtml templates. Use when the user asks to sort/order/organize Tailwind classes in .phtml files, a theme, or the current project.
---

# Sort Tailwind classes in Hyvä .phtml

This skill runs the deterministic `tw-sort` CLI. Ordering is delegated to
`prettier-plugin-tailwindcss`, so results are byte-for-byte the official Tailwind order.
**Do not sort classes yourself** — always shell out to the CLI.

## How to run

Prefer the globally installed CLI:
```
tw-sort --check <path>     # preview (non-destructive; exits 1 if anything would change)
tw-sort --write <path>     # apply in place
```

If `tw-sort` is not found on PATH (colleague hasn't run the global install), fall back to
running it straight from the repo with npx — same flags:
```
npx --yes github:lhlavati/tw-class-sorter --check <path>
npx --yes github:lhlavati/tw-class-sorter --write <path>
```

`<path>` may be a single `.phtml` file, a directory (scanned recursively for `*.phtml`), or
omitted to mean the current directory.

## What it does
- Sorts classes only inside double-quoted `class="..."` attributes.
- Moves dynamic PHP (`<?= ... ?>`) to the END of the class list; preserves it verbatim.
- Collapses multi-line `class="..."` to one line; de-duplicates classes.
- Leaves untouched: Alpine `:class`/`x-bind:class`, single-quoted `class='...'`,
  fully-dynamic `class="<?= ... ?>"`, and any value containing a `<?php ... ?>` block.
- Auto-detects each theme's Tailwind entry (`web/tailwind/tailwind-source.css` v4,
  `tailwind.config.js` v3). No per-project config needed.

## Guidance
- Default to `--check` first and show the user the summary; only `--write` when they ask to
  apply, or clearly asked to sort.
- If the repo is git-tracked, remind the user changes are reviewable via `git diff` and
  revertible via `git checkout`.
- For module templates outside a theme (auto-detection can't find a stylesheet), pass
  `--stylesheet <path-to>/web/tailwind/tailwind-source.css`.

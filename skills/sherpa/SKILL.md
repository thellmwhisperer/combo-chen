---
name: sherpa
description: Read, write, and maintain the Sherpa navigable-comment standard on any source file, in any language, in any project, with no dependencies. Use when reading an unfamiliar file to navigate it efficiently, when asked to "apply sherpa"/"hazme sherpa"/"add reading guide", when project instructions require Sherpa before code edits, and when editing a file that already carries Sherpa (keep the map in sync).
user-invocable: true
---

# Sherpa — navigable code comment standard

A commenting discipline for the agent era. A reader (human or agent) opens a
file, reads a ~20-line header, and knows where to start and how to navigate
without reading top-to-bottom. The same markers that orient a reader are
maintained by whoever edits the file, so the map never drifts from the code.

Sherpa is language-agnostic, project-agnostic, and dependency-free. It is a
convention about comments — nothing to install, import, or configure.

## The two layers

Every Sherpa file has the same two layers, regardless of language.

**Layer 1 — header at the top of the file.** Carries the overview, a reading
order, the main flow, the public surface, the internals, the exported symbols,
and the key dependencies.

**Layer 2 — inline section markers.** Mark the boundary of each logical section
so a reader can scroll/fold to the right place.

Both layers use the **host language's normal comment syntax**. Sherpa never
prescribes a comment style; it adapts to the file:

- Block/doc comment for C-like, JS/TS, Go, Rust, Java, etc. (`/** … */`)
- Module docstring for Python (`""" … """`, after shebang/encoding, before imports)
- Contiguous line-comment block for shell, Ruby, Perl, etc. (`#`)

The _content_ of the header is identical across languages; only the comment
delimiters and the inline-marker prefix change.

## Header content

```
@overview One-line summary. ~N lines, M public symbols, key responsibility.

  READING GUIDE
  -------------
  1. Start at <core-symbol>           <- why this one first
  2. <next-symbol>                    <- secondary
  3. Everything else is helpers       <- read on demand

  MAIN FLOW
  ---------
  <entry> -> <step-one> -> <step-two> -> <outcome>

  PUBLIC API
  ----------
  core_symbol()       One-line description
  another_symbol()    One-line description

  INTERNALS
  ---------
  _helper_one, _helper_two

@exports core_symbol, another_symbol
@deps grouped by source
```

Wrap that content in the host language's doc-comment syntax. Box-drawing
characters (`┌─ … ─┐`) are fine where the comment style tolerates them; plain
headings are cleaner for line-comment languages — pick what reads well in the file.

Rules for the header:

- **English**, always.
- **READING GUIDE** gives the reading order; item #1 is the CORE entry point.
- **MAIN FLOW** is a one-line chain `A -> B -> C -> result`.
- **PUBLIC API** lists every symbol a caller would use, one line each.
- **INTERNALS** lists private helpers grouped by purpose.
- **`@exports`** lists bare public symbol names (no parentheses) so editors can
  jump to them. Private helpers go to INTERNALS, not `@exports`.
- **`@deps`** lists key dependencies grouped by source.

## Inline section markers

```
-- N/M ROLE · Section name

  … code …

-/ N/M
```

Rules for markers:

- Open a section with `<prefix> -- N/M ROLE · Section name --`, close it with
  `<prefix> -/ N/M`, where `<prefix>` is the language's line-comment prefix
  (`//`, `#`, `--`, etc.).
- `N` is the section's ordinal, `M` the total. Both are optional — use `N/M` for
  a "3 of 7" sense, or just `N` to avoid renumbering on insertions.
- `ROLE` is `CORE` (primary logic, start here) or `HELPER` (supporting). The
  CORE section gets `<- START HERE` appended.
- Keep sections roughly balanced — not 90% of the file in one section.
- Section names should reference real symbols, so they remain clickable.
- For command/handler/route registries, add a one-line marker before each entry.

## Folded-navigation rule

Navigation must survive code folding. If a large class or function owns several
internal sections, add a short SHERPA MAP comment immediately before the
construct, listing its internal sections and their key members.

## How to apply

1. Read the file end to end once. Identify the logical sections.
2. Find the CORE symbol(s) — the real entry point(s).
3. Choose a section count (~3–5 for small files, 5–9 for large ones).
4. Write the header: READING GUIDE → MAIN FLOW → PUBLIC API → INTERNALS →
   `@exports` → `@deps`, built from concrete symbols.
5. Insert `-- N/M ROLE · name --` / `-/ N/M` markers at section boundaries.
6. **Describe the file that exists. Do not invent architecture.**

## Maintenance contract

A stale Sherpa map is worse than none. On every edit, update the map.

| Change to code          | Sherpa update                                 |
| ----------------------- | --------------------------------------------- |
| Add a public symbol     | Add to `@exports` and PUBLIC API              |
| Remove a public symbol  | Remove from `@exports` and PUBLIC API         |
| Rename a symbol         | Update every header reference                 |
| Add/remove a dependency | Update `@deps`                                |
| Add a logical section   | Insert marker pair; renumber if using `/M`    |
| Merge sections          | Remove marker pair; renumber if needed        |
| CORE entry changes      | Update READING GUIDE #1 and START HERE marker |

Self-check before committing: `@exports` matches actual exports, every symbol
resolves, markers in order with no gaps, CORE has START HERE, PUBLIC API complete.

## When to apply

Apply to **every source file**. No line-count threshold. A 12-line file with
3 exports needs an `@overview` and `@exports`. The goal is zero dark holes:
open any file and know what's inside.

Skip generated code, vendored code, and binary formats only.

# mend: one patch tool for every AI edit format

`mend` applies the edits AI models write to a tree of text files. Models write
edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and mend reads all four to one written contract, finds the lines an
edit names even when the model drifted their whitespace or indentation, and
changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the patch file, or standard input when it is absent or `-`.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints what changed (`A`, `D`, `M` or `R` lines) and `ok: <n> files`.
Exit 1 prints one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits`; no file is written. Exit 2 prints a single
`error: ...` line for a usage, missing-patch, format or parse fault.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the
  checks from the env, runs `node main.ts` on each one in a fresh directory,
  and posts what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Matching

An edit names old lines that are replaced by new lines. They are found in
the file at the first of three tiers at which they occur at least once:
exact lines, lines equal once trailing spaces and tabs are removed, then
lines equal once leading and trailing spaces and tabs are removed. Context
lines are written as the file's own matched lines, and at the third tier new
lines are re-indented to the file's indentation. Unified hunks take the
occurrence nearest their (possibly wrong) line number; SEARCH/REPLACE blocks
fail when their old lines occur more than once; V4A chunks walk a cursor
from an anchor line.

## License

MIT — see `LICENSE`.

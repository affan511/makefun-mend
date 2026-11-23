# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/affan511/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/affan511/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format: a command-line tool that applies AI-written edits in four formats (unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of files, to one written specification. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the path of the patch file, or `-`/absent for standard input. `--format=NAME` reads one format (`unified`, `search-replace`, `v4a`, `json`, or `auto`, the default, which detects it). `--check` does everything but write. `--strict` matches lines exactly. See `SPEC.md` in the kit for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

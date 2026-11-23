# site-generator-speed-01-run-20261122-v2

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/xenopatijaya/site-generator-speed-01-run-20261122-v2/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/xenopatijaya/site-generator-speed-01-run-20261122-v2/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0, built for make.fun's "Build a static site faster" bounty. `solve.js` returns, for every case, exactly the output tree makefun-site's `build` returns — byte for byte — in a fraction of the CPU time.

How it is fast:

- Templates are compiled once per case into generated JavaScript closures, with includes inlined when the include graph is acyclic (an interpreter fallback covers cyclic includes).
- Markdown is rendered in a single pass over the body's lines, with inline constructs scanned natively and plain runs flushed through one escape pass.
- Slugs and link resolutions are memoised per case, with a pure-ASCII fast path for slugification.
- The driver runs with V8's incremental marking off and TurboFan optimisation off: on a single pass per case, compiler-thread CPU costs more than optimisation saves.

## Run it

```sh
node main.ts
```

Reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each with `run()` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>

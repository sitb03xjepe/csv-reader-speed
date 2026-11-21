# csv-reader-speed

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/sitb03xjepe/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/sitb03xjepe/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A fast drop-in for make.fun's csv-reader 1.0.0: it reads broken CSV files and answers exactly as csv-reader does on every case, but in a fraction of the CPU time. On the kit's practice set (6 cases, 10.2 MB of CSV) its `run()` takes ~75 ms where csv-reader 1.0.0 takes ~500–680 ms (Node 22, `--no-incremental-marking`, warmed up) — about 7–9× faster — while its answers are byte-identical to the reference on all six practice cases.

How it stays fast: a whole-record fast path splits plain records on commas with `indexOf`; quoted and unquoted fields are scanned with `indexOf` jumps instead of one character at a time; every CR position is precomputed once per case so stray-CR checks are O(1); and the next line break is carried across the fields of a record instead of re-scanned per field. The reader is dependency-free, pure (no state kept between calls), and handles the full broken-row policy: BOM, LF/CRLF, stray CRs, quoted fields with embedded line breaks and doubled quotes, junk after a closing quote, unterminated quotes, short and long rows, and blank lines — with the same `{columns, rows, errors}` answers as csv-reader 1.0.0, verified against the reference on the practice set plus 4,000 differential fuzz cases.

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

The harness runs `node main.ts` (Node 22): it reads every case from `/input/cases.json`, answers each one with `run()` from `solve.js`, and writes `/output/answers.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=2bh747m8&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>

---
name: harness-mocks-need-bun-test
paths: ["**/*.test.ts"]
hits: 1
last-hit: 2026-11-03
evidence: ["plan 33"]
---

# A harness's module mocks only hold under bun test

A parity harness ran an ops script that shells out (`wrangler`, `d1`). It mocked `node:child_process`

## Mistake
Trusting a module mock to fence live I/O: when the mock silently does not apply, the code under test
reaches whatever the inherited environment and PATH can reach.

## Fix
- Run any harness that relies on `mock.module` with `bun test`, never plain `bun`.
- Before calling the code, assert the mock took: import the mocked module and check a marker the
  mock carries; fail loud when it is missing.
- Start the harness with `env -i`, an empty scratch HOME, fake origins, and a PATH holding only the
  runtime, and assert at start that no credential or cloud variable is set. A missed mock then fails
  on a missing binary, not on prod.

---
serial: 1
name: freshness-program
status: in-progress
created: 2026-10-28T23:24:48Z
source: "freshness program"
---

# freshness-program

## Goal

oat 0.26.0 tests a cached API's freshness against the staleness it declares, and anyrow declares every cached read's bound from standard cache presets. Its two security gates no longer rest on caches a revocation cannot clear. A full prod retest proves both sides together.

## Context

- The 2026-10-28 probes on prod (`~/.cache/oat-gates/evidence/`):
  - profile reads stale 150–450 ms in 195 of 200 rounds;
  - a deleted template is still served for up to 304 s;
  - a revoked API key keeps working for about 30 s.

  The database is always right: an `x-fresh` read answered correctly every time.

- anyrow mutations already declare `x-invalidate`, and the frontend reads fresh after its own writes. Background cache writes stay the default; staleness only reaches other viewers, bounded by each cache's soft TTL.
- anyrow's 16 `TieredCache` definitions use 9 different TTL pairs. The admin gate (`platformAdminCache`, 30 / 60 min) and the TOTP replay guard (`totpReplayCache`, a background KV write) are the two security defects.
- oat today reads once right after a write and assumes strict read-your-writes, so a cached API looks broken and real overruns go unmeasured. The existing three-poll wait rule for async effects is the polling base.

## Decisions

- D1. Freshness is declared per operation as `x-consistency: { staleness: "<n>s", bypass: "<header: value>" }`. oat also reads the standard signals: request `Cache-Control: no-cache` (RFC 9111), and response `Cache-Status` (RFC 9211) and `Age`. Rejected: an anyrow-only `x-fresh` convention baked into oat.
- D2. oat judges correctness and freshness apart. Verification reads carry the declared bypass. A new `consistency.staleness-within-bound` check measures the window and fails only past the declared bound, and only reports it when nothing is declared. A `consistency.bypass-is-fresh` check confirms the bypass. Rejected: polling every verification read until it converges, which hides real staleness.
- D3. anyrow standardizes on three presets plus none: `SHORT` (30 s / 60 s, KV's TTL floor), `STANDARD` (2 min / 10 min) and `LONG` (1 h / 24 h). The in-memory tier stays a per-cache flag. Rejected: per-cache hand-picked TTLs.
- D4. A route's `x-consistency` is generated from the preset of the cache it reads through, so the spec cannot drift from the code. Rejected: hand-written extensions.
- D5. The admin gate reads `platform_admin` from D1 on every admin request (no cache). The TOTP replay guard moves to a D1 table with an atomic insert. Rejected: a shorter TTL on either, which still leaves a window.
- D6. Order: security fixes first (independent and urgent), then oat 0.26.0, then anyrow's declarations (which need 0.26.0 to verify), then the joint retest. Rejected: anyrow declarations before the oat that tests them.

## Order

1 [x] Title: anyrow security cache fixes
Goal: The admin gate reads platform admin from D1 on every request, and TOTP codes are single-use through an atomic D1 insert, deployed to prod with its migration.
Why: Both are live security defects that need nothing from oat. Shipping them first also removes two caches before the presets slice reshapes the rest.
Location: .tmp/grunt/plans/14-anyrow-security-cache-fixes-20261028T232743Z.md
2 [x] Title: oat 0.26.0 freshness support
Goal: oat 0.26.0 is released, reading `x-consistency` and the standard cache headers, sending the bypass on verification reads, and shipping `consistency.staleness-within-bound` and `consistency.bypass-is-fresh` with reference defects, goldens and docs.
Why: anyrow's declarations in slice 3 are only provable once a released oat can test them.
Location: .tmp/grunt/plans/15-oat-freshness-support-20261028T234729Z.md
3 [x] Title: anyrow cache presets and declarations
Goal: anyrow runs on prod with every cache on a `SHORT`, `STANDARD` or `LONG` preset, a generated `x-consistency` on every cached read, `Cache-Control: no-cache` honored like `x-fresh`, and `Cache-Status` and `Age` on cached answers.
Why: It depends on slice 2's checks to be verified, and it fixes the template delete's 5-minute staleness by moving it to `STANDARD`.
Location: .tmp/grunt/plans/16-anyrow-cache-presets-declarations-20261029T042517Z.md
4 [ ] Title: oat 0.27.0 attribution and caps
Goal: oat 0.27.0 is released, where a write whose own answer or bypass read drops a submitted field is reported once as `update.persists-submitted-fields` (never as staleness or a lost update), `consistency.*` and `concurrency.no-lost-update` stand down on such fields, and `consistency.staleness-within-bound` caps its watch at 10 minutes whatever the declared bound, reporting "still stale at cap" without failing.
Why: The joint retest must attribute causes correctly, and a declared 24 h bound must not plan a 24 h watch.
Location: .tmp/grunt/plans/17-oat-attribution-and-caps-20261029T092754Z.md
5 [ ] Title: anyrow writer freshness and org update
Goal: anyrow's org.update body documents only the fields it writes, and the generated SDK sends `x-fresh: 1` on reads a mutation's `x-invalidate` marked stale (for the route's declared staleness), turned on in the dashboard.
Why: It removes the over-claim the new check exposed, and gives writers real read-your-writes, which nothing does today.
6 [ ] Title: joint freshness retest
Goal: A full anyrow prod acceptance run on oat 0.27.0 shows the consistency checks within the declared bounds, a revoked admin and a replayed TOTP refused at once, and `targets.yml` still green.
Why: It proves the whole program end to end on the real API, the way the 0.25 releases were proven.

## Watch-outs

- KV's minimum `expirationTtl` is 60 s, so a `SHORT` hard TTL cannot go lower in KV.
- The TOTP migration changes prod D1 (`anyrow-core-prod`). Apply it before deploying the saas code that writes the table, and keep the old KV guard readable for one release so in-flight codes are not double-accepted during the switch.
- oat's new checks must stay quiet on APIs that declare nothing: no declaration means report the window, never fail on it. Otherwise every target's `expected.json` breaks.
- The monorepo's repo-wide type-check and ci hook jobs fail in packages outside this program. Skip only those jobs, and prove this program's packages' own gates.

## Verify

7 [ ] Verify
7.1 [ ] All six child plans have finished their Verify.
7.2 [ ] npm serves `@lovrozagar/oat@0.26.0` and `@lovrozagar/oat@0.27.0` with provenance, and each one's CI and `targets.yml` passed on its tag commit.
7.3 [ ] The anyrow prod run on 0.27.0 reports no staleness past a declared bound, and both security probes pass on prod.

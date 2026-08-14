# oat — working notes for whoever picks this up

Orientation for continuing development. [README.md](./README.md) is for users of the tool;
[DESIGN.md](./DESIGN.md) is the architecture; [ROADMAP.md](./ROADMAP.md) is what to build next;
this file is what you need to *change* it safely.

**State**: 55 checks · 56 defects · 5 API shapes · 4 storage engines. Everything green, no known
flakes. Uncommitted — the working tree is the state.

`lab/` is the hand-written articles API (SQLite or D1). `labs/` is the
family of real backends: **D1 only**, provisioned on Cloudflare, served
locally against that D1, then deployed as Workers. Secrets stay in `.env`.

---

## Run this first

```bash
npm run build
bash tools/verify.sh             # ~15 min, the standard gate
```

Expect seven passes green plus the parser/example/tag-unlock suites. If anything is red, fix it
before writing new code — a red baseline makes every subsequent result unreadable.

`tools/` is tracked and is where the development harness lives. `.oatlogs/` is gitignored scratch
for *logs* — **do not put logs in `/tmp`**, a session restart clears it and takes your results with
it.

| | |
| --- | --- |
| `tools/verify.sh` | the standard gate. Keeps every diagnostic line — use it instead of your own grep |
| `tools/sweep.sh` | fuzz + precision across all backends and dialects, ~40 min, build-fingerprint guarded |
| `tools/bisect.mjs` | **reach for this first when a fuzz case fails** |
| `tools/probe.mjs` | run one defect set, print fired / suppressed / inconclusive |

### The bisector

```bash
node --experimental-sqlite tools/bisect.mjs TENANT_LEAK_VIA_FILTER
```

Pairs the named defect with every other defect in turn and prints which ones stop its check from
firing, and crucially *how*:

```
FILTER_AFTER_PAGINATION      -> SILENT       ← a bug: the check gave up without saying so
STALE_LIST                   -> suppressed   ← fine: a dependency failed first
```

**`SILENT` is the bug, `suppressed` is correct behaviour.** This found three of the four bugs in
the last session in one pass each, where reading sweep logs had cost an hour. A clean run prints
only `done`.

---

## The three ideas the whole thing rests on

**1. A property that needs no ground truth.** oat does not know what your data should be, so
every check asserts something self-evident: a filter and its negation must partition the set; a
page walk must cover the collection without gaps; ordering must reorder without changing
membership; a record read four ways must read the same. These hold on any correct backend and
break on a wrong one, without oat knowing a single expected value.

**2. Roles, not names.** A document says `per_page`, `starting_after`, `fields[article]`. oat
resolves each to a *role* (page size, cursor, projection) by alias plus schema shape, then writes
values in whatever grammar the document demonstrates. Checks are written once against roles.

**3. Silence is the enemy.** Every outcome is stated: a finding, *did not apply* (with what it
needed), *blocked by an earlier failure* (with the cause), or *could not conclude* (with why).
None of the last three is a pass, and a report showing only findings invites a reader to assume
everything else was verified.

---

## The bug this codebase keeps having

Read this before adding a check. It has appeared **six times** in six places:

> **A check that cannot express a request is indistinguishable from a backend that ignores one.**

- `q()` could not write a page as a row offset → offset-paged APIs got no position parameter.
- Two pagination checks gated on a `page` parameter → skipped silently on offset APIs.
- Sort/select values were hardcoded to one grammar while every parameter *name* was derived.
- The alias matcher did not strip `[...]` → `fields[table]` never resolved to the select role.
- Nine filter checks gated on a `filter` *parameter* → all silent against per-field equality APIs.
- Filter checks treat 4xx as "capability statement" → an *overclaiming document* went unreported.

Every instance was silent, and every one would have been reported as the user's bug.

**Two guards now catch the class**, so you should not need a seventh dialect to find it:

- **`COVERAGE_FLOOR`** in `conformance/suite.ts` — each shape declares how many checks it supports.
  Fall below it and the suite fails *and names the checks that stopped applying*. Verified by
  deliberately reintroducing the bug.
- **`TAG_UNLOCKS`** in `report/console.ts` — `doctor` claims each tag unlocks specific checks;
  conformance runs the fixture tagged and untagged and asserts the diff matches exactly.

If you add a check, **raise the floors** (measure, don't guess):

```bash
for d in postgrest classic linked jsonapi plain; do
  node --experimental-sqlite dist/cli.js conformance --backend memory --dialect $d 2>&1 \
    | grep "baseline (correct backend)"
done
```

---

## How to add a check

1. Write it in `runtime/checks.ts`. Register it in the `CHECKS` array — **order matters**, cascade
   suppression consults findings from checks that already ran.
2. Add a defect in `reference/defects.ts` that makes it fire, implement it in `reference/http.ts`
   (behaviour above storage) or the stores (engine-level).
3. Map defect → check in `EXPECTED` (`conformance/suite.ts`). List legitimate *consequences* as
   additional entries; a defect that breaks several properties should not read as false positives.
4. Declare `dependsOn` for anything whose failure makes your result meaningless.
5. `bash tools/verify.sh`, then raise `COVERAGE_FLOOR`. Then `tools/bisect.mjs` your new
   defect — the matrix cannot find a missing `dependsOn`, only the bisector and the sweep can.

**`applicable` must ask what the check needs, not what the fixture happens to have.** Not "is
there a `filter` parameter" but "can an equality predicate be expressed here" (`filterable(ctx)`).
Not "is there a `page` parameter" but "can this be walked forward" (`pageable(ctx)`).

**Never `return` silently.** Use `ctx.findings.unresolved(id, entity, reason)` — it is the
difference between "tested and fine" and "gave up without saying so".

---

## Traps that have cost real time

**Rebuilding during a sweep.** A sweep is ~40 min of separate node processes; rebuilding splits
results across two builds. Cost three debugging rounds before `sweep.sh` grew a fingerprint guard
that prints `### INVALID`. Same for `verify.sh` — let it finish.

**A long `oat run` is silent on stdout until the end.** Live status is on stderr and in
`<out>/progress.log` + `progress.json` (entity, check, last request, age). If those
files stop updating, it is stuck. `--quiet` keeps the files and drops stderr.

**Filtering your own output.** `grep -E "recall|precision|✗"` drops the indented `spurious:` and
`missed` lines that name the cause. This hid a diagnosis four times. Use `tools/verify.sh`.

**Comparing against seed-time values.** Backends normalise (trim, case-fold, round). Anchor on
what the API returns *now*, not what oat submitted.

**Comparing server-generated fields.** A counter that advances, a value derived from another
entity — entities are tested *concurrently*, so a derived field moves mid-check. Read
`x-generated` from **both** create and update: documents commonly declare it only on create, and
reading one operation caused a 1-in-1350 flake that was really a deterministic bug.

**Trusting `hasMore` to decide a record is missing.** `list.read-after-write` used to treat
`hasMore: false` as "that was the whole collection". Combined with `HASMORE_ALWAYS_FALSE` or
an unstable default order on a collection larger than one page (the `row` entity, `maxLimit` 5),
a record on page two looked like a lost write. Walk by short page, never by the flag — the same
rule `isComplete` already follows. Do not pin an `order` to work around this: `STALE_LIST` only
freezes the default listing, and a sorted walk takes a live path that hides the defect.

**Comparing two page walks without pinning the order.** A set gathered by paging is only
well-defined if the pages come from a stable sequence. Left to the backend's default order — which
may have no total order at all — two walks over the same collection legitimately differ, and the
difference reads as a filter dropping records. Pass an explicit order to `collectSet` whenever two
walks are compared.

**Comparing single pages.** Any set-algebra property must gather across pages (`collectSet`),
or it compares two windows of one set and reports paging as a defect.

**Fixture data shape is load-bearing.** A cohort where every value is unique cannot express "a
filter selecting a proper subset", so checks needing one stand down. Real collections always have
a repeated dimension.

**A fix can create a new dependency — re-bisect after fixing.** The sharpest example: a spurious
finding was traced to two page walks being compared without a pinned order, so both walks were
given an explicit sort. Correct fix, and it immediately made the check blind to
`FILTER_DROPPED_WHEN_SORTED` — a backend that stops filtering once a sort is present now served
the unfiltered set to *both* sides, so nothing was ever missing and the check went silent. Run the
bisector again on the check you just changed.

**Interactions are where the bugs are.** `verify.sh` runs each defect *alone*; the fuzzer runs
them in sets, and that is what catches missing `dependsOn` edges. Three examples found this way:
an overclaimed-filter check needs `filter.unknown-field-rejected` (a backend that silently drops
unknown filters never *rejects* one, so the document looks honest); a tenant-scoping probe filters,
so a paging-before-filtering defect hides the leak it looks for. **Always run a sweep after adding
a check** — the matrix alone will not find these.

**Postgres flakes under sustained sweep load — harness, not oat.** Each fuzz case provisions and
drops its own scratch database, so a 150-case Postgres config creates 150 of them back to back.
That occasionally produces a `world.seed` BLOCKED finding, which the fuzzer counts as spurious.
It does not reproduce: 0/25 in isolation, and the defect matrix passes Postgres cleanly every
run. Treat a Postgres-only failure on a *single-defect* case as suspect and re-run it in
isolation before chasing it — a real check bug will reproduce.

**Sweeps die on session restart.** ~40 minutes across separate node processes. Per-config lines
are written as they complete, so a partial log is still usable; the fuzz phase runs first and is
the part that finds bugs. If you need a definitive answer on one config, run it alone.

**Static `node:sqlite` imports.** Kill any process started without `--experimental-sqlite`. Every
store is dynamically imported for this reason. Twice now.

---

## Layout

| path | |
| --- | --- |
| `spec/` | load, dereference, model the document. `conventions.ts` is the role/grammar resolver |
| `runtime/` | `checks.ts` (all 55), `run.ts` (orchestration, suppression, teardown ledger) |
| `reference/` | the fixture backend — HTTP layer + 4 stores + 5 dialects + 56 defects |
| `conformance/` | `suite.ts` (matrix, floors, expectations), `fuzz.ts` (combinations, precision) |
| `report/` | `console.ts` (plan/doctor), `render.ts` (markdown/JSON/repros) |

The reference backend **does ship** — `oat serve` and `oat conformance` are user-facing commands
and need it. What does not ship is a database: the SQL drivers are devDependencies, every store is
dynamically imported, and a user who never passes `--backend postgres` never loads one. oat's
testing path itself never touches a database; runtime deps are `ajv`, `ajv-formats`, `yaml`.

---

## Verification layers

| | what it proves |
| --- | --- |
| defect matrix | each defect alone → exactly the right check, nothing else |
| `--fuzz` | random defect *sets* (to 20 at once) → still one root cause per finding |
| `--precision` | correct backend, randomised cohort data → any finding is a false positive |
| dialects ×5 | checks read the document, not the fixture's habits |
| backends ×4 | engines disagree on NULL ordering, collation, type discipline — that is the point |
| parser suite | 11 hostile documents; never throw, never hang |
| example suite | `examples/annotated-openapi.yaml` resolves as its comments claim |
| tag-unlock suite | `doctor`'s coverage claims are true |

D1 is opt-in (`--backend d1`, needs `CLOUDFLARE_*` env), remote, ~2 min per defect. It runs the
engine-sensitive defects only. **It earns its place**: D1 leaves SQLite's double-quoted-string
fallback ON where `node:sqlite` compiles it off, so a DDL/read column mismatch *errors locally and
silently returns the column name as data in production* — and worse, returns it as the object
*key*, quotes included, corrupting the response shape.

---

## Where to go next

The queue lives in [ROADMAP.md](./ROADMAP.md). Do not add query-matrix cells from here.

D1 + real comment routes already forced two oat-visible bugs (lost-update
on full-row PATCH, cursor advertised but ignored) and one planted one
(`LAB_BUG=stale-comments` → `invalidation.declared-route-changes`).
Iterate there, not on fixtures, when a check looks too quiet.

---

## Things I would not change without good reason

- **Verdicts are graded by what the document states.** A cross-tenant read is `SECURITY` when
  `x-tenant` declares the boundary and `AMBIGUITY` when oat merely inferred it. Claiming the worse
  one on a guess erodes trust in every other finding.
- **A rejected filter is a capability statement, not a defect** — *unless* the document declared
  the field. That distinction is what keeps oat quiet against APIs that deliberately do not index
  everything.
- **Latency is reported, never asserted.** There is no baseline to judge "too slow" against, and
  an invented threshold produces findings nobody can act on.
- **Teardown wraps the client** rather than trusting each check to register what it creates. A
  check that forgets leaks records into a real backend; oat did exactly that, reporting "22/22
  cleaned" while a record survived.

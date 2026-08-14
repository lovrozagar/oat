# oat

OpenAPI Tester — deep behavioural testing of a running backend against its OpenAPI specification.

Schema validators answer *"did this response match its declared shape?"* Most real API bugs don't violate a schema:

- a resource exists in `GET /tables/{id}` but not in `GET /tables`
- `?filter=status.eq.nope` returns every row, because the backend silently dropped the param
- paging at `limit=2` yields 9 rows; `limit=100` yields 10 — the sort has no total order
- `PATCH {name}` also cleared `instruction`
- `?filter=id.eq.<another tenant's id>` returns the row

oat finds these by asserting the same fact through every projection the API offers, then comparing the projections against each other and against a shadow oracle of expected state.

## See it work

oat ships a demo API — the same reference backend its own self-test runs against — so it can be
tried before being wired to anything real:

```bash
oat serve --defects STALE_LIST,PATCH_REPLACES      # terminal 1, prints a url
oat run --config labs/local.config.ts --base-url <that url>
```

```
  25 checks · 3 entities · 164 requests · 0.2s

  BACKEND DEFECTS (5)
    table            list projection does not reflect a completed write
    table            PATCH changed fields the request did not mention

  cleaned up 22/22 created record(s)
  report: oat-out/oat-report.md
```

`oat-out/` holds the markdown report, a JSON copy for CI, and one runnable `curl` script per
finding. Drop `--defects` and it reports nothing across 55 checks.

See [labs/](./labs) for backends, typed configs, and a run against a live API.

## Install

```bash
npm i -D oat
```

## Use

```bash
oat doctor --spec https://api.example.com/openapi.json     # what oat can test, and what's missing
oat plan   --spec https://api.example.com/openapi.json     # the derived model, offline
oat run    --spec ... --base-url https://api.example.com   # execute
```

`oat doctor` is where adoption starts. It runs offline against the spec alone and reports every gap in coverage, naming the meta tag that would close it.

## Two inputs, always

The spec, and a config file. oat never reads your source, assumes your framework, or hardcodes a route. Backend-specific knowledge lives in one of two places:

- **`x-*` meta tags in your spec** — a complete worked document is
  [`labs/annotated-openapi.yaml`](./labs/annotated-openapi.yaml); reference is
  [EXTENSIONS.md](./EXTENSIONS.md). All optional; each degrades to a heuristic and reports the degradation rather than guessing silently.
- **`oat.config.ts`** — auth flow, roots, and the one hook oat cannot infer: resolving values delivered outside HTTP (verification tokens, OTPs).

A backend adopts oat by adding tags, not by adapting to oat.

## How it is measured

oat ships **four** reference backends — in memory, over SQLite, over a real Postgres server, and
over a remote Cloudflare D1 — behind the same HTTP surface, the same generated OpenAPI document
and the same defect names. Each is correct by construction and can be told to exhibit any of 56
named defects, one at a time. `oat conformance` runs the tool against every defect on every
available backend, asserts it reaches the right diagnosis, and — against a correct backend —
reports nothing at all.

They are served in **five dialects**:

| | `postgrest` | `classic` | `linked` | `jsonapi` |
| --- | --- | --- | --- | --- |
| page size | `limit` | `per_page` | `limit` | `size` |
| position | `cursor` + `page` | `page` | **`offset`** | `page` |
| response | `{ tables: [] }` | `{ data: [] }` | **bare array** | `{ data: [] }` |
| total | `count` | `total_count` | **none** | `total` |
| more pages? | `hasMore` | `has_more` | **`Link: rel="next"`** | `has_more` |
| filter | `field.op.value` | `field=op:value` | `field.op.value` | `field.op.value` |
| sort | `field.asc` | `field.asc` | `field.asc` | **`-field`** |
| project | `select=id,name` | `fields=id,name` | `fields=id,name` | **`fields[table]=id,name`** |

…plus **`plain`**: no filter expression language at all, just `?status=active&page=2` — one query
parameter per field, equality only. It is the most common shape in the world and the one where oat
can say the least, which makes it the real test of whether *"I cannot express this"* is reported
honestly or skipped silently.

Each isolates a different axis. `classic` renames every parameter. `linked` changes the
pagination *model* — bare array, row offsets, facts in a header. `jsonapi` renames almost nothing
and instead writes its *values* differently. `plain` removes an entire capability.

The checks are identical across all five. One that works on one and not another was reading a
convention rather than the contract.

```
11/11 hostile specs handled
── memory   · postgrest ──  recall 54/54 · precision clean
── sqlite   · postgrest ──  recall 58/58 · precision clean
── memory   · classic   ──  recall 53/53 · precision clean
── memory   · linked    ──  recall 51/51 · precision clean
── memory   · jsonapi   ──  recall 53/53 · precision clean
── memory   · plain     ──  recall 46/46 · precision clean
── combinations         ──  40/40 diagnosed correctly
```

Postgres is part of the same matrix when a server is reachable; a silent skip is a harness
problem, not a clean result. D1 stays opt-in.

Every dialect added so far has immediately found a place where oat had generalised one layer and
not the next:

- **`linked`** — `q()` could not express a page as a row offset, so an offset-paged API received
  no position parameter at all and returned page one every time; and the two central pagination
  checks gated themselves on a `page` parameter existing, so they skipped silently, which reads
  exactly like a clean result.
- **`jsonapi`** — sort and select values were still hardcoded to one grammar each while every
  parameter *name* was derived; and the alias matcher did not recognise `fields[table]` as the
  `fields` role at all, because a bracketed suffix is a value carried in the parameter name rather
  than part of the role's name.
- **`plain`** — nine checks gated themselves on a `filter` *parameter* existing, so every one of
  them skipped silently against an API that filters perfectly well, just per-field. They now ask
  the question they actually mean: can an equality predicate be expressed here at all?

The pattern is the same each time, and it is the one worth guarding against: a check that cannot
express a request looks identical to a backend that ignores it.

### The query matrix

Testing each axis alone is not testing the query surface. Real backends break at the
*combination*: adding a sort changes which index the planner picks and the filter stops being
applied; a cursor is resolved before the filter, so page two leaks rows the predicate excluded; a
count is computed on the unfiltered set the moment an order is present. Every one of those passes
a suite that only ever varies one thing.

| combination | |
| --- | --- |
| each axis alone — filter, sort, select, search, page | ✅ |
| sort + paginate · filter + paginate | ✅ |
| **filter + sort** | ✅ `query.axes-compose` |
| **filter + select** | ✅ `query.filter-and-select-compose` |
| **search + filter** | ✅ `query.search-and-filter-compose` |
| **filter + sort + select** | ✅ `query.filter-sort-select-compose` |
| **filter + search + sort** | ✅ `query.filter-search-sort-compose` |
| **filter + search + select** | ✅ `query.filter-search-select-compose` |

Each pair asserts a compositional property, so it needs no ground truth: a filter alone and the
same filter with a sort or a select must return the same **set**; a filter and a search together
must return the intersection of each axis alone. Ordering reorders a result; a projection changes
columns; neither may change membership. Both sides are gathered across pages, because comparing
two truncated windows of one set reports a difference that is only paging.

The triples catch a planner that has a working two-axis path and a broken three-axis path —
every pair check passes, and the filter vanishes only when both extra axes are present.

The remaining cell is the four-axis request: filter + sort + select + search.

### The bug this tool keeps having

Five dialects in, the same defect has surfaced five times in five different places:

> **A check that cannot express a request looks exactly like a backend that ignores one.**

`q()` could not write a page as a row offset. Two pagination checks gated on a `page` parameter.
Sort and select values were hardcoded to one grammar. The alias matcher did not recognise
`fields[table]`. Nine filter checks gated on a `filter` parameter existing. Every instance was
silent, and every one would have been reported as the user's bug rather than oat's.

Each was found by adding a dialect and noticing the check count drop — which only works while
someone is looking. So the count is now asserted. Each shape declares how many checks it is known
to support, and a run that falls below it fails and **names the checks that stopped applying**:

```
✗ baseline (correct backend) VACUOUS  0  31 checks
    only 31 check(s) ran, below the 38 this shape supports —
    a check that stopped applying reads exactly like a clean result
    did not run: filter.unknown-field-rejected, filter.equality-selects-exactly-one,
                 filter.zero-match-returns-none, count.matches-filtered-set, …
```

That output is from deliberately reintroducing the `plain` bug to confirm the guard catches it.
The class is now detectable without waiting for a sixth dialect to expose it.

Where a shape genuinely cannot exhibit a defect — no cursor to drift, no total to miscount, no
filter expression to malform — that defect is excluded by name rather than excused after the fact,
so a check that merely failed to fire still counts as a miss.

The same reasoning cuts the other way, and `plain` is where it bites. Under one-parameter-per-field
filtering an unrecognised query parameter being ignored is *conventional HTTP*, not a dropped
predicate — so the check that asserts "a filter naming an unknown field must be rejected" does not
apply there, and says so. Reporting it would fire against a large share of real APIs, which is how
a tool earns a reputation for crying wolf.

### Criss-cross: one fact, every projection

A record's field value is not a thing sitting in a database. It is whatever each read path says
it is — the item route, the collection, a sparse fieldset, a sorted page, a filter's membership
decision. A system is consistent only if they all say the same thing.

Every other check judges one projection against an expectation: does `filter` narrow, does
`select` project, does the detail route serve what was written. All of them can pass while the
projections contradict *each other* — the item route says `"active"`, the listing says
`"pending"`, and each is individually defensible. A denormalised listing, a search index rebuilt
on a lag, a cached projection: nobody notices until a client's view of a record depends on which
route it happened to use.

So oat traces a single field of a single record through every projection that can express it and
requires them to agree, then checks that a filter matching that value actually returns the record.
It cannot say which projection is wrong — only that at least one is, which is the honest claim.
The report names each projection and what it returned, so the odd one out is visible at a glance.

The reference value is the item route read *now*, not the value oat submitted: a backend is
entitled to normalise what it stores, and holding every projection to the submitted value would
report normalisation as inconsistency. Server-generated fields are excluded for the same reason —
a progress counter or a derived count can legitimately move between two reads, and comparing those
across projections measures timing rather than consistency.

### Three properties a single request cannot reveal

Most checks read one response and judge it. Two of the newest cannot work that way, and they are
the ones that catch the quietest bugs.

**Denials must not disclose existence.** Refusing a cross-tenant read is correct. Refusing it with
a *different status* than an id that was never issued turns the item route into an oracle: walk
the identifier space, read existence off the status code, and learn which of another tenant's ids
are live without ever being served a body. The access decision looks right in every log. oat asks
for a real record and an absent one and compares — whichever status the backend picks is fine,
picking two different ones is not.

**Idempotency keys must actually be honoured.** An API that publishes an `Idempotency-Key` header
has promised replay safety, and clients rely on it to make retries safe. If the key is accepted
and ignored, every timeout, proxy replay and double-click silently duplicates a charge or an
order. Nothing in a single response reveals this — the request has to be replayed, and both halves
checked: the replay must return the *original* record, and the collection must not have grown.

**`x-invalidate` must be true.** This is the tag oat derives the whole entity graph from — it
inverts every mutator's declared read routes into that entity's read surface — and until recently
it was *believed* rather than tested. The interesting case is cross-entity: creating a child
changes what the *parent* route serves, through a denormalised counter or a cached projection.
Those go wrong quietly. The write succeeds, the child's own listing is correct, and only the other
route the document named is stale. oat snapshots each declared foreign route, performs the write,
and re-reads: a byte-identical body means either the derived value is stale or the declaration is
wrong — and every client following it is invalidating the wrong cache key.

None of the three needs a new meta tag. The idempotency header is read straight from the document,
because an API that promises replay safety publishes the header, and the promise is what makes the
property testable.

### Combinations, not one bug at a time

A backend with one defect is a fixture. Real ones carry several at once, and that is where a
testing tool quietly stops being useful: a broken listing makes every downstream check report a
consequence, and thirty findings with one root cause is nearly as useless as none.

`oat conformance --fuzz` injects random *sets* of defects and asserts a stricter property than
recall. Each injected defect must produce its own diagnosis — or be accounted for, either because
a check it depends on was itself broken (cascade suppression working) or because the check ran and
reported *why* it could not conclude. A check that simply goes quiet is a failure, because silence
is indistinguishable from a pass.

```
oat conformance --fuzz 300 --max-defects 12 --backend sqlite
300/300 combinations diagnosed correctly · 393 suppressed as cascades
```

Everything it found was invisible to the one-at-a-time matrix:

| found | why it mattered |
| --- | --- |
| 136 silent early returns | a check that gave up mid-run reported nothing, reading exactly like a pass |
| suppression was not transitive | if A was suppressed by B, a check depending on A ran anyway and re-reported B under its own name |
| suppressed checks were dropped | a suppressed check has not *passed*, but the report implied it had |
| `isComplete` trusted `hasMore` | a backend miscounting its total silently disabled every set-algebra check |
| a probe wrote into an enum field | the backend rightly rejected it, and the rejection was read back as a lost update |
| a check moved a record out of its tenant | it poisoned the shared cohort, 404-ing every check that ran after it |

### Precision under varied data

The fuzzer varies the *faults*. A second mode varies the *data*, against a backend with nothing
wrong with it — so any finding at all is a false positive by construction:

```
oat conformance --precision 60
60/60 cohorts produced no false positives
```

Every check builds its cohort from a seed: empty strings, LIKE metacharacters, unicode, nulls,
lexical extremes. The suite had only ever used seed 42, and a property that holds at 42 but fails
at 43 was never a property of the contract — it was a property of that one fixture.

Findings that survive now carry three outcomes the report states separately — **blocked by an
earlier failure**, **could not conclude**, and **did not apply** — because none of them is a pass,
and a report showing only defects invites the reader to assume everything else was verified.

oat's testing path never touches a database — it parses a specification and makes HTTP requests, and its
runtime dependencies are `ajv`, `ajv-formats` and `yaml`. The reference backend ships because
`oat serve` and `oat conformance` use it, but the SQL drivers are devDependencies and every store
is loaded on demand — running against your own API pulls in none of them.

Several of them, because the engines disagree in exactly the places an API contract is ambiguous —
which makes them a differential oracle rather than copies of one test:

| | SQLite | Postgres | D1 |
| --- | --- | --- | --- |
| `ORDER BY x ASC` nulls | first | **last** | first |
| type discipline | loose — stores anything | **strict** — rejects it | loose |
| collation | binary | **locale-aware** | binary |
| `like` vs `ilike` | indistinguishable for ASCII | **genuinely different** | indistinguishable |
| `SELECT "no_such_col"` | **error** | error | **returns `"no_such_col"` as data** |
| latency per statement | none | none | **~290 ms, over the network** |

That last pair is not a curiosity. SQLite's double-quoted-string fallback is compiled *off* in
`node:sqlite` and *on* in D1, so a DDL/read naming mismatch that fails loudly in local development
returns the column name as every row's value in production — verified against a live D1, not
assumed:

```
node:sqlite   SELECT "no_such_col" →  ERROR: no such column
D1            SELECT "no_such_col" →  [{ "v": "no_such_col" }]
```

It is worse than a wrong value. D1 returns the *unresolved identifier as the key*, quote
characters and all, so a row selected with a mistyped column name comes back as:

```json
{ "id": "r1", "\"name\"": "name", "slug": "s1" }
```

The declared property is missing and an undeclared one has appeared — the response **shape** is
corrupted, not just its contents. Every generated client breaks, and the schema check catches it
as a second, independent symptom. None of this is reachable on an engine that compiles the
fallback off, which is the entire argument for testing against a real remote engine rather than a
local stand-in.

A check that passes in memory but fails against SQL was relying on JavaScript semantics, not on
the contract. Adding the SQL backend immediately exposed seven "passing" defects that had never
actually reproduced the bug they named.

Each backend is optional and skipped with a stated reason rather than silently passing: SQLite
needs `node:sqlite` (`npm run conformance` passes the flag), Postgres needs a reachable server.
Every Postgres run provisions its own scratch database and drops it on close.

D1 is opt-in and never runs by default — it is remote, so every statement is a network round trip
and a pass costs minutes. It runs the engine-sensitive defects only, since the rest are decided in
the request handler where a remote engine re-derives an answer SQLite already gave for free:

```bash
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_D1_DATABASE_ID=... CLOUDFLARE_API_TOKEN=...
oat conformance --backend d1
```

Tables are prefixed per run and dropped on close, so concurrent runs can share one database.

## What this is not

oat is not a fuzzer. Tools like [Schemathesis](https://schemathesis.readthedocs.io/) generate
inputs from your schema and check the responses validate against it — that finds crashes, 500s
and schema drift, it is genuinely good at it, and oat does not replace it. Run both.

The difference is *statefulness*. A fuzzer sends independent requests and has no model of what
the API should now contain, so it cannot ask whether the record it just created appears in the
listing, whether a filter and its negation partition the set, or whether the record another
tenant can read is one they should see. Those need a shadow model, a real login, and more than
one identity — which is where oat's design goes:

| | schema fuzzers | oat |
| --- | --- | --- |
| multi-step auth flow | header injection | declarative chain, JSON-path binding |
| out-of-band token (email link, OTP) | — | `resolveOutOfBand` hook |
| credential self-refresh mid-run | — | JWT `exp` decode, refreshes before expiry |
| expected-state oracle | none by design | shadow model of everything it created |
| N live principals | — | yes (peer tenants + optional rank lattice) |
| cross-tenant read / filter / disclosure | — | 3 checks |
| stateful invariants across a flow | random walk, no oracle | 55 property checks |
| API-shape portability | — | 5 dialects, roles resolved from the document |
| **N-role permission matrix** | — | monotonicity over `rank` |
| **invite / delegated access** | — | `x-invite` timeline |

The last two rows used to be the honest gaps. They are now in the suite — rank
monotonicity and the invite/accept/revoke timeline — and `oat conformance` asserts them.

## Status

Early but real. Working today:

- spec load + dereference (internal `$ref`, cycle-safe; external refs reported, never fetched)
- entity graph derived by inverting `x-invalidate` into per-entity read surfaces
- collection shape and identity derived from response schemas
- world seeding with a discriminating cohort, resolved topologically once per run
- query conventions derived from the document rather than assumed — parameter *roles*
  (`per_page`, `starting_after`, `page_size`) and envelope keys (`total_count`, `has_more`) are
  resolved by alias and schema shape, so checks are not tied to one API's spelling
- every check reaches a stated outcome — a finding, a *did not apply* with what it needed, a
  *blocked by an earlier failure* naming the cause, or a *could not conclude* with the reason.
  None of the last three is a pass, and a report that showed only findings let a reader assume
  everything else had been verified
- 41 checks: read-after-write, cross-projection agreement, filter/sort/search semantics,
  pagination properties, write fidelity, idempotent replay, declared invalidation, input
  validation, schema conformance, tenant isolation and existence disclosure, declared side
  effects, async lifecycles
- set-algebra checks gather their sets across pages, so they hold on collections larger than one
  page rather than standing down on them
- cascade suppression, transitively — one root cause produces one finding, not a page of
  consequences, and a check blocked by a blocked check is blocked too
- declarative multi-step auth with self-refreshing credentials, and an out-of-band hook for
  values that never travel over HTTP
- teardown of everything a run creates, including the principals it provisioned
- markdown / JSON reports plus a runnable `curl` reproducer per finding
- `oat run`, `oat plan`, `oat doctor`, `oat conformance` (`--fuzz`, `--precision`, `--backend`,
  `--dialect`)

Findings are graded by how much the document actually states: a cross-tenant read is a security
finding when `x-tenant` declares the boundary, and an ambiguity when oat only inferred it.

See [DESIGN.md](./DESIGN.md) for the full architecture.

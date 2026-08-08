# oat

OpenAPI Tester — deep behavioural testing of a running backend against its OpenAPI specification.

Schema validators answer *"did this response match its declared shape?"* Most real API bugs don't violate a schema:

- a resource exists in `GET /tables/{id}` but not in `GET /tables`
- `?filter=status.eq.nope` returns every row, because the backend silently dropped the param
- paging at `limit=2` yields 9 rows; `limit=100` yields 10 — the sort has no total order
- `PATCH {name}` also cleared `instruction`
- `?filter=id.eq.<another tenant's id>` returns the row

oat finds these by asserting the same fact through every projection the API offers, then comparing the projections against each other and against a shadow oracle of expected state.

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

- **`x-*` meta tags in your spec** — see [EXTENSIONS.md](./EXTENSIONS.md). All optional; each degrades to a heuristic and reports the degradation rather than guessing silently.
- **`oat.config.ts`** — auth flow, roots, and the one hook oat cannot infer: resolving values delivered outside HTTP (verification tokens, OTPs).

A backend adopts oat by adding tags, not by adapting to oat.

## How it is measured

oat ships a reference backend that is correct by construction and can be told to exhibit any of
32 named defects, one at a time. `oat conformance` runs the tool against each and asserts it
reaches the right diagnosis — and, against the correct backend, reports nothing at all.

```
recall     32/32 injected defects detected
precision  clean baseline — no findings against a correct backend
34/34 cases passed
```

The clean baseline is the harder bar. A tool that cries wolf on a correct backend is worse than
no tool, so precision is asserted twice: once on a fully annotated spec, and once on the same
spec with every meta tag stripped, where oat runs on heuristics alone.

Adding a check means adding a defect that proves it. The suite reports any check it ran but no
defect exercised, so a check can never quietly stop working.

## Status

Early but real. Working today:

- spec load + dereference (internal `$ref`, cycle-safe; external refs reported, never fetched)
- entity graph derived by inverting `x-invalidate` into per-entity read surfaces
- collection shape and identity derived from response schemas
- world seeding with a discriminating cohort, resolved topologically once per run
- 31 checks: read-after-write, filter/sort/search semantics, pagination properties, write
  fidelity, input validation, schema conformance, tenant isolation
- cascade suppression — one root cause produces one finding, not a page of consequences
- `oat plan`, `oat doctor`, `oat conformance`

Next: report rendering with generated `curl` reproducers, async operation support (`x-async`),
and a spec zoo for parser robustness.

See [DESIGN.md](./DESIGN.md) for the full architecture.

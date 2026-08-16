# labs — real backends, always D1

Each world is a Hono API this repo owns. **Storage is Cloudflare D1**, never
local SQLite. Local `serve.ts` talks to D1 over HTTP. After oat is green
locally, `deploy.mjs` puts the same app on a Worker bound to that D1 and oat
runs again against `https://`.

```
node labs/provision.mjs tiny          # create oat-labs-tiny, apply schema
LAB=tiny LAB_PORT=8790 node --experimental-strip-types labs/serve.ts
LAB_URL=http://127.0.0.1:8790 node --experimental-sqlite dist/cli.js run --config labs/oat.config.ts
node labs/deploy.mjs tiny             # Worker + D1 binding
LAB_URL=https://oat-labs-tiny.<subdomain>.workers.dev ...
```

Wipe leftover rows (schema stays) before a clean re-run:

```
node --experimental-strip-types labs/wipe.mjs huge
```

A live `oat run` writes `progress.log` and `progress.json` under `--out`
(entity, check, last request, age). If those stop moving, the run is stuck.
`--quiet` keeps the files and drops stderr.

Or the loop:

```
bash labs/iterate.sh                  # tiny + probe cases on D1
bash labs/iterate.sh new              # planted worlds not in the original eight
bash labs/iterate.sh shop campus
bash labs/probe-cases.sh
```

| world           | entities   | what it is for                                                               |
| --------------- | ---------- | ---------------------------------------------------------------------------- |
| `tiny`          | 1          | one collection, invite, ranks, soft-delete                                   |
| `shop`          | 5          | store → product → review, plus order / customer. Cross-entity `x-invalidate` |
| `campus`        | 10         | nested campus / building / room / booking / course                           |
| `platform`      | 20         | a workspace SaaS. Many parents, many derived counts                          |
| `huge` / `vast` | 200 / 2000 | schema-only unless `LAB_SCALE=1`. Do not oat-run on D1 by default.           |

Credentials: repo-root `.env` (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`).
Provision writes `CLOUDFLARE_D1_<WORLD>=<uuid>` into `.env` and `labs/.d1.json`
(gitignored).

## Correct vs planted bugs

`bash labs/probe-cases.sh` — each case is its own D1.

| world                    | planted                                    | oat must report                            |
| ------------------------ | ------------------------------------------ | ------------------------------------------ |
| `ok-pair` / `ok-classic` | none                                       | nothing                                    |
| `ok-jobs`                | none (async start + artifact effect)       | nothing                                    |
| `bug-stale`              | child write does not bump `product_count`  | `invalidation.declared-route-changes`      |
| `bug-nofilter`           | filter parses, then is dropped             | `filter.equality-selects-exactly-one`      |
| `bug-leak`               | item GET is global by id                   | `tenant.item-not-readable-cross-tenant`    |
| `bug-overclaim`          | `x-query.filterable` lists `ghost`         | `spec.declared-filterable-is-filterable`   |
| `bug-pagefilter`         | page first, then filter the page           | `query.filter-selects-from-whole-set`      |
| `bug-cursor`             | `nextCursor` advertised, ignored           | `pagination.cursor-agrees-with-page`       |
| `bug-lostupdate`         | PATCH writes the whole row                 | `concurrency.no-lost-update`               |
| `bug-invite`             | accept does not grant                      | `auth.invite-grants-then-revokes`          |
| `bug-tombstone`          | soft-deleted row stays in the default list | `softdelete.absent-from-default-list`      |
| `bug-rank`               | viewer can read a record member cannot     | `auth.rank-is-monotonic`                   |
| `bug-filterleak`         | a filter drops the tenant predicate        | `tenant.filter-does-not-bypass-scope`      |
| `bug-hasmore`            | `hasMore` is always false                  | `pagination.has-more-is-accurate`          |
| `bug-maxlimit`           | documented `maxLimit` is not capped        | `pagination.limit-respects-documented-max` |
| `bug-search`             | `q` is accepted and ignored                | `search.q-narrows-result`                  |
| `bug-select`             | sparse fieldset is ignored                 | `select.projection-honoured`               |
| `bug-sort`               | `order` is accepted and ignored            | `sort.order-is-applied`                    |
| `bug-idem`               | `Idempotency-Key` is ignored               | `idempotency.replay-does-not-duplicate`    |
| `bug-immutable`          | `x-immutable` fields accept writes         | `patch.immutable-field-rejected`           |
| `bug-enum`               | enum is not enforced                       | `validation.enum-enforced`                 |
| `bug-maxlen`             | maxLength is not enforced                  | `validation.max-length-enforced`           |
| `bug-required`           | required fields are not enforced           | `validation.required-enforced`             |
| `bug-revoke`             | revoke leaves the grant in place           | `auth.invite-grants-then-revokes`          |
| `bug-offset`             | page/offset is ignored                     | `pagination.page-walk-covers-set`          |
| `bug-oracle`             | 403 vs 404 reveals existence               | `tenant.denial-does-not-reveal-existence`  |
| `bug-like`               | LIKE `%` is treated as a wildcard          | `filter.like-metacharacters-escaped`       |
| `bug-async`              | job start stays `pending` forever          | `async.reaches-terminal-state`             |
| `bug-effect`             | `x-effects` create does not insert         | `effects.declared-effect-occurs`           |
| `bug-oversort`           | `x-query.sortable` lists `ghost`           | `spec.declared-sortable-is-sortable`       |
| `bug-overselect`         | `x-query.selectable` lists `ghost`         | `spec.declared-selectable-is-selectable`   |
| `bug-receipt`            | job start receipt omits `id`               | `async.receipt-identifies-the-job`         |
| `bug-count`              | envelope `count` is always 0               | `count.consistent-with-returned-page`      |
| `bug-widen`              | PATCH also writes `kind`                   | `patch.minimality`                         |
| `bug-unknown`            | unknown filter field is ignored            | `filter.unknown-field-rejected`            |
| `bug-neq`                | `neq` is a no-op                           | `filter.negation-partitions-the-set`       |
| `bug-and`                | `and()` compiles as OR                     | `filter.and-composes-as-intersection`      |
| `bug-or`                 | `or()` compiles as AND                     | `filter.or-composes-as-union`              |
| `bug-numeric`            | numeric `gt` compares as text              | `filter.numeric-comparison-is-numeric`     |
| `bug-limit`              | `limit` does not bound the page            | `pagination.limit-bounds-page-size`        |
| `bug-dropfield`          | create drops submitted `note`              | `create.persists-submitted-fields`         |
| `bug-status`             | create returns 200 not 201                 | `create.status-matches-document`           |
| `bug-del404`             | DELETE of a missing id is 204              | `delete.absent-record-returns-404`         |
| `bug-ctype`              | `text/plain` accepted on JSON create       | `validation.content-type-enforced`         |
| `bug-500`                | malformed filter returns 500               | `error.malformed-filter-not-5xx`           |
| `bug-errschema`          | error body omits `error_key`               | `schema.error-response-matches-document`   |

Invites live in D1 (`invites` table). An in-memory map would die on Worker isolate hops.

Schema is generated, not mocked. `labs/worlds/catalog.ts` is the source;
`labs/kit/schema.ts` turns it into `CREATE TABLE` statements that
`provision.mjs` runs on a real D1. To read the SQL:

```
node --experimental-strip-types labs/dump-schema.mjs   # writes labs/schema/<world>.sql
```

OpenAPI is generated the same way (`kit/spec.ts`) and served at
`/v1/openapi/spec`. There is no local SQLite path.

## Configs and the fixture demo

These also live here — there is no top-level `examples/`.

| file                     | what it is                                |
| ------------------------ | ----------------------------------------- |
| `oat.config.ts`          | principals for a labs world (D1)          |
| `local.config.ts`        | point oat at `oat serve` (the fixture)    |
| `minimal.config.ts`      | smallest useful config, static API key    |
| `oob-auth.config.ts`     | multi-step login against a stranger API   |
| `annotated-openapi.yaml` | every `x-*` tag in one document           |
| `demo.mjs`               | one-process fixture demo (`npm run demo`) |

```
node dist/cli.js serve --defects STALE_LIST,PATCH_REPLACES
node --experimental-strip-types dist/cli.js run --config labs/local.config.ts --base-url http://127.0.0.1:PORT
node dist/cli.js doctor --spec labs/annotated-openapi.yaml
```

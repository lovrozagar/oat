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
bash labs/iterate.sh shop campus
bash labs/probe-cases.sh
```

| world | entities | what it is for |
| --- | --- | --- |
| `tiny` | 1 | one collection, invite, ranks, soft-delete |
| `shop` | 5 | store → product → review, plus order / customer. Cross-entity `x-invalidate` |
| `campus` | 10 | nested campus / building / room / booking / course |
| `platform` | 20 | a workspace SaaS. Many parents, many derived counts |
| `huge` / `vast` | 200 / 2000 | schema-only unless `LAB_SCALE=1`. Do not oat-run on D1 by default. |

Credentials: repo-root `.env` (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`).
Provision writes `CLOUDFLARE_D1_<WORLD>=<uuid>` into `.env` and `labs/.d1.json`
(gitignored).

## Correct vs planted bugs

`bash labs/probe-cases.sh` — each case is its own D1.

| world | planted | oat must report |
| --- | --- | --- |
| `ok-pair` / `ok-classic` | none | nothing |
| `bug-stale` | child write does not bump `product_count` | `invalidation.declared-route-changes` |
| `bug-nofilter` | filter parses, then is dropped | `filter.equality-selects-exactly-one` |
| `bug-leak` | item GET is global by id | `tenant.item-not-readable-cross-tenant` |
| `bug-overclaim` | `x-query.filterable` lists `ghost` | `spec.declared-filterable-is-filterable` |
| `bug-pagefilter` | page first, then filter the page | `query.filter-selects-from-whole-set` |
| `bug-cursor` | `nextCursor` advertised, ignored | `pagination.cursor-agrees-with-page` |
| `bug-lostupdate` | PATCH writes the whole row | `concurrency.no-lost-update` |
| `bug-invite` | accept does not grant | `auth.invite-grants-then-revokes` |

Invites live in D1 (`invites` table). An in-memory map would die on Worker isolate hops.

The original hand-written `lab/` (articles) is still there and can also use D1.
These worlds are the coverage surface.

# oat lab

A backend **this repo owns**: Hono + SQL, OpenAPI we edit by hand, oat config next to both.
Use it to iterate the three sides independently — change the handler, change the document,
change a check — without waiting on anyrow.

```
lab/openapi.yaml     the contract oat reads
lab/app.ts           the handler
lab/store.ts         local SQLite or Cloudflare D1
lab/oat.config.ts    two tenants, token auth (oat side, not the backend)
```

## Run locally (no Cloudflare)

```bash
cd lab && bun install
node --experimental-sqlite --experimental-strip-types index.ts   # http://127.0.0.1:8788
```

In another terminal, from the repo root (after `bun run build`):

```bash
node --experimental-sqlite dist/cli.js doctor --spec http://127.0.0.1:8788/v1/openapi/spec
node --experimental-sqlite dist/cli.js plan   --spec http://127.0.0.1:8788/v1/openapi/spec
node --experimental-sqlite dist/cli.js run    --config lab/oat.config.ts
```

Default store is `lab/.data/lab.sqlite` (gitignored). Wipe it to reset.

## Point it at D1

Credentials live in the repo-root `.env` (gitignored). Copy `.env.example` and fill it.
Then, once, create the database:

```bash
node lab/provision.mjs          # writes CLOUDFLARE_D1_DATABASE_ID into .env
LAB_STORE=d1 node --experimental-sqlite --experimental-strip-types lab/index.ts
```

The same OpenAPI and oat config apply. That is the point: only the driver changes.

```bash
LAB_STORE=d1 LAB_PORT=8789 node --experimental-sqlite --experimental-strip-types lab/index.ts
LAB_URL=http://127.0.0.1:8789 node --experimental-sqlite dist/cli.js run --config lab/oat.config.ts --out oat-out/lab-d1
```

## Auth

| key | org | role |
| --- | --- | --- |
| `key_alpha` | `org_alpha` | owner (CRUD) |
| `key_alpha_member` | `org_alpha` | member (no delete) |
| `key_alpha_viewer` | `org_alpha` | viewer (read only) |
| `key_beta` | `org_beta` | owner |

`POST /v1/auth/token` `{ "key": "key_alpha" }` → `{ access_token, org_id }`.

## What to change when iterating

- **Backend bug** — edit `app.ts` / `query.ts` / `store.ts`, re-run oat.
  `LAB_BUG=stale-comments` skips `recountComments` so article
  `comment_count` goes stale. oat should report
  `invalidation.declared-route-changes` on comment.
- **Spec lie** — add a field to `x-query.filterable` the handler does not accept
  (e.g. `body`), re-run oat; expect `SPEC_BUG` from
  `spec.declared-filterable-is-filterable`. Dropping a field only stands the
  check down. Restore the document afterwards.
- **oat bug** — a finding against this lab that is wrong, or a check that stands down
  when the request is expressible. That is ROADMAP R4.

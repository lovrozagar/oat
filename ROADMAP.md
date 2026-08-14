# oat — roadmap

How the next work is chosen. [HANDOFF.md](./HANDOFF.md) is how to change the code safely;
this file is what to change, and in what order.

**State (2026-08-13):** 55 checks · 56 defects · 5 dialects · 4 engines. Conformance and the
memory/sqlite sweep are green. The query matrix is finished through the filter triples. The
tool has not yet been forced to justify itself against a document it did not generate.

A new check of the same compositional shape is not the next move. The last stretch proved the
matrix pattern; it did not prove oat is useful.

---

## How to pick work

Add a check when a **real document** or a **new dialect** forces it, not because a table has
an empty cell. The four-axis request (`filter+sort+select+search`) stays off the list until
something outside the fixture needs it.

`maxLimit` as a spec-adversary check was tried and reverted: its defect rejected
`limit === maxLimit`, which is the default page-walk size every other check uses. Do not
revive it without a defect that only fires on `limit > maxLimit`.

Postgres in `tools/sweep.sh` is currently silent on this machine (peer auth fails for
`ecomet`). That is a harness hole, not a product feature. Do not treat a green sweep as
Postgres-clean until the configs print a result line.

---

## Tracks

Three tracks, in this order of attention. Authorization waits on the first live run: that
run either confirms N-role is the bet, or shows that “cannot express a request on a real
document” is still the product-limiting bug.

### Track R — Reality

Prove the tool outside the fixture.

- [x] **R1.** Inventory: for each check, what it needs (roles, tags, cohort shape) versus what
      a typical *untagged* OpenAPI document provides. Record the result in
      [docs/check-inventory.md](./docs/check-inventory.md).
- [x] **R2.** `oat doctor` + `oat plan` against at least one document oat did not generate
      (a public spec is enough for this step). Classify every outcome: modelled, skipped,
      gap, surprise. See [docs/live-runs.md](./docs/live-runs.md).
- [x] **R3.** `oat run` against a live API that is not the reference fixture.
      Done against [labs/](./labs/) (Hono + Cloudflare D1). See
      [docs/live-runs.md](./docs/live-runs.md).
- [x] **R4.** Fix the silent skips that R3 produces, if they are oat bugs.
      `x-soft-delete` on the delete operation was ignored; `run.ts` now reads it
      from any operation on the entity. Lab comment list advertised `nextCursor`
      and ignored it — `pagination.cursor-agrees-with-page` on D1; cursor walk
      added. Do not add fixture-only checks to make the report look busier.
- [x] **R5.** Make the local Postgres sweep config fail loudly when the server is
      unreachable or auth fails, instead of printing an empty result line.
      `tools/sweep.sh` now treats empty suite output as `✗ no result` (and exits 1).
      The build fingerprint uses `cksum`, so Linux no longer prints a false
      `### INVALID`.

### Track A — Adoption

Make a stranger succeed. The engine is ahead of the product.

- [x] **A1.** Bring README numbers in line with the suite (checks, defects, recall lines,
      the “37 checks” demo copy). Stale numbers teach the wrong size of the tool.
- [x] **A2.** Run `oat doctor` on the live spec from R2/R3 and rewrite any doctor sentence
      that is false, marketing, or unintelligible without the fixture in mind.
      Doctor now reports *trackable* vs *listable* and does not claim query checks run
      when there is no list (Petstore). `x-tenant` sharpening only appears when a tenant
      parameter was actually inferred.
- [x] **A3.** One worked finding: a short walkthrough from `doctor` → tag → `run` → finding
      → fix, against the demo API. See “From `doctor` to a fix” in
      [labs/README.md](./labs/README.md).
- [x] **A4.** Decide the adoption bar, in writing, in this file:
      **(a)** useful on an untagged CRUD OpenAPI, or **(b)** useful once `x-query` /
      `x-tenant` are present. Those are different products. Do not imply (a) in the README
      while the inventory shows (b).

      **Decision: (b).** An untagged document is in scope for foundations, PATCH/delete,
      and schema checks. The query matrix and sharp tenant verdicts require roles to
      resolve, and they resolve from `x-query` / `x-tenant` or from the same role
      aliases the checks already use (`sort`/`fields`/`q`/`per_page`, not only
      `filter`/`order`/`select`). Petstore — the common untagged shape — has no list
      and is honest only as item-route CRUD. Anyrow is the friendly case and still
      needs tags for spec-adversary and SECURITY vs AMBIGUITY. Do not market (a)
      while an untagged list still probes every scalar.

### Track N — Authorization

The gap that would make oat different from a schema fuzzer. Do not start until R3 has been
read: a live run may reorder this.

- [x] **N1.** Replace hardcoded `altAuth` (the second principal) with a role lattice over
      `principals`. Config grows `role` / `rank`. `run.ts` resolves every principal;
      isolation uses the first *different-tenant* actor, not `principals[1]`. Checks
      see `ctx.actors`. N2 walks that list.
- [x] **N2.** Monotonicity check: each role’s permitted set is a superset of the role below
      it, on the same resource. `auth.rank-is-monotonic` + `ROLE_MONOTONICITY_BROKEN`.
      Lab and fixture now have owner / member / viewer on one tenant.
- [x] **N3.** Invite / delegated access. `x-invite` names invite/accept/revoke.
      Check `auth.invite-grants-then-revokes`: cannot before accept, can after,
      cannot after revoke. Defects `INVITE_NEVER_GRANTS` and `REVOKE_IGNORED`.
      Peer needs `inviteAs`. Lab and fixture both implement the flow.

### Maintenance — only when forced

These stay off the main tracks. Pick one up when a live run, a dialect, or a broken floor
demands it.

- Compound `and(a, or(b,c))` and mixed-direction multi-field sorts.
- Spec-as-adversary for declared enums and declared required fields (same shape as
  sortable/selectable; `maxLimit` is not in this list).
- Four-axis composition.
- Another storage engine.

---

## Now

Authorization track is complete. Labs worlds now persist on Cloudflare D1
and deploy as Workers.

Next work is forced, not queued: a live document oat did not write that cannot
express a request, or a finding the lab shows is wrong. Do not add query-matrix
cells or another engine until then.

When a task lands, check it off here and add a dated note under [Log](#log).

---

## Log

### 2026-08-14 — labs on D1 + Workers

- Labs no longer use local SQLite. `node labs/provision.mjs` creates one
  D1 per world (`oat-labs-tiny`, `oat-labs-shop`, …). Invites live in D1
  so they survive Worker isolate hops.
- Local (Node → D1 HTTP): tiny 50/0 in 48s; shop 51/0 in 261s; campus
  51/0 in 522s; platform 51/0 in 1061s. All seven probe cases found
  the required check on their own D1.
- Deployed Workers + native D1 binding:
  tiny 50/0 in 12s; shop 51/0 in 70s; campus 51/0 in 134s;
  platform 51/0 in 263s. `bug-stale` HTTPS reports
  `invalidation.declared-route-changes`.
- huge/vast stay schema-only (`LAB_SCALE=1`). D1 oat-run at that size
  is a day of API time, not a coverage gap.
- HTTPS now covers every probe case. Three new planted worlds
  (`bug-cursor`, `bug-lostupdate`, `bug-invite`) fire
  `pagination.cursor-agrees-with-page`, `concurrency.no-lost-update`,
  and `auth.invite-grants-then-revokes`.

### 2026-08-13 — D1 comments, kind/author, planted stale counter

- Comments are a second hand-written entity on `lab/` (not the fixture).
  First D1 run found `pagination.cursor-agrees-with-page`: list returned
  `nextCursor` and ignored it. Cursor walk added. Re-run: 51 checks, 2
  entities, 259 req, no defects — but 9 comment checks inconclusive
  (one writable string; no shared filter value).
- `author` + `kind` (`note`/`question`) added on comments. Restarted
  `LAB_STORE=d1` so `migrate()` ALTER'd the live Cloudflare table.
  Direct D1 `PRAGMA table_info` went from 6 columns to 8. A real
  `POST /comments` with `{author, kind}` landed in D1 and bumped
  `articles.comment_count`.
- Clean D1 re-run: **51 checks · 2 entities · 296 req · 119.7s ·
  0 findings · 0 inconclusive**. Composition and lost-update held
  on comments.
- Planted `LAB_BUG=stale-comments` (skip `recountComments`). Independent
  D1 read: 1 comment row, `comment_count=0`. oat reported
  `invalidation.declared-route-changes` on comment. Restored the
  correct process.

### 2026-08-13 — optional: lab re-run, SPEC_BUG, role-alias heuristic

- Lab with owner/member/viewer + invite: 50 checks, no findings, 5 honest
  did-not-apply (was 48 before N2/N3).
- Spec lie: added `body` to `x-query.filterable` while the handler rejects it.
  `spec.declared-filterable-is-filterable` reported `SPEC_BUG`. Restored.
- Untagged `x-query` now uses `deriveQueryConventions` (same aliases as checks).
  `per_page.maximum` becomes `maxLimit`. Pagination-only lists still get no
  capability. Parser fixtures lock both sides.

### 2026-08-13 — N3 invite flow

- `x-invite` + `auth.invite-grants-then-revokes`.
- Timeline: denied → invite → still denied → accept → allowed → revoke → denied.
- Item GET skips `assertTenant` so a grant can be honoured; ownership still
  decided in `findItem`.
- Verify 54/54 memory postgrest. Bisect: STALE_LIST and CROSS_TENANT_READ
  suppress, correctly.

### 2026-08-13 — N2 monotonicity

- Check `auth.rank-is-monotonic`: a lower rank that can read what a higher
  same-tenant rank cannot is a backend bug.
- Defect denies item GET for rank 1 only (member), so the owner still seeds.
- Tenant compared on `Actor.roots`, not the full path scope (or a member
  missing `table_id` looked like another tenant).
- Verify: 52/52 memory postgrest, 56/56 sqlite. Bisect: only STALE_LIST
  suppresses, correctly.

### 2026-08-13 — N1 role lattice

- `Principal` has `role` / `rank`. Every principal is resolved.
- Cross-tenant `altAuth` is the first actor whose `roots` differ, not array index 1.
- `CheckContext.actors` is the lattice N2 will walk.

### 2026-08-13 — lab on D1

- `node lab/provision.mjs` created D1 `oat-lab`.
- First D1 `oat run` caught a lost-update (full-row PATCH). Partial UPDATE
  fixed it. Second run: 48 checks clean.

### 2026-08-13 — lab + R3 + R4

- `lab/` Hono API, hand-written OpenAPI, `lab/oat.config.ts`. Local SQLite
  default; D1 via `.env` + `provision.mjs`.
- First non-fixture `oat run`: 48 applicable checks, no findings.
- oat bug: `x-soft-delete` only honoured on the list operation — fixed.

### 2026-08-13 — R5, A3

- Sweep: empty suite output is `✗ no result` (Postgres auth failure is now visible);
  fingerprint is `cksum`, so Linux no longer false-`INVALID`s.
- Worked finding walkthrough in [labs/README.md](./labs/README.md).

### 2026-08-13 — R1, R2, A1, A2, A4

- Inventory: [docs/check-inventory.md](./docs/check-inventory.md). Heuristic `x-query`
  uses the same role aliases as the checks. Spec-adversary checks never run untagged.
- Live documents: [docs/live-runs.md](./docs/live-runs.md). Petstore 0/3 listable;
  anyrow 8/10 listable, auth operations missing from the spec.
- README / examples copy updated to 53 checks · 53 defects and current recall lines.
- `doctor` no longer says “fully testable” for an item-only entity, and no longer
  claims query checks are running when there is no list.
- Adoption bar set to **(b)**.

### 2026-08-13 — roadmap opened

Query matrix stopped at the filter triples. Next work is reality, then adoption, then
authorization. This file is the queue.

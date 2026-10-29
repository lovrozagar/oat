# Changelog

## 0.27.1

### Fixed

- A query check that compares several listings no longer blames the backend for a record another
  entity wrote to the same collection between its reads. Before it reports, it reads each listing
  again as it read it; when one now holds other rows, the check is unresolved and says the
  collection moved. A full run saw this when another entity created a template matching a search
  between `search.tokens-and`'s token reads and read it as a dropped AND. It covers
  `search.tokens-and`, `search.empty-q`, `filter.negation-partitions-the-set` and the
  search, select, sort and paging compositions.
- `create.unique-conflict-rejected` and `update.unique-conflict-rejected` report a 409 that still
  stored the row only when a new row holds the colliding values, compared as a backend may store
  them (trimmed, case-folded, a number and its numeral alike). A collection that grew by another
  writer's row is no longer read as a leak.

## 0.27.0

### Added

- **`update.persists-submitted-fields`.** An update must store what it was sent. On a record the
  check makes itself, one update carries a new value for every field the update offers that a read
  returns, never a lifecycle enum (status, state, plan, tier), a privileged or a fixed field. A field
  neither the update's answer nor a read past the cache holds as sent is dropped, and named in one
  finding. A combined update that is refused is retried one field at a time (at most 8); a field
  refused alone is refused, not dropped.

### Changed

- `consistency.staleness-within-bound` watches at most 10 minutes, whatever the declared staleness;
  a read still stale at 10 minutes, under a longer bound, is noted, not judged. Its last read always
  lands on the bound it watches, so a stale read is judged past the bound only when one was seen
  there.

### Fixed

- A field an update does not store is reported once, by `update.persists-submitted-fields`. Every
  check that writes a field picks around it, so it no longer reads as a cache that ignores its
  bypass (`consistency.bypass-is-fresh`), a lost concurrent write (`concurrency.no-lost-update`) or
  a collateral change (`patch.minimality`). A freshness check whose update's own answer keeps the old
  value stands down.

## 0.26.0

### Added

- **Freshness.** A read declares how stale a cache may let it be, and the header that skips the
  cache: `x-consistency: { staleness: "30s", bypass: "x-fresh: 1" }`.
  `consistency.staleness-within-bound` writes, then reads the record as a client would, at once and
  then backing off (at most 12 reads), until the read shows the write. Past the declared staleness
  it is a finding with the bracket it measured and the stale answer's `Cache-Status` (RFC 9211) and
  `Age`. With nothing declared the window is reported, never failed.
  `consistency.bypass-is-fresh` reads once with the declared bypass right after a write: a stale
  answer, or one a cache says it answered, is a finding.
- `oat plan` names how many entities the staleness check measures, and how many against a declared
  bound. `oat doctor` lists the bypass each read is sent.
- The reference's `cached-reads` shape, with `STALE_PAST_BOUND` and `BYPASS_IGNORED`.

### Changed

- **Every read oat sends asks past the caches.** A documented GET or HEAD carries the bypass its
  `x-consistency` declares, else `Cache-Control: no-cache` (RFC 9111), so a write is verified
  against the database rather than a cache in front of it. A header `globalHeaders` or
  `resolveHeaders` sets under that name wins, and config `cache: { bypass: false }` sends none.

## 0.25.1

### Fixed

- A response body larger than 256 KiB is held to its documented schema. The transcript keeps such a
  body only by reference, so `schema.read-response-matches-document` noted it unvalidated and the
  success and error schema checks never saw it. It is now validated when it arrives, while it is
  whole, and each of the three checks reports a body that departs from its schema however large.
- The run's closing calls reach `exchanges.jsonl`: the secondary origins, the revokes of every key
  it minted, the removal of the accounts its sign-ups made, and the end of the principals' own
  sessions. `principals.json` is written after them too.

## 0.25.0

### Breaking

- **Security comes from the document.** Each operation is sent the credentials its OpenAPI
  `security` requires, placed where its scheme says. The config gives one recipe per scheme
  (`static`, `login`, `mint`, `oauth2`, `hook`) under `security`, and `principals` is a map of id
  to identity data. `principals` as an array, `principals[].headers`, `principals[].auth`, `roots`,
  `rootsFromFlow`, `x-auth-flows`, a credential in `globalHeaders` and `hooks.resolvePrincipalAuth`
  are removed; a config that uses one exits 2 and names the replacement.
- **Relative paths resolve from the config's folder.** A config's relative `spec`, each origin's
  relative `spec` and a relative `outDir` now resolve from the folder the config is in, not the
  working directory.
- **Exit 4.** A run that may have left records behind (a teardown that could not prove a record
  gone, or a create oat could not read an id from) exits 4, ahead of every other outcome, and lists
  them under Leftovers.
- **Three checks renamed.** `select.projection-honoured`, `select.nested-honoured` and
  `spec.declared-rate-limit-is-honoured` are `select.projection-honored`, `select.nested-honored`
  and `spec.declared-rate-limit-is-honored`, with no aliases.
- **A baseline names only checks oat runs.** An entry whose `check` no check or run raises exits 2
  and names the nearest id; before, it matched nothing and its finding read as fixed.
- **Everything oat prints is spelled en-US**, the report's **Observed behavior** heading among it.

See [docs/migrating-0.25.md](docs/migrating-0.25.md) for each change and what to write instead.

### Added

- `writer: "<principal id>"` names the principal that makes the records every check works on;
  unset, the first principal writes, as before. A sort-keys lint rule can reorder a map of
  principals, so a config under one names its writer. `doctor` prints who writes and why.
- An entity a security recipe calls is tested: an API's keys, users and sessions are no longer left
  out. Every record holding a credential the run depends on (an API key a recipe minted, a
  principal's own account) is guarded: a check never changes or removes it, and stands down naming
  it. A mint whose answer names no id keeps its entity out, saying why. The self-test proves the
  cross-tenant revoke of an API key with a reference defect of its own.
- `oat init` writes a starter config from the document's security schemes; `doctor` and `plan`
  are security-aware; JUnit output and a CI step summary.
- Twelve security checks (missing, invalid and wrong-scheme credentials, scopes, roles, rank,
  alternatives, anonymous operations, revoked and refreshed credentials, login throttling,
  privileged fields), each proved by a reference auth defect. `auth.privileged-field-ignored` also
  probes a sign-up that accepts a privileged field.
- `schema.read-response-matches-document`: every 2xx item read and listing body is held to its
  documented schema, as the create's already was. A body past the in-memory limit is named in a
  run note, never skipped silently.
- `response.write-only-not-returned`: an item read or listing that hands back a field the document
  marks `writeOnly` is a finding whatever `additionalProperties` says, `SECURITY` when the field is
  credential-like (a password, a secret, a token, an API key) and `SPEC_BUG` otherwise.
- A validation check for every write; form-encoded token answers; serialization styles, the HTTP
  `QUERY` method, local `$ref`s, discriminators, ETags and problem details.
- An entity with no list operation is tested through the ids its creates return.
- `recordPath` can point inside each listing row (`$.hits[*].document`).
- The conformance self-test runs in legs and shards, judged together; CI runs it as a matrix.
- A release runs the same gates CI runs, and refuses a tag whose version the changelog has no section
  for; the real-API targets run on demand.
- `test:targets` runs oat against five real APIs (crAPI, Immich, Keycloak, Typesense, VAmPI); each
  must report exactly the findings its `expected.json` lists, so a false positive fails as surely as
  a missed defect.

### Changed

- `concurrency.no-lost-update` stands down before sending anything when the update body lists fewer
  than two fields a string may go into, naming them, instead of reporting an inconclusive.
- A note a check makes now survives a finding the same check reports; before, a check that both
  noted something and found a defect lost the note.
- When the per-write-path payload budget sends a field one case of each family, the run says so in
  a note: another entity already ran the whole catalog on that write path. It is no longer reported
  as a coverage gap.
- A teardown names every record it cannot prove gone, and every account oat signs up is torn down
  or reported as a leftover.
- Every finding's text is safe to share: secrets are redacted where they are recorded, a run writes
  no credential to disk in the clear, and principals.json keeps no configured credential.

### Fixed

- A document that sets a guard pattern on every written string (no NUL, no lone surrogate), as
  comb 0.13 does, keeps its full check set. Every pattern in an `allOf` now counts. Values stay
  realistic text whenever every pattern admits them. The self probe, `concurrency.no-lost-update`
  and `payload.string-survives` write only values the field's patterns and lengths admit, so a
  guarded phone field no longer yields a false `auth.self-is-the-caller` finding.
- `x-wait` and `x-async` conclude a missed delivery only after three polls, so a slow host never reports a
  false finding on a working API; a wait that ran past its budget says so in a run note.
- `payload.string-survives` no longer picks a field a schema marks `writeOnly` (a value no read
  returns). The same exclusion now applies to `patch.minimality` and the isolation checks' choice
  of a writable string (c69ca09, whose subject names the payload check).
- `create.persists-submitted-fields` judges the record it reads back, not the acknowledgment, and
  only the fields that record's schema declares.
- `patch.minimality` recognizes more server timestamp spellings (`updatedAt` and others), including
  one the first write stamps from null.
- A query probe sends only parameters the operation or the config declares.
- A recipe for a scheme only a secondary origin declares, mapped there with `origins[].security`,
  is accepted, acquired once for the run and sent in that origin scheme's place, in the recipe's
  own format. A recipe no document maps is refused with every origin's schemes named.
- A scenario that names a principal BLOCKED at sign-in is reported BLOCKED, its operations stay
  ungraded, and the run goes on to its report. It crashed the run as a principal "which is not
  configured" and wrote no report. A scenario or step principal the config does not declare is now
  refused at load, so `doctor` and `plan` catch it too.
- A value a scenario step keeps whole is sent as it is: `{name}`-shaped text inside it, such as
  Stripe's `{CHECKOUT_SESSION_ID}` in a success URL, is never read as a placeholder or refused as
  unfilled.
- A client-chosen identity is reserved before the first create, and the identities a seed lists are
  taken at once. Two creates could draw one id, and against a create that overwrites the record
  holding it, the second silently replaced the first.
- A password reset, recovery or change is never read as a sign-up; no automatic write changes how a
  principal signs in.
- A malformed `x-*` tag, an unresolvable `$ref` or a schema oat cannot generate from is a reported
  gap, never a crash or silence.
- And about a hundred smaller fixes across seeding, teardown, the contract floor, credentials and
  reports; the commit log since v0.24.0 lists each one.

### Security

- Run artifacts (saved exchanges, reports and repros) no longer show a secret the backend issues
  mid-run. A value answered under a secret key, such as a TOTP setup's `secret`, is scrubbed
  wherever else it appears, raw, URL-encoded or base32-normalized. An otpauth URI's `secret` is
  redacted by its scheme. A `data:` image in a body that had anything redacted, such as the QR
  code drawing the secret, is redacted too.

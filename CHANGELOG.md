# Changelog

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

- `payload.string-survives` no longer picks a field a schema marks `writeOnly` (a value no read
  returns). The same exclusion now applies to `patch.minimality` and the isolation checks' choice
  of a writable string (c69ca09, whose subject names the payload check).
- `create.persists-submitted-fields` judges the record it reads back, not the acknowledgment, and
  only the fields that record's schema declares.
- `patch.minimality` recognizes more server timestamp spellings (`updatedAt` and others), including
  one the first write stamps from null.
- A query probe sends only parameters the operation or the config declares.
- A password reset, recovery or change is never read as a sign-up; no automatic write changes how a
  principal signs in.
- A malformed `x-*` tag, an unresolvable `$ref` or a schema oat cannot generate from is a reported
  gap, never a crash or silence.
- And about a hundred smaller fixes across seeding, teardown, the contract floor, credentials and
  reports; the commit log since v0.24.0 lists each one.

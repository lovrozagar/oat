# Limits

What oat cannot do yet, what you see when you hit it, and what to do instead. Each one is a gap oat reports, never a finding it invents.

## Deliberate non-features

These are by design. Do not look for a flag that turns them off.

- **Default request timeout is 180s.** `network.requestTimeoutMs` (per attempt) aborts a stuck `fetch`, including a hung stream; `0` disables it. Watch `status=in_flight` and `idle_ms` in the progress log as that budget is consumed.
- **No retry on 5xx.** A 429 is retried up to 5 times, honoring `Retry-After`. One 401 forces a credential refresh and a single retry; a second 401 is evidence.
- **Network throws are not HTTP.** Offline, DNS, reset or timeout: 4 retries, then one wait (default 60s) for the link. If it does not come back, `net.unreachable` is recorded, the remaining work stands down, the report is still written, and the run exits `3`. Failed attempts are journaled as `status: 0` with `{ error: "network", kind }`.
- **No `servers[]` at run time.** `oat init` reads the first absolute server URL into `baseUrl`; a run always uses `baseUrl`. Extra hosts are `origins[]`, each with its own `spec`. An app origin that answers HTML and `Set-Cookie` is a request step with an absolute URL, not a dummy spec in `origins[]`.
- **No OCR.** Multipart file parts are sent as dummy, pool, `each` or `resolveUpload` bytes. oat checks HTTP statuses and JSON answers, not whether a PDF is a real invoice.
- **No webhook, callback or link-object following**, except the explicit auth or invite GET of a URL `resolveOutOfBand` returned. A hook-side `fetch` of that URL is not a recorded exchange.
- **URL `$ref`s are not fetched.** In-document `$ref`s are, and so are relative refs to files inside the document's own folder.
- **`x-idempotent` is not the idempotency check.** That check keys off a documented `Idempotency-Key` header.
- **Rate-limit pacing covers only oat's own requests.** It cannot see other traffic to the backend, so a shared budget can still trip while oat's own share stayed within the declared rate.
- **An equality-only filter grammar** cannot express `neq`, `gt`, `like`, `and` or `or`; those checks do not apply, they do not fail. `or()` is PostgREST-only.
- **Leftover rows on a shared database** poison numeric and filter checks (`1, 10, 2` from old text-sorted rows beside a fresh numeric cohort). Wipe them between runs if a `--keep-fixtures` run or a crashed teardown left any.
- **`--only` takes plan names** (`store`, not `stores` or `/v1/stores`).
- **`--ops` trusts support operations.** A targeted green means the targets passed, given that what they needed worked. A defect in an untargeted operation is out of scope, even when a target called it.
- **The default cohort is 7.** `pagination.limit-respects-documented-max` needs `cohortSize` above the documented maximum.
- **One principal writes:** the one `writer` names, or the first. Further principals are peers and a rank lattice, not a pool of writers.

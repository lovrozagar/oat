# Limits

What oat cannot do yet, what you see when you hit it, and what to do instead. Each one is a gap oat reports, never a finding it invents.

## A filter parameter under a name oat does not know

oat finds a list's filter parameter by its name alone: `filter`, `where`, `query` or `conditions`, in any case or spelling (`filterBy` is not one of them), with an optional bracketed suffix (`filter[status]`). A parameter under any other name, such as Typesense's `filter_by`, is not used as the filter parameter. No config key or `x-query` field names it today, and an overlay cannot rename it: oat would then send the name the overlay gave it, not the one the server reads.

What you see: the filter checks for that list do not apply. Each one stands down, and the reason names the query parameter it would have sent, which the list operation does not declare. oat sends nothing to the parameter it could not name, so the list gets no false filter findings either.

What to do instead:

- Name the fields as one query parameter each when the API takes them that way (`?status=active`): declare the parameters on the operation, and the per-field filter checks run on them.
- Test the custom filter with a scenario. A step can send `?filter_by=...` as written and assert on the answer.

## Deliberate non-features

These are by design. Do not look for a flag that turns them off.

- **Default request timeout is 180s.** `network.requestTimeoutMs` (per attempt) aborts a stuck `fetch`, including a hung stream; `0` disables it. Watch `status=in_flight` and `idle_ms` in the progress log as that budget is consumed.
- **No retry on 5xx.** A 429 is retried up to 5 times, honouring `Retry-After`. One 401 forces a credential refresh and a single retry; a second 401 is evidence.
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
- **The first principal is the writer.** Further principals are peers and a rank lattice, not a pool of writers.

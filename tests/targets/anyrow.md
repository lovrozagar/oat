# anyrow acceptance

anyrow is the private API oat was built against first. It is not a target `test:targets` can run:
its stack, its data and its Turnstile-guarded sign-up live in the monorepo. A release candidate of
oat passes this procedure by hand before it is tagged.

Everything runs from the anyrow tester, with the tester alone pointed at the oat checkout under
test: build the checkout (`bun run build`), then link the tester's own `@lovrozagar/oat` package and
its `oat` bin to the checkout and its `bin/oat.js`:

```bash
cd ~/Development/monorepo/projects/anyrow/engineering/private/api/_tester
```

Runs go against prod (`CLOUDFLARE_ENV=prod`), as the baseline did. `dev` has no public API, and
`local` cannot pass sign-up: oat reads the verify mail from `/v1/test/last-mail`, whose store only
prod's inbound mail worker writes, and the standing admin exists only on prod.

## While developing

| Step      | Command                               | Passes when                                                                                                              |
| --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Model     | `bun run doctor`                      | exit 0 or 1, both schemes listed (`jwt` and the minted `apiKey`), 47 operations with an apiKey alternative, 53 anonymous |
| Plan      | `bun run plan`                        | the entity table and requirements match the previous release's, apart from what this release adds                        |
| Cheap run | `bun run test:oat:cheap` against prod | exit 0, 1 or 4, no `failed` outcome, no finding a reviewer has not seen before                                           |

## Before a release

`bun run test:oat` is the full run: about two hours against prod (125 minutes on 0.25.0). Its
sign-up passes Cloudflare Turnstile, so a Chrome window opens for the harvest; keep the machine
awake. Its `oauth` scenario signs in through the Chrome profile `OAT_GOOGLE_CHROME_PROFILE` names:
open that profile in Chrome first if it has not been used lately, so its Google session is current.

It passes when:

- the run ends with exit 0, 1 or 4, and `oat-report.json` has no `failed` outcome. Exit 4 is
  `leftovers`: oat could not show some records gone. Every leftover is either a scenario sign-up
  whose held session expired before the end-of-run teardown, which the run script's password sweep
  then deletes (its `fresh accounts:` line counts them), or a dated account a later day's scenario
  needs (`oat-signin-<date>`, `oat-offer-<date>`). Any other leftover is a finding;
- both schemes are graded: operations with an apiKey alternative are tested with the minted key as
  well as the JWT (`auth.alternative-accepted` ran);
- request coverage keeps or beats the baseline's.

## Comparing with the baseline

The baseline is the summary of the four full runs before 0.25 (`2026-10-13T19-45-19Z`,
`2026-10-13T22-57-40Z`, `2026-10-14T00-58-44Z`, `2026-10-14T03-13-42Z`), kept outside the
repository at `.tmp/grunt/anyrow-baseline.json` because it describes a private API. For the new
run's `oat-report.json`, compare:

| Measure           | Read from                   | Holds when                                                                              |
| ----------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| Outcome           | `outcome.result`            | not `failed`                                                                            |
| Requests          | `requests`                  | within the baseline's range, or above it with new checks explaining the rise            |
| Findings by check | `findings[].check`, counted | every baseline finding is still found or fixed in anyrow, and every new one is reviewed |
| Coverage          | `scope.operations[].status` | as many operations `passed` or `failed` as the baseline graded, or more                 |
| Schemes           | `scope.operations[].checks` | operations that accept the apiKey are graded under both schemes                         |

A difference is a finding about oat or about anyrow, never noise: explain it before tagging.

# oat — Releasing

[← back to the overview](../README.md)

A release is a git tag. Pushing `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which waits for CI's verdict and the changelog check on the tagged commit, publishes `@lovrozagar/oat` to npm with provenance and to GitHub
Packages, and then creates the GitHub Release. npm is the registry people install from; GitHub
Releases follow npm versions.

## Cutting a release

1. On `main`, with CI green, set `version` in `package.json` to `X.Y.Z` and add its `## X.Y.Z`
   heading to `CHANGELOG.md`. Commit and push through the hooks, as any change.
2. Tag that commit `vX.Y.Z` and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Watch the run. It publishes only when every job before it passed.
4. Check the result: `npm view @lovrozagar/oat@X.Y.Z` answers the version, its page on npmjs.com
   shows the provenance badge, and the GitHub Release `vX.Y.Z` exists with generated notes.

A tag the workflow could not publish is run again from the Actions tab (`workflow_dispatch`) with
the tag as input. A version npm or GitHub Packages already has is skipped, not republished.

## What the workflow runs

A tag matches `v*`. Its jobs, in order:

| job               | what it does                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gates`           | `bun scripts/release-gates.ts vX.Y.Z`: passes once `ci.yml` passed on the tagged commit; fails on a red run; runs `ci.yml` on the tag when a later push canceled the commit's run |
| `changelog`       | `bun scripts/changelog-has.ts vX.Y.Z`: fails unless `CHANGELOG.md` has a `## X.Y.Z` heading                                                                                       |
| `npmjs.com`       | after both, checks the tag equals `package.json`'s `version`, then `npm publish --access public --provenance`                                                                     |
| `GitHub Packages` | after both, publishes the same build to `npm.pkg.github.com`                                                                                                                      |
| `GitHub Release`  | `gh release create vX.Y.Z --generate-notes`                                                                                                                                       |

A release therefore passes exactly the gates `main` does, without running them a second time, and
nothing is published until they and the changelog check pass.

The npm job also fails on a tag that does not equal `package.json`'s `version`, so a mistyped tag
publishes nothing.

## Trusted publishing

The npm job holds no token. It exchanges the job's GitHub OIDC token for a short-lived npm publish
token, which npm grants only to the publisher configured on the package, and `--provenance` links
the published version to the workflow run that built it. Configure that publisher once, on
npmjs.com → `@lovrozagar/oat` → Settings → Trusted Publisher, exactly as:

```
GitHub Actions / lovrozagar / oat / release.yml / environment empty / allow npm publish
```

A `404` or a non-`201` from the token exchange in the job's log means the saved publisher does not
match this workflow; the job prints the same line to compare against.

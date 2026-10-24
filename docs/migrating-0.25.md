# oat — Migrating to 0.25

[← back to the overview](../README.md)

0.25 changes how a config says who oat acts as, and where its relative paths point. A config that still uses a removed field exits 2 and names the replacement, so nothing changes silently.

## Relative paths resolve from the config's folder

A config's relative `spec`, each origin's relative `spec`, and a relative `outDir` now resolve from the config's own folder, no longer from the working directory. A config that sat beside its document keeps working from any directory; one written for a working directory elsewhere needs its paths made relative to its own folder (or absolute).

## Removed config fields

A config with any of these exits 2, naming the replacement:

| removed                                                      | instead                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `principals` as an array                                     | a map of id → identity data                                        |
| `principals[].headers`                                       | `security.<scheme>: { static: … }`                                 |
| `principals[].auth`                                          | `security.<scheme>: { login: { steps, from } }`                    |
| `principals[].roots`, top-level `roots`                      | `principals.<id>.scope`, and `tenant`                              |
| `rootsFromFlow`                                              | `security.<scheme>.login.claims`                                   |
| `x-auth-flows`, in the config or the document                | a `security.<scheme>` recipe                                       |
| a credential in `globalHeaders` (`Authorization`, `Cookie`…) | the scheme places it; `redact.headers` for a non-credential secret |
| `hooks.resolvePrincipalAuth`                                 | `{ hook: true }` and `hooks.resolveCredential`                     |

## The writer is named, or the first principal

An array kept its order; a map's key order is easy to lose, and a sort-keys lint rule reorders it. The writer, the principal that makes the records every check works on, is the one top-level `writer` names, or else the first key of `principals`. A config whose principals a linter sorts, or that wants a writer other than its first entry, sets `writer: "<id>"`. `oat doctor` prints who writes and why.

## Renamed checks

Three check ids are spelled en-US now:

| 0.24                                   | 0.25                                  |
| -------------------------------------- | ------------------------------------- |
| `select.projection-honoured`           | `select.projection-honored`           |
| `select.nested-honoured`               | `select.nested-honored`               |
| `spec.declared-rate-limit-is-honoured` | `spec.declared-rate-limit-is-honored` |

A baseline that names an old id exits 2 and names the new one, as it does for any id no check raises, so a known finding never reads as fixed because its check was renamed. `oat diff` between a 0.24 report and a 0.25 one shows those checks' findings as fixed under the old id and new under the new one.

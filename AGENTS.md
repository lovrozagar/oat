# AGENTS.md

## Writing style

Use en-US English throughout — code, comments, docs, and commit messages.

## Git safety

Moving forward is yours to do without asking: `status`, `diff`, `log`, `add`,
`commit`, creating branches, and pushing.

Ask first — and wait for an answer — before anything that moves sideways:
discarding work, rewriting history, forcing a change through, or recovering
something. That includes:

- `reset --hard`, `checkout` / `restore` over uncommitted changes, `clean`
- `stash`, `stash pop`, `stash drop`
- `push --force`, including `--force-with-lease`
- `rebase`, `cherry-pick`, `revert`, `commit --amend`
- deleting a branch or tag, local or remote
- anything reflog-driven

If you cannot tell whether a command can lose work, treat it as one that can.

## Before you call it done

Run these from the repo root; CI runs the same set.

    bun run fmt          # oxfmt, rewrites in place
    bun run lint         # oxlint
    bun run check        # tsc --noEmit
    bun run test         # builds, then runs the conformance suite

`test` shells out to `node --experimental-sqlite` on purpose: Node is the
runtime oat ships against, even though Bun drives the scripts.

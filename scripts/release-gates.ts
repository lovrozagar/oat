#!/usr/bin/env bun
/*
 * `bun scripts/release-gates.ts <tag>`: exits 0 once ci.yml has passed on the commit the tag names,
 * else 1. A release publishes only what CI passed, without running the gates a second time: it
 * waits for the push run on that commit, and when none finished (a later push to main canceled
 * it), it runs ci.yml on the tag and waits for that. Needs `gh` with `actions: write`.
 */
import { spawnSync } from "node:child_process"

/** One ci.yml run, as `gh run list --json databaseId,status,conclusion` answers it. */
export interface CiRun {
	databaseId: number
	status: string
	conclusion: string
}

export type GatesVerdict =
	| { kind: "passed" }
	| { kind: "failed"; id: number }
	| { kind: "wait"; id: number }
	| { kind: "dispatch" }

/* A run that ended without a verdict on the code: canceled by a later push, or skipped. */
const NO_VERDICT = new Set(["cancelled", "skipped", "neutral", "stale"])

/** What the runs of ci.yml on one commit, newest first, say about releasing it. */
export function gatesVerdict(runs: readonly CiRun[]): GatesVerdict {
	if (runs.some((run) => run.status === "completed" && run.conclusion === "success")) return { kind: "passed" }
	const going = runs.find((run) => run.status !== "completed")
	if (going !== undefined) return { id: going.databaseId, kind: "wait" }
	const red = runs.find((run) => !NO_VERDICT.has(run.conclusion))
	return red === undefined ? { kind: "dispatch" } : { id: red.databaseId, kind: "failed" }
}

const POLL_MS = 15_000
/* Long enough for a dispatched run to be listed; the job's own timeout bounds the whole wait. */
const DISPATCH_POLLS = 40

function gh(args: string[]): { ok: boolean; out: string } {
	const done = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
	return { ok: done.status === 0, out: done.stdout }
}

function ciRuns(sha: string): CiRun[] {
	const listed = gh(["run", "list", "--workflow", "ci.yml", "--commit", sha, "--json", "databaseId,status,conclusion"])
	if (!listed.ok) throw new Error(`gh run list failed for ${sha}`)
	return JSON.parse(listed.out) as CiRun[]
}

async function main(tag: string): Promise<number> {
	const sha = gh(["api", `repos/{owner}/{repo}/commits/${tag}`, "--jq", ".sha"]).out.trim()
	if (sha === "") return fail(`no commit for ${tag}`)
	let dispatched = 0
	for (;;) {
		const verdict = gatesVerdict(ciRuns(sha))
		if (verdict.kind === "passed") return pass(`ci.yml passed on ${sha}`)
		if (verdict.kind === "failed") return fail(`ci.yml run ${verdict.id} failed on ${sha}: fix it and tag again`)
		if (verdict.kind === "wait") {
			console.log(`waiting for ci.yml run ${verdict.id} on ${sha}`)
			gh(["run", "watch", String(verdict.id), "--interval", "30"])
			continue
		}
		if (dispatched === 0 && !gh(["workflow", "run", "ci.yml", "--ref", tag]).ok) return fail("could not run ci.yml")
		if (dispatched === 0) console.log(`no ci.yml run finished on ${sha}: started one on ${tag}`)
		if (++dispatched > DISPATCH_POLLS) return fail(`the ci.yml run started on ${tag} never appeared`)
		await new Promise((resolve) => setTimeout(resolve, POLL_MS))
	}
}

function pass(message: string): number {
	console.log(message)
	return 0
}

function fail(message: string): number {
	console.error(message)
	return 1
}

if (import.meta.main) {
	const tag = process.argv[2] ?? ""
	process.exit(tag === "" ? fail("usage: bun scripts/release-gates.ts <tag>") : await main(tag))
}

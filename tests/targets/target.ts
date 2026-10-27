import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { latestReport, oat, type ReportFinding, type SavedRunReport } from "../support/cli-run.ts"
import type { Vendored } from "../support/vendored.ts"

/*
 * A real API oat is pointed at: its own compose stack, the setup a fresh install needs before a
 * run (an admin, users, keys), and the findings it is known to deserve. Each target lives in
 * tests/targets/<name>/ with `compose.yml`, `oat.config.ts`, `expected.json` and a `target.ts`
 * whose default export is a `Target`.
 */

export interface Target {
	/** Where the API answers once its stack is up. */
	baseUrl: string
	/**
	 * Readies a freshly started stack (waits for it, signs up, mints keys) and returns the env
	 * vars its oat.config.ts reads through env().
	 */
	prepare(baseUrl: string): Promise<Record<string, string>>
	/** How long the stack may take to come up and be prepared, in ms. */
	readyWithinMs?: number
	/**
	 * Third-party files the stack or the config reads that the repository must not hold (a published
	 * test key, a document carrying a sample token): fetched into the target's directory from a
	 * pinned commit before the stack starts, each checked by its sha256, and kept out of git.
	 */
	vendored?: readonly Vendored[]
}

/**
 * A finding the target deserves: its check, its class, and the operation it names, or its entity
 * when it names no operation (a teardown or seed gap). A run reports exactly these, no more.
 */
export interface ExpectedFinding {
	check: string
	verdict: string
	operationId?: string
	entity?: string
	/** Why the target deserves it: the known bug, with a link where there is one. */
	why: string
}

export const TARGETS_DIR: string = import.meta.dirname

/**
 * The targets `OAT_TARGETS` names, or `undefined` for every target: unset, or a list that names none,
 * as a workflow dispatch with its input left empty sends.
 */
export function targetsAsked(value: string | undefined): string[] | undefined {
	const named = (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean)
	return named.length === 0 ? undefined : named
}

/** `docker compose` on one target's stack, as its own project; throws with the output on a failure. */
export function compose(name: string, args: readonly string[]): string {
	const file = join(TARGETS_DIR, name, "compose.yml")
	const ran = spawnSync("docker", ["compose", "-p", `oat-target-${name}`, "-f", file, ...args], { encoding: "utf8" })
	if (ran.status !== 0)
		throw new Error(`docker compose ${args.join(" ")} (${name}) exited ${ran.status}: ${ran.stderr}`)
	return ran.stdout
}

/** Polls `url` until it answers `ok`, or throws after `withinMs`. */
export async function answers(url: string, withinMs: number, ok = (status: number) => status < 500): Promise<void> {
	const deadline = Date.now() + withinMs
	let last = "no answer"
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url)
			if (ok(response.status)) return
			last = `HTTP ${response.status}`
		} catch (error) {
			last = (error as Error).message
		}
		await new Promise((resolve) => setTimeout(resolve, 2000))
	}
	throw new Error(`${url} did not come up within ${withinMs} ms: ${last}`)
}

/** A target's run: oat's exit code and output, and the report it wrote. */
export interface TargetRun {
	code: number
	out: string
	report: SavedRunReport
	expected: ExpectedFinding[]
}

/** Runs oat against a prepared target with its config, its env set for the run only. */
export async function runTarget(name: string, env: Record<string, string>, out: string): Promise<TargetRun> {
	const saved = { ...process.env }
	Object.assign(process.env, env)
	try {
		const config = join(TARGETS_DIR, name, "oat.config.ts")
		const { code, out: printed } = await oat(["run", "--config", config, "--out", out, "--quiet"])
		const expected = JSON.parse(await readFile(join(TARGETS_DIR, name, "expected.json"), "utf8")) as ExpectedFinding[]
		return { code, expected, out: printed, report: await latestReport(out) }
	} finally {
		for (const key of Object.keys(env)) {
			if (saved[key] === undefined) delete process.env[key]
			else process.env[key] = saved[key]
		}
	}
}

/** Whether an expected entry speaks for a reported finding: same check and class, and the operation or entity it names. */
function matches(expected: ExpectedFinding, finding: ReportFinding): boolean {
	if (expected.check !== finding.check || expected.verdict !== finding.verdict) return false
	return expected.operationId === undefined
		? expected.entity === finding.entity
		: (finding.operations ?? []).includes(expected.operationId)
}

/** The expected findings a run did not report, each as `VERDICT check on operation`. */
export function missing(run: TargetRun): string[] {
	return run.expected
		.filter((expected) => !run.report.findings.some((finding) => matches(expected, finding)))
		.map((e) => `${e.verdict} ${e.check} on ${e.operationId ?? `entity ${e.entity}`}`)
}

/** The findings a run reported that no expected entry speaks for: each a false positive or an unrecorded defect. */
export function unexpected(run: TargetRun): string[] {
	return run.report.findings
		.filter((finding) => !run.expected.some((expected) => matches(expected, finding)))
		.map((f) => `${f.verdict} ${f.check} on ${f.operations?.join(", ") ?? `entity ${f.entity}`}: ${f.summary ?? ""}`)
}

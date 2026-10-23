import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { messageOf } from "../../errors/message.ts"
import { EXIT } from "../../runtime/exit.ts"
import type { RawOf } from "../../config/types/raw.ts"
import type { Writer } from "../writer.ts"
import type { Toolkit } from "./conformance-toolkit.ts"

/*
 * A sharded self-test: each leg writes the checks its defects proved, and `--aggregate` judges
 * their union, so a gate split into short legs still fails on a check no defect proves.
 */

/** What one leg proved, as `--proven-out` writes it. */
export interface ProvenFile {
	legs: string[]
	proven: string[]
}

/** Writes the checks a leg proved to `path`, making its folder. */
export function writeProven(path: string, legs: readonly string[], proven: ReadonlySet<string>): void {
	mkdirSync(dirname(path), { recursive: true })
	const body: ProvenFile = { legs: [...legs], proven: [...proven].toSorted() }
	writeFileSync(path, `${JSON.stringify(body, null, "\t")}\n`)
}

/**
 * `conformance --aggregate <dir>`: every leg's proven checks together, and the checks none of
 * them proved. Exits 1 on any, 2 when there is nothing to read.
 */
export function aggregate(writer: Writer, toolkit: Toolkit, dir: string): number {
	let files: string[]
	try {
		files = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.toSorted()
	} catch (error) {
		writer.err(`oat: cannot read ${dir}: ${messageOf(error)}\n`)
		return EXIT.usage
	}
	if (files.length === 0) {
		writer.err(`oat: ${dir} holds no proven-check files; write them with --proven-out\n`)
		return EXIT.usage
	}
	const proven = new Set<string>()
	for (const name of files) {
		const read = JSON.parse(readFileSync(join(dir, name), "utf8")) as RawOf<ProvenFile>
		if (!Array.isArray(read.proven)) continue
		for (const id of read.proven) if (typeof id === "string") proven.add(id)
	}
	writer.out(`  ${files.length} leg file(s) · ${proven.size} check(s) proven\n`)
	const unproven = toolkit.suite.renderUnproven(proven)
	writer.out(unproven.text)
	return unproven.failures > 0 ? 1 : 0
}

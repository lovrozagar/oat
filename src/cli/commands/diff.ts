import { readFile, realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { messageOf } from "../../errors/message.ts"
import { diffReports, renderDiff, type SavedReport } from "../../report/diff.ts"
import { EXIT } from "../../runtime/exit.ts"
import type { Args } from "../flags.ts"
import type { Writer } from "../writer.ts"

/** `oat diff <runA> <runB>`: a report on two runs, never a gate. */
export async function commandDiff(
	writer: Writer,
	flags: Args["flags"],
	positionals: readonly string[],
): Promise<number> {
	const [a, b] = positionals
	if (a === undefined || b === undefined) {
		writer.err("oat: diff needs two run folders: oat diff <runA> <runB>\n")
		return EXIT.usage
	}
	const reports: SavedReport[] = []
	for (const run of [a, b]) {
		const read = await savedReport(run)
		if (typeof read === "string") {
			writer.err(`oat: cannot read ${resolve(run, "oat-report.json")}: ${read}\n`)
			return EXIT.usage
		}
		reports.push(read)
	}
	const diff = diffReports(...(reports as [SavedReport, SavedReport]))
	writer.out(flags.json === true ? `${JSON.stringify(diff, null, 2)}\n` : renderDiff(diff))
	return 0
}

/** A run's saved report, or why it cannot be read. `latest` is a link: read where it points. */
async function savedReport(run: string): Promise<SavedReport | string> {
	try {
		const folder = await realpath(resolve(run))
		const saved = JSON.parse(await readFile(resolve(folder, "oat-report.json"), "utf8")) as Partial<SavedReport>
		return Array.isArray(saved.findings) ? (saved as SavedReport) : "it holds no findings list"
	} catch (error) {
		return messageOf(error)
	}
}

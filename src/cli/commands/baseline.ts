import { existsSync } from "node:fs"
import { readFile, realpath, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { messageOf } from "../../errors/message.ts"
import { type SavedReport, schemaRefusal } from "../../report/diff.ts"
import { baselineFrom } from "../../runtime/baseline.ts"
import { EXIT } from "../../runtime/exit.ts"
import type { RawOf } from "../../config/types/raw.ts"
import { type Args, str } from "../flags.ts"
import type { Writer } from "../writer.ts"

/** `oat baseline --from <run>`: the run's root-cause findings, as a baseline file. */
export async function commandBaseline(writer: Writer, flags: Args["flags"]): Promise<number> {
	const from = str(flags, "from")
	if (from === undefined) {
		writer.err("oat: baseline needs --from <run folder | latest>\n")
		return EXIT.usage
	}
	const out = resolve(str(flags, "out") ?? "oat.baseline.json")
	let saved: RawOf<SavedReport>
	try {
		/* `latest` is a link: read where it points. */
		const folder = await realpath(resolve(from))
		saved = JSON.parse(await readFile(resolve(folder, "oat-report.json"), "utf8")) as typeof saved
	} catch (error) {
		writer.err(`oat: cannot read ${resolve(from, "oat-report.json")}: ${messageOf(error)}\n`)
		return EXIT.usage
	}
	if (!Array.isArray(saved.findings)) {
		writer.err(`oat: ${resolve(from, "oat-report.json")} holds no findings list\n`)
		return EXIT.usage
	}
	const refusal = schemaRefusal(saved, resolve(from, "oat-report.json"))
	if (refusal !== undefined) {
		writer.err(`oat: ${refusal}\n`)
		return EXIT.usage
	}
	if (flags.force !== true && existsSync(out)) {
		writer.err(`oat: ${out} exists; --force overwrites it\n`)
		return EXIT.usage
	}
	const baseline = baselineFrom(saved.findings as Parameters<typeof baselineFrom>[0])
	await writeFile(out, `${JSON.stringify(baseline, null, "\t")}\n`)
	writer.out(`  ${baseline.entries.length} known finding${baseline.entries.length === 1 ? "" : "s"} → ${out}\n`)
	return 0
}

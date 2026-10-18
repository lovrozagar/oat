import { renderRepros } from "../../report/render/repro.ts"
import type { Finding } from "../../runtime/finding.ts"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { messageOf } from "../../errors/message.ts"
import { Redactor } from "../../security/redact.ts"

const exec = promisify(execFile)

/**
 * Generated reproducers are shell scripts, so a quoting mistake turns them into scripts that run
 * against a literal `$BASE` with a literal `$TOKEN` — they look right and do the wrong thing.
 * `bash -n` parses without executing, which catches that class before anyone copies one.
 */
export async function checkReproSyntax(findings: Finding[]): Promise<string[]> {
	return await checkScripts(renderRepros(findings, "https://example.test", new Redactor()))
}

/** Each script's parse failures and unexpandable variables, as `filename: problem`. */
export async function checkScripts(scripts: ReturnType<typeof renderRepros>): Promise<string[]> {
	if (scripts.length === 0) return []
	const dir = await mkdtemp(join(tmpdir(), "oat-repro-"))
	try {
		return await checkEach(dir, scripts)
	} finally {
		/* A self-test that litters the temp directory is the same failure it reports elsewhere. */
		await rm(dir, { force: true, recursive: true })
	}
}

async function checkEach(dir: string, scripts: ReturnType<typeof renderRepros>): Promise<string[]> {
	const failures: string[] = []
	for (const script of scripts) {
		const path = join(dir, script.filename)
		await writeFile(path, script.content)
		try {
			await exec("bash", ["-n", path])
		} catch (error) {
			failures.push(`${script.filename}: ${messageOf(error)}`)
		}
		/* An unexpanded variable inside single quotes is syntactically valid and semantically
		 * wrong, so parse success is not enough. Checked per line and skipping comments: prose
		 * apostrophes ("schema's") would otherwise let the match span into unrelated code. */
		for (const line of script.content.split("\n")) {
			if (line.trimStart().startsWith("#")) continue
			if (/'[^']*\$(BASE|TOKEN)[^']*'/.test(line)) {
				failures.push(
					`${script.filename}: $BASE/$TOKEN appears inside single quotes and will not expand — ${line.trim()}`,
				)
			}
		}
	}
	return failures
}

import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { messageOf } from "../errors/message.ts"
import { EXIT } from "../runtime/exit.ts"
import { commandBaseline } from "./commands/baseline.ts"
import { commandConformance } from "./commands/conformance.ts"
import type { Toolkit } from "./commands/conformance-toolkit.ts"
import { commandDiff } from "./commands/diff.ts"
import { commandDoctor } from "./commands/doctor.ts"
import { commandInit } from "./commands/init.ts"
import { commandPlan } from "./commands/plan.ts"
import { commandRun, type RunDeps } from "./commands/run.ts"
import { commandServe, type ServeDeps } from "./commands/serve.ts"
import { parseArgs, unknownFlag, USAGE } from "./flags.ts"
import { processWriter, type Writer } from "./writer.ts"

/** What the commands reach outside the process through; each defaults to the real thing. */
export interface CliDeps {
	writer: Writer
	run?: RunDeps
	serve?: ServeDeps
	toolkit?: () => Promise<Toolkit>
}

type Command = (deps: CliDeps, flags: Record<string, string | true>, positionals: readonly string[]) => Promise<number>

/** Every command, by name. */
const COMMANDS: Readonly<Record<string, Command>> = {
	baseline: ({ writer }, flags) => commandBaseline(writer, flags),
	conformance: ({ writer, toolkit }, flags) => commandConformance(writer, flags, toolkit),
	diff: ({ writer }, flags, positionals) => commandDiff(writer, flags, positionals),
	doctor: ({ writer }, flags) => commandDoctor(writer, flags),
	init: ({ writer }, flags) => commandInit(writer, flags),
	plan: ({ writer }, flags) => commandPlan(writer, flags),
	run: ({ writer, run }, flags) => commandRun(writer, flags, run),
	serve: ({ writer, serve }, flags) => commandServe(writer, flags, serve),
}

/** `oat <command> …`: refuses what it cannot parse, prints help when asked, and runs the command. Returns the exit code. */
export async function main(
	argv: readonly string[] = process.argv.slice(2),
	deps: CliDeps = { writer: processWriter },
): Promise<number> {
	const { writer } = deps
	const { command, error, flags, positionals } = parseArgs(argv)
	const unknown = unknownFlag(flags)
	if (unknown !== undefined) {
		writer.err(`oat: unknown flag "--${unknown}"\n\n${USAGE}`)
		return EXIT.usage
	}
	if (error !== undefined) {
		writer.err(`oat: ${error}\n\n${USAGE}`)
		return EXIT.usage
	}
	if (command === "help" || flags.help === true) {
		writer.out(USAGE)
		return 0
	}
	const run = COMMANDS[command]
	if (run === undefined) {
		writer.err(`oat: unknown command "${command}"\n\n${USAGE}`)
		return EXIT.usage
	}
	return run(deps, flags, positionals ?? [])
}

/** Runs the CLI as the process: its exit code is the process's, and an error it did not expect is one line. */
export function start(deps: CliDeps = { writer: processWriter }): Promise<void> {
	return main(process.argv.slice(2), deps).then(
		(code) => {
			process.exitCode = code
		},
		(error: unknown) => {
			deps.writer.err(`oat: ${messageOf(error)}\n`)
			process.exitCode = EXIT.failed
		},
	)
}

/**
 * Whether `moduleUrl` is the program Node was asked to run (`entry`, its argv[1]). Installed from
 * a local path, oat is a symlink: Node gives the module its real path and leaves argv[1] the link,
 * so the two are compared as real paths, and as written when either cannot be resolved.
 */
export function invokedDirectly(entry: string | undefined, moduleUrl: string): boolean {
	if (entry === undefined) return false
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entry))
	} catch {
		return moduleUrl === pathToFileURL(resolve(entry)).href
	}
}

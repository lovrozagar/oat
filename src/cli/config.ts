import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { interpolate, loadConfig } from "../config/load.ts"
import type { OatConfig } from "../config/types/config.ts"
import { configProblems } from "../config/validate.ts"
import { messageOf } from "../errors/message.ts"

/** How a command reads its config: `doctor` and `plan` send nothing, so they defer unset variables. */
export interface ReadOptions {
	deferEnv?: boolean
}

/** A config read for use, and, when deferring, the variables it names that are not set, in the order it names them. */
export type ReadConfig = { config: OatConfig; unsetEnv?: string[] } | { problem: string }

/**
 * A config file, loaded, checked and interpolated — or the first reason it cannot be used. Every
 * one of these is the caller's to fix, so the command exits 2 with nothing sent. Deferred, an unset
 * `env()` or `${NAME}` stays its `${NAME}` literal and is listed instead.
 */
export async function readConfig(path: string, forRun: boolean, options: ReadOptions = {}): Promise<ReadConfig> {
	if (!existsSync(resolve(path))) return { problem: `config not found: ${path}` }
	const deferEnv = options.deferEnv === true
	let loaded: OatConfig
	try {
		loaded = await loadConfig(path, { deferEnv })
	} catch (error) {
		return { problem: reason(error) }
	}
	const problems = configProblems(loaded, { forRun })
	if (problems.length > 0) return { problem: `${path} is not a valid config:\n  ${problems.join("\n  ")}` }
	if (deferEnv) {
		const unset = new Set<string>()
		return { config: interpolate(loaded, process.env, { unset }), unsetEnv: [...unset] }
	}
	try {
		return { config: interpolate(loaded) }
	} catch (error) {
		return { problem: reason(error) }
	}
}

/* Stated as the command states it: the `oat: ` prefix is the command's own. */
function reason(error: unknown): string {
	return messageOf(error).replace(/^oat: /, "")
}

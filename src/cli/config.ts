import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { interpolate, loadConfig } from "../config/load.ts"
import type { OatConfig } from "../config/types/config.ts"
import { configProblems } from "../config/validate.ts"
import { messageOf } from "../errors/message.ts"

/**
 * A config file, loaded, checked and interpolated — or the first reason it cannot be used. Every
 * one of these is the caller's to fix, so the command exits 2 with nothing sent.
 */
export async function readConfig(path: string, forRun: boolean): Promise<{ config: OatConfig } | { problem: string }> {
	if (!existsSync(resolve(path))) return { problem: `config not found: ${path}` }
	let loaded: OatConfig
	try {
		loaded = await loadConfig(path)
	} catch (error) {
		return { problem: reason(error) }
	}
	const problems = configProblems(loaded, { forRun })
	if (problems.length > 0) return { problem: `${path} is not a valid config:\n  ${problems.join("\n  ")}` }
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

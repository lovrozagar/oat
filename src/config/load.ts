/**
 * Config loading. A config is a `.js`/`.mjs`/`.ts` module with a default export, or a `.json`
 * file. TypeScript configs load only where the runtime can strip types (Node 22.6+ with
 * `--experimental-strip-types`, or Node 23+); the error says so rather than failing obscurely.
 */

import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { MissingEnvError } from "./env.ts"
import type { OatConfig } from "./types/config.ts"

export async function loadConfig(path: string): Promise<OatConfig> {
	const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path)

	if (absolute.endsWith(".json")) {
		return JSON.parse(await readFile(absolute, "utf8")) as OatConfig
	}

	try {
		const module = (await import(pathToFileURL(absolute).href)) as {
			default?: OatConfig
		} & OatConfig
		const config = module.default ?? module
		if (typeof config !== "object") {
			throw new Error("config module has no default export")
		}
		return config
	} catch (error) {
		if (error instanceof MissingEnvError) throw new Error(`${error.message} (${path})`, { cause: error })
		const message = error instanceof Error ? error.message : String(error)
		if (absolute.endsWith(".ts") && /Unknown file extension|strip-types/.test(message)) {
			throw new Error(
				`oat: cannot load ${path} — this Node build will not import TypeScript directly. ` +
					"Run with `node --experimental-strip-types`, or use a .js/.mjs config.",
				{ cause: error },
			)
		}
		throw new Error(`oat: failed to load config ${path}: ${message}`, { cause: error })
	}
}

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value) as unknown
	return proto === Object.prototype || proto === null
}

/** Env-var interpolation so configs can carry `${API_TOKEN}` without embedding secrets. */
export function interpolate<T>(value: T, env: Record<string, string | undefined> = process.env): T {
	if (typeof value === "string") {
		return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => {
			const resolved = env[name]
			if (resolved === undefined) {
				throw new Error(`oat: config references \${${name}}, which is not set in the environment`)
			}
			return resolved
		}) as T
	}
	if (Array.isArray(value)) return value.map((item) => interpolate(item, env)) as T
	/* Only plain data is walked. Anything else — an upload's bytes, a date — is the author's object. */
	if (value !== null && typeof value === "object" && isPlainObject(value)) {
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = interpolate(item, env)
		}
		return out as T
	}
	return value
}

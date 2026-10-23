/**
 * Config loading. A config is a `.js`/`.mjs`/`.ts` module with a default export, or a `.json`
 * file. TypeScript configs load where the runtime strips types, which oat's Node floor (22.18) does
 * by default; the error says so rather than failing obscurely.
 */

import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { DEFER_ENV, MissingEnvError } from "./env.ts"
import type { OatConfig } from "./types/config.ts"

/** How a config is loaded: `doctor` and `plan` defer an unset `env()` instead of stopping. */
export interface LoadOptions {
	deferEnv?: boolean
}

export async function loadConfig(path: string, options: LoadOptions = {}): Promise<OatConfig> {
	const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path)

	if (absolute.endsWith(".json")) {
		return JSON.parse(await readFile(absolute, "utf8")) as OatConfig
	}

	const deferEnv = options.deferEnv === true
	const previous = process.env[DEFER_ENV]
	/* Set for doctor and plan, cleared for a run: a run never inherits deferral from the shell. */
	if (deferEnv) process.env[DEFER_ENV] = "1"
	else delete process.env[DEFER_ENV]
	try {
		/* Each mode is its own module instance: a load in one mode never hands back the other's values. */
		const url = `${pathToFileURL(absolute).href}${deferEnv ? "?oat-defer-env" : ""}`
		const module = (await import(url)) as { default?: OatConfig } & OatConfig
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
				`oat: cannot load ${path} — this Node cannot import TypeScript ` +
					"(oat needs 22.18 or later, without --no-experimental-strip-types); or use a .js/.mjs config",
				{ cause: error },
			)
		}
		throw new Error(`oat: failed to load config ${path}: ${message}`, { cause: error })
	} finally {
		if (previous === undefined) delete process.env[DEFER_ENV]
		else process.env[DEFER_ENV] = previous
	}
}

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value) as unknown
	return proto === Object.prototype || proto === null
}

/** How `interpolate` treats a name the environment lacks. */
export interface InterpolateOptions {
	/** When given, an unset `${NAME}` is left as written and its name added here, instead of stopping. */
	unset?: Set<string>
}

/** Env-var interpolation so configs can carry `${API_TOKEN}` without embedding secrets. */
export function interpolate<T>(
	value: T,
	env: Record<string, string | undefined> = process.env,
	options: InterpolateOptions = {},
): T {
	if (typeof value === "string") {
		return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, name: string) => {
			const resolved = env[name]
			if (resolved !== undefined) return resolved
			if (options.unset === undefined) {
				throw new Error(`oat: config references \${${name}}, which is not set in the environment`)
			}
			options.unset.add(name)
			return match
		}) as T
	}
	if (Array.isArray(value)) return value.map((item) => interpolate(item, env, options)) as T
	/* Only plain data is walked. Anything else — an upload's bytes, a date — is the author's object. */
	if (value !== null && typeof value === "object" && isPlainObject(value)) {
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = interpolate(item, env, options)
		}
		return out as T
	}
	return value
}

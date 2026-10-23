/*
 * A config reads its secrets through `env(name)`. An unset or empty variable stops the load,
 * naming the variable and the config file: `process.env.TOKEN ?? ""` once sent `Bearer ` with
 * nothing after it, and every request after that failed as if the backend were at fault.
 *
 * `doctor` and `plan` send nothing, so they read a config whose secrets are not set yet: while
 * their load runs, `OAT_DEFER_ENV` is exactly "1" and an unset variable reads as its `${NAME}`
 * literal, which the command lists. A process variable is the one signal that reaches the copy of
 * this module a config imports from the published package. `loadConfig` sets it, or clears it for a
 * run, around the import alone, so a run never inherits it from the shell.
 */

/** The variable that defers an unset `env()` to its `${NAME}` literal, when it is exactly "1". */
export const DEFER_ENV = "OAT_DEFER_ENV"

export class MissingEnvError extends Error {
	override name = "MissingEnvError"
	constructor(readonly variable: string) {
		super(`oat: env ${variable} is not set`)
	}
}

/** The value of `name` in the environment; throws when it is unset or empty, unless the load defers it. */
export function env(name: string, environment: Readonly<Record<string, string | undefined>> = process.env): string {
	const value = environment[name]
	if (value !== undefined && value !== "") return value
	if (environment[DEFER_ENV] === "1") return `\${${name}}`
	throw new MissingEnvError(name)
}

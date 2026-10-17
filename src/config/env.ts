/*
 * A config reads its secrets through `env(name)`. An unset or empty variable stops the load,
 * naming the variable and the config file: `process.env.TOKEN ?? ""` once sent `Bearer ` with
 * nothing after it, and every request after that failed as if the backend were at fault.
 */

export class MissingEnvError extends Error {
	override name = "MissingEnvError"
	constructor(readonly variable: string) {
		super(`oat: env ${variable} is not set`)
	}
}

/** The value of `name` in the environment; throws when it is unset or empty. */
export function env(name: string, environment: Readonly<Record<string, string | undefined>> = process.env): string {
	const value = environment[name]
	if (value === undefined || value === "") throw new MissingEnvError(name)
	return value
}

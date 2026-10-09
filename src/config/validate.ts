/**
 * The config, checked before anything runs.
 *
 * A misspelled key used to be ignored and a wrong type used to flow into the run — a
 * `maxInFlight` of `"8"` silently became the default, a `cohortSize` of `0` seeded nothing. Each
 * problem names the key path and what it should be, and the CLI exits 2 without sending a request.
 */

type Rule = (value: unknown, path: string) => string[]

const string: Rule = (value, path) => (typeof value === "string" ? [] : [`${path} must be a string`])
const boolean: Rule = (value, path) => (typeof value === "boolean" ? [] : [`${path} must be true or false`])
const object: Rule = (value, path) =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? [] : [`${path} must be an object`]
const integer =
	(min: number): Rule =>
	(value, path) =>
		Number.isSafeInteger(value) && (value as number) >= min
			? []
			: [`${path} must be an integer${min > 0 ? ` of at least ${min}` : min === 0 ? " of at least 0" : ""}`]
const number: Rule = (value, path) =>
	typeof value === "number" && Number.isFinite(value) ? [] : [`${path} must be a number`]
const oneOf =
	(...allowed: string[]): Rule =>
	(value, path) =>
		allowed.includes(value as string) ? [] : [`${path} must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`]
const arrayOf =
	(item: Rule): Rule =>
	(value, path) =>
		Array.isArray(value)
			? value.flatMap((entry, index) => item(entry, `${path}[${index}]`))
			: [`${path} must be an array`]
const recordOf =
	(item: Rule): Rule =>
	(value, path) =>
		object(value, path).length > 0
			? object(value, path)
			: Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => item(entry, `${path}.${key}`))
const shape =
	(fields: Record<string, Rule>, required: readonly string[] = []): Rule =>
	(value, path) => {
		const notObject = object(value, path)
		if (notObject.length > 0) return notObject
		const record = value as Record<string, unknown>
		const problems: string[] = []
		for (const key of required) if (record[key] === undefined) problems.push(`${path}.${key} is required`)
		for (const [key, entry] of Object.entries(record)) {
			const rule = fields[key]
			if (rule === undefined) problems.push(`${path}.${key} is not a config key`)
			else if (entry !== undefined) problems.push(...rule(entry, `${path}.${key}`))
		}
		return problems
	}
const principal = shape(
	{
		auth: object,
		headers: recordOf(string),
		id: string,
		inviteAs: string,
		rank: number,
		role: string,
		roots: recordOf(string),
		rootsFromFlow: recordOf(string),
	},
	["id"],
)

const CONFIG = {
	baseUrl: string,
	cohortSize: integer(1),
	entities: recordOf(object),
	globalHeaders: recordOf(string),
	hooks: object,
	keepFixtures: boolean,
	maxInFlight: integer(1),
	network: shape({ requestTimeoutMs: integer(0), retries: integer(0), waitMs: integer(0) }),
	only: arrayOf(string),
	ops: arrayOf(string),
	origins: arrayOf(object),
	outDir: string,
	outOfBand: shape({ attempts: integer(1), initialMs: integer(0), maxMs: integer(0) }),
	payloads: oneOf("full", "per-write-path"),
	principals: arrayOf(principal),
	profile: string,
	profiles: recordOf(object),
	query: object,
	rateLimits: arrayOf(object),
	roots: recordOf(string),
	saveExchanges: boolean,
	seed: integer(Number.MIN_SAFE_INTEGER),
	spec: string,
	uploads: object,
} satisfies Record<string, Rule>

/** Every problem with `config`, by key path. `run` needs a spec, a base URL and a principal. */
export function configProblems(config: unknown, options: { forRun?: boolean } = {}): string[] {
	const required = options.forRun === true ? ["spec", "baseUrl", "principals"] : []
	const problems = shape(CONFIG, required)(config, "config")
	if (options.forRun === true && Array.isArray((config as { principals?: unknown })?.principals)) {
		if ((config as { principals: unknown[] }).principals.length === 0) problems.push("config.principals is empty")
	}
	return problems
}

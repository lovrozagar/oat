/**
 * The config, checked before anything runs.
 *
 * A misspelled key used to be ignored and a wrong type used to flow into the run — a
 * `maxInFlight` of `"8"` silently became the default, a `cohortSize` of `0` seeded nothing. Each
 * problem names the key path and what it should be, and the CLI exits 2 without sending a request.
 */

import { CREDENTIAL_HEADERS } from "../security/credential-names.ts"
import { principalMapProblems, REMOVED_KEYS, removedProblems } from "../credentials/validate/principals.ts"
import { securityMapProblems } from "../credentials/validate/security.ts"
import { isRaw, isRecord, type RawOf } from "./types/raw.ts"
import type { OatConfig } from "./types/config.ts"
import type { Hooks } from "./types/hooks.ts"

type Rule = (value: unknown, path: string) => string[]

const string: Rule = (value, path) => (typeof value === "string" ? [] : [`${path} must be a string`])
const boolean: Rule = (value, path) => (typeof value === "boolean" ? [] : [`${path} must be true or false`])
const object: Rule = (value, path) =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? [] : [`${path} must be an object`]
/* An object whose named keys, when set, hold functions; the rest are not checked here. */
const functionsAt =
	(...keys: string[]): Rule =>
	(value, path) => {
		const notObject = object(value, path)
		if (notObject.length > 0) return notObject
		const record = value as Record<string, unknown>
		return keys
			.filter((key) => record[key] !== undefined && typeof record[key] !== "function")
			.map((key) => `${path}.${key} must be a function`)
	}
const integer =
	(min: number): Rule =>
	(value, path) =>
		Number.isSafeInteger(value) && (value as number) >= min
			? []
			: [`${path} must be an integer${min >= 0 ? ` of at least ${min}` : ""}`]
const positive: Rule = (value, path) =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? [] : [`${path} must be a number above 0`]
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
/* A key checked as a whole by its own validator in `credentialProblems`, which reads other keys too. */
const checkedWhole: Rule = () => []

const objectOrNull: Rule = (value, path) =>
	value === null || isRecord(value) ? [] : [`${path} must be an object or null`]

/**
 * Patches by operationId and by schema name, each an object merged into the document; security
 * schemes to merge (`null` deletes one), and the root security requirement.
 */
function overlayRule(): Rule {
	return shape({
		operations: recordOf(object),
		schemas: recordOf(object),
		security: arrayOf(recordOf(arrayOf(string))),
		securitySchemes: recordOf(objectOrNull),
	})
}

/** The rule for each top-level config key; its keys are the config keys oat knows. */
export function configRules(): Record<string, Rule> {
	const overlay = overlayRule()
	return {
		baseUrl: string,
		/* Opt-in checks by id: an unknown id is named, so a misspelled switch never reads as off. */
		checks: shape({ "auth.login-throttled": boolean }),
		cohortSize: integer(1),
		entities: recordOf(object),
		globalHeaders: recordOf(string),
		hooks: functionsAt("verifyRemoved", "resolveCredential"),
		keepFixtures: boolean,
		maxInFlight: integer(1),
		maxRps: positive,
		network: shape({ requestTimeoutMs: integer(0), retries: integer(0), waitMs: integer(0) }),
		only: arrayOf(string),
		ops: arrayOf(string),
		origins: arrayOf(
			shape({ baseUrl: string, id: string, maxRps: positive, overlay, security: recordOf(string), spec: string }, [
				"baseUrl",
				"id",
				"spec",
			]),
		),
		overlay,
		allow: arrayOf(string),
		fence: shape({ failRun: boolean }),
		teardown: shape({ verify: boolean }),
		baseline: string,
		targetVersion: shape({ from: string, operationId: string, path: string, scheme: string }, ["from"]),
		outDir: string,
		outOfBand: shape({ attempts: integer(1), initialMs: integer(0), maxMs: integer(0) }),
		payloads: oneOf("full", "per-write-path"),
		principals: checkedWhole,
		profile: string,
		profiles: recordOf(object),
		query: object,
		rateLimits: arrayOf(object),
		redact: shape({ headers: arrayOf(string) }),
		saveExchanges: boolean,
		scenarios: arrayOf(object),
		security: checkedWhole,
		seed: integer(Number.MIN_SAFE_INTEGER),
		spec: string,
		uploads: object,
		writer: string,
	}
}

const CREDENTIAL_HEADER = "a credential is sent by its scheme; declare security.<scheme>"
const REMOVED_HOOKS: Readonly<Record<string, string>> = {
	resolvePrincipalAuth:
		"declare security.<scheme>: { hook: true } and return the credential from hooks.resolveCredential",
}

/* Keys a 0.25.0 credential recipe replaced: a credential header in globalHeaders, a hook no recipe calls. */
function carrierProblems(config: RawOf<OatConfig>): string[] {
	const headers = isRecord(config.globalHeaders) ? Object.keys(config.globalHeaders) : []
	const hooks: RawOf<Hooks> = isRaw<Hooks>(config.hooks) ? config.hooks : {}
	return [
		...headers
			.filter((name) => CREDENTIAL_HEADERS.has(name.toLowerCase()))
			.map((name) => `globalHeaders.${name} was removed in 0.25.0: ${CREDENTIAL_HEADER}`),
		...Object.entries(REMOVED_HOOKS)
			.filter(([name]) => name in hooks)
			.map(([name, replacement]) => `hooks.${name} was removed in 0.25.0: ${replacement}`),
	]
}

/* A writer that names no principal: the run would write as someone the config does not declare. */
function writerProblems(config: RawOf<OatConfig>): string[] {
	const { principals, writer } = config
	if (typeof writer !== "string" || !isRecord(principals) || writer in principals) return []
	return [`writer names no principal: "${writer}" (principals: ${Object.keys(principals).join(", ")})`]
}

/* The credentials config, by the validators that also run against the document, minus what needs it. */
function credentialProblems(config: RawOf<OatConfig>): string[] {
	return [
		...(config.principals === undefined ? [] : principalMapProblems(config)),
		...writerProblems(config),
		...securityMapProblems(config),
		...removedProblems(config),
		...carrierProblems(config),
	]
}

/** Every problem with `config`, by key path. `run` needs a spec, a base URL and a principal. */
export function configProblems(config: unknown, options: { forRun?: boolean } = {}): string[] {
	const required = options.forRun === true ? ["spec", "baseUrl", "principals"] : []
	const rules = shape(configRules(), required)
	if (!isRecord(config)) return rules(config, "config")
	/* A removed key is named with its replacement below, not as a key oat does not know. */
	const current = Object.fromEntries(Object.entries(config).filter(([key]) => !REMOVED_KEYS.includes(key)))
	return [...rules(current, "config"), ...credentialProblems(config).map((problem) => `config.${problem}`)]
}

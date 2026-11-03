/*
 * The `{name}` placeholders a scenario reads, checked against what fills them. A scenario starts
 * from its principal's scope: the entry's `scope`, its own `scope.<param>` keys, and each login
 * claim bound as `scope.<param>`, by a configured scheme or the principal's own recipe override.
 * Each step then binds in the order the scenario runner does: its `bind` entries, then what its
 * request, out-of-band address or external input reads, its asserts, then its `saveAs` entries one
 * by one, and last its claims or out-of-band and external `as`. A name nothing fills would be sent
 * as written, so the config is refused, naming the scenario, the step and the name.
 */

import type { OatConfig } from "../../config/types/config.ts"
import { placeholderNames } from "../../config/types/placeholder.ts"
import { isRecord, type RawOf } from "../../config/types/raw.ts"

type Config = RawOf<OatConfig>
type Raw = Record<string, unknown>

const SCOPED = "scope."

const recordOf = (value: unknown): Raw => (isRecord(value) ? value : {})
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/* The parameters keys written `scope.<param>` bind. */
const scoped = (keys: string[]): string[] =>
	keys.filter((key) => key.startsWith(SCOPED)).map((key) => key.slice(SCOPED.length))

/*
 * Every parameter a login claim binds into a principal's scope, over every scheme: which one a
 * principal holds is decided at sign-in. `security` is the config's schemes, or a principal's own
 * recipe overrides; counting both over-approximates the merged recipe, which can only miss a typo.
 */
function claimedScope(security: unknown): string[] {
	return Object.values(recordOf(security)).flatMap((scheme) =>
		scoped(Object.keys(recordOf(recordOf(recordOf(scheme)["login"])["claims"]))),
	)
}

/* The principal a scenario that names none runs as: the writer the config declares, else the first, as a run orders them. */
function writerOf(config: Config, principals: Raw): string | undefined {
	const writer = config.writer
	return typeof writer === "string" && writer in principals ? writer : Object.keys(principals)[0]
}

/*
 * The scope a scenario starts from: its principal's, else the writer's. A principal the config
 * does not declare is the principals check's to name, so this check stands down.
 */
function startingScope(config: Config, scenario: Raw): Set<string> | undefined {
	const principals = recordOf(config.principals)
	const id = typeof scenario["principal"] === "string" ? scenario["principal"] : writerOf(config, principals)
	if (id !== undefined && !(id in principals)) return undefined
	const entry = recordOf(principals[id ?? ""])
	return new Set([
		...Object.keys(recordOf(entry["scope"])),
		...scoped(Object.keys(entry)),
		...claimedScope(config.security),
		...claimedScope(entry["security"]),
	])
}

/* What a step reads after its binds: an out-of-band address, an external's input, or a request and its asserts. */
function reads(step: Raw): unknown[] {
	if (step["outOfBand"] !== undefined) return [recordOf(step["outOfBand"])["address"]]
	if (step["external"] !== undefined) return [step["input"]]
	const raw = step["method"] === undefined ? null : step["path"]
	const asserts = [step["assert"] ?? []].flat().map((assert) => {
		const { observes: _observes, ...read } = recordOf(assert)
		return read
	})
	return [raw, step["body"], step["headers"], step["query"], asserts]
}

/* The names a step binds once it is answered, beside `saveAs`. */
function binds(step: Raw): string[] {
	const out = recordOf(step["outOfBand"])["as"]
	const as = step["external"] === undefined ? out : step["as"]
	return [...Object.keys(recordOf(recordOf(step["saveClaimsFrom"])["bind"])), ...(typeof as === "string" ? [as] : [])]
}

/* The first name `step` reads that `bound` lacks, binding what the step binds as it goes. */
function unfilledStep(step: Raw, bound: Set<string>): string | undefined {
	const missing = (value: unknown): string | undefined => placeholderNames(value).find((name) => !bound.has(name))
	const bindAll = (entries: unknown): string | undefined => {
		for (const [name, template] of Object.entries(recordOf(entries))) {
			const read = missing(template)
			if (read !== undefined) return read
			bound.add(name)
		}
		return undefined
	}
	const read = bindAll(step["bind"]) ?? missing(reads(step)) ?? bindAll(step["saveAs"])
	if (read !== undefined) return read
	for (const name of binds(step)) bound.add(name)
	return undefined
}

function scenarioProblem(config: Config, scenario: Raw): string[] {
	const bound = startingScope(config, scenario)
	if (bound === undefined) return []
	for (const [index, step] of listOf(scenario["steps"]).entries()) {
		const name = unfilledStep(recordOf(step), bound)
		if (name === undefined) continue
		return [
			`scenarios.${String(scenario["id"])}.steps[${index}] reads {${name}}, ` +
				"which no earlier step, the principal's scope or a login claim provides",
		]
	}
	return []
}

/** One problem per scenario whose step reads a `{name}` nothing before it fills. */
export function scenarioPlaceholderProblems(config: Config): string[] {
	return listOf(config.scenarios)
		.filter(isRecord)
		.flatMap((scenario) => scenarioProblem(config, scenario))
}

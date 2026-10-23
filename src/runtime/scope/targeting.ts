/** Collecting a targeted run's operations: `--ops` patterns and `--only` entities, per origin, under the profile. */

import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { didYouMean } from "../../errors/suggest.ts"
import { resolveOperationName } from "../../spec/operation-name.ts"
import { matchPattern } from "./match.ts"
import { ScopeError } from "./scope-error.ts"
import type { ScopeInput } from "./types.ts"

/** What a targeted run has gathered so far. */
export interface Targeting {
	model: SpecModel
	input: ScopeInput
	targets: Set<string>
	originTargets: Map<string, Set<string>>
	excluded: Array<{ operationId: string; reason: string }>
}

/** One operation offered as a target. */
interface Candidate {
	id: string
	/** Named outright: excluding it is an error, not a quiet drop. */
	exact: boolean
	model: SpecModel
	into: Set<string>
	label: string
}

function admit(t: Targeting, candidate: Candidate): void {
	const { exclusion } = t.input
	/* A candidate id comes from its model, so its operation is there. */
	const op = candidate.model.byOperationId.get(candidate.id) as OperationModel
	const reason = exclusion === undefined ? null : exclusion.reason(op)
	if (exclusion === undefined || reason === null) {
		candidate.into.add(candidate.id)
		return
	}
	if (candidate.exact) {
		throw new ScopeError(
			`oat: target ${candidate.label} is excluded by --profile ${exclusion.profile} (${reason}). ` +
				`Drop it from --ops or run --profile full.`,
		)
	}
	t.excluded.push({ operationId: candidate.label, reason })
}

function originSet(t: Targeting, originId: string): Set<string> {
	const into = t.originTargets.get(originId) ?? new Set<string>()
	t.originTargets.set(originId, into)
	return into
}

/** One `--ops` pattern: `<origin>:<pattern>` against that origin, anything else against the primary. */
export function targetPattern(t: Targeting, pattern: string): void {
	const { input } = t
	const colon = pattern.indexOf(":")
	const originId = colon > 0 ? pattern.slice(0, colon) : undefined
	const originModel = originId === undefined ? undefined : input.origins?.get(originId)
	if (originId !== undefined && originModel !== undefined) {
		const into = originSet(t, originId)
		const matched = matchPattern(pattern.slice(colon + 1), originModel, pattern)
		for (const id of matched.ids) {
			admit(t, { exact: matched.exact, id, into, label: `${originId}:${id}`, model: originModel })
		}
		return
	}
	/* A prefix that names no configured origin, on an id the primary does not have. */
	if (
		originId !== undefined &&
		resolveOperationName(pattern, t.model.byOperationId) === undefined &&
		input.origins !== undefined
	) {
		const known = [...input.origins.keys()]
		throw new ScopeError(
			`oat: --ops "${pattern}" names origin "${originId}", which is not configured.` +
				(known.length === 0 ? "" : ` Known: ${known.join(", ")}.`),
		)
	}
	const matched = matchPattern(pattern, t.model, pattern)
	for (const id of matched.ids) admit(t, { exact: matched.exact, id, into: t.targets, label: id, model: t.model })
}

/** One `--only` entity: every operation it owns, on the primary and on each origin that models it. */
export function targetEntity(t: Targeting, name: string): void {
	const { model, input } = t
	let found = false
	if (model.entities.has(name)) {
		found = true
		for (const op of model.operations) {
			if (op.entity === name)
				admit(t, { exact: false, id: op.operationId, into: t.targets, label: op.operationId, model })
		}
	}
	for (const [originId, originModel] of input.origins ?? []) {
		if (!originModel.entities.has(name)) continue
		found = true
		const into = originSet(t, originId)
		for (const op of originModel.operations) {
			if (op.entity !== name) continue
			admit(t, { exact: false, id: op.operationId, into, label: `${originId}:${op.operationId}`, model: originModel })
		}
	}
	if (!found) {
		const known = [
			...model.entities.keys(),
			...[...(input.origins?.values() ?? [])].flatMap((m) => [...m.entities.keys()]),
		]
		throw new ScopeError(`oat: --only "${name}" names no entity.${didYouMean(name, known)}`)
	}
}

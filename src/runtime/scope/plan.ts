import { owningEntityOf } from "../../spec/graph/roots.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { CHECKS } from "../checks/registry.ts"
import type { ScopePlan, TargetScope } from "./types.ts"

/** The checks in scope that grade each operation. */
function checksFor(model: SpecModel, scope: TargetScope): Map<string, Set<string>> {
	const checks = new Map<string, Set<string>>()
	for (const entity of scope.entities) {
		for (const check of CHECKS) {
			for (const id of check.subjects(entity, model)) {
				if (!scope.inScope(id)) continue
				const set = checks.get(id) ?? new Set<string>()
				set.add(check.id)
				checks.set(id, set)
			}
		}
	}
	return checks
}

/** The creates of every parent `op`'s path names, up the chain, into `support`. */
function addParents(model: SpecModel, op: OperationModel | undefined, support: Set<string>, seen: Set<string>): void {
	if (op === undefined || seen.has(op.operationId)) return
	seen.add(op.operationId)
	for (const param of op.pathParams) {
		const owner = owningEntityOf(model.operations, op.path, param)
		/* An owner named only by the path (`/projects/{project_id}`) is no entity of the model. */
		const create = owner === null ? undefined : model.byOperationId.get(model.entities.get(owner)?.create ?? "")
		if (create === undefined || create.operationId === op.operationId) continue
		support.add(create.operationId)
		addParents(model, create, support, seen)
	}
}

/** Lifecycle routes of the queued entities and the parents their creates need. */
function supportOf(model: SpecModel, scope: TargetScope): Set<string> {
	const support = new Set<string>()
	for (const entity of scope.entities) {
		for (const id of [entity.create, entity.list, entity.read, entity.delete]) if (id !== undefined) support.add(id)
		addParents(model, model.byOperationId.get(entity.create ?? ""), support, new Set())
	}
	return support
}

/** The scope a run would take, with no network: what `oat plan --ops` prints. */
export function planScope(model: SpecModel, scope: TargetScope): ScopePlan {
	const checks = checksFor(model, scope)
	const support = supportOf(model, scope)
	const ids = scope.mode === "targeted" ? [...scope.targets].sort() : [...checks.keys()].sort()
	return {
		entities: scope.entities.map((entity) => entity.name),
		excluded: scope.excluded,
		mode: scope.mode,
		origins: Object.fromEntries(scope.origins),
		requested: scope.requested,
		support: [...support].filter((id) => scope.mode === "full" || !scope.targets.has(id)).sort(),
		targets: ids
			.filter((id) => !scope.untestable.has(id))
			.map((operationId) => ({
				/* A target no check in scope grades is untestable, so every one left has checks. */
				checks: [...(checks.get(operationId) as Set<string>)].sort(),
				/* A target or a check's subject is an operationId of the model. */
				entity: (model.byOperationId.get(operationId) as OperationModel).entity,
				operationId,
			})),
		untestable: [...scope.untestable].map(([operationId, reason]) => ({ operationId, reason })),
	}
}

/** `--ops a,b --only c` as the reader typed it. */
export function describeRequested(requested: { ops: readonly string[]; only: readonly string[] }): string {
	return [
		...(requested.ops.length > 0 ? [`--ops ${requested.ops.join(",")}`] : []),
		...(requested.only.length > 0 ? [`--only ${requested.only.join(",")}`] : []),
	].join(" ")
}

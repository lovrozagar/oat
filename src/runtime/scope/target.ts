import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { staticSubjects, testableEntities, untestableReason } from "./entities.ts"
import { type Targeting, targetEntity, targetPattern } from "./targeting.ts"
import type { ScopeInput, TargetScope } from "./types.ts"

/** The targeted scope: the entities whose checks grade a target, and why any other target never can be. */
function targetedScope(
	ctx: Targeting,
	testable: EntityModel[],
	authCreates: ReadonlySet<string>,
	requested: TargetScope["requested"],
): TargetScope {
	const { model, targets } = ctx
	const graded = new Set<string>()
	const entities = testable.filter((entity) => {
		const subjects = staticSubjects(entity, model)
		const hit = [...subjects].some((id) => targets.has(id))
		if (hit) for (const id of subjects) if (targets.has(id)) graded.add(id)
		return hit
	})

	const untestable = new Map<string, string>()
	for (const id of targets) {
		if (graded.has(id)) continue
		/* A primary target is an operationId of the model. */
		untestable.set(id, untestableReason(model.byOperationId.get(id) as OperationModel, model, authCreates))
	}

	const origins = new Map<string, string[]>()
	for (const [originId, ids] of ctx.originTargets) if (ids.size > 0) origins.set(originId, [...ids])

	return {
		entities,
		excluded: ctx.excluded,
		inScope: (operationId) => targets.has(operationId),
		mode: "targeted",
		origins,
		requested,
		targets,
		untestable,
	}
}

export function resolveTargetScope(model: SpecModel, input: ScopeInput): TargetScope {
	const ops = [...(input.ops ?? [])].map((s) => s.trim()).filter(Boolean)
	const only = [...(input.only ?? [])].map((s) => s.trim()).filter(Boolean)
	const authCreates = input.authCreates ?? new Set<string>()
	const testable = testableEntities(model, authCreates)

	if (ops.length === 0 && only.length === 0) {
		return {
			entities: testable,
			excluded: [],
			inScope: () => true,
			mode: "full",
			origins: new Map(),
			requested: { only, ops },
			targets: new Set(),
			untestable: new Map(),
		}
	}

	const t: Targeting = { excluded: [], input, model, originTargets: new Map(), targets: new Set() }
	for (const pattern of ops) targetPattern(t, pattern)
	for (const name of only) targetEntity(t, name)
	return targetedScope(t, testable, authCreates, { only, ops })
}

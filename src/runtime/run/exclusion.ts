import { excludedByProfile } from "../profile.ts"
import type { Exclusion, Loaded } from "./context.ts"
import type { RunFindingId } from "../check-ids.ts"

export function createExclusion({ model, profile, state, findings }: Loaded): Exclusion {
	return {
		excludeOp(entity, op) {
			if (op === undefined) return false
			const reason = excludedByProfile(op, profile.spec)
			if (reason === null) return false
			if (state.excludedIds.has(op.operationId)) return true
			state.excludedIds.add(op.operationId)
			state.profileExclusions.push({ entity: entity.name, operationId: op.operationId, reason })
			findings.attributed([op.operationId]).gap("profile.skip" satisfies RunFindingId, entity.name, {
				summary: `${op.operationId} excluded by profile "${profile.name}"`,
				detail:
					`${reason}, under --profile ${profile.name}. Checks that depend on this operation stand ` +
					"down rather than run against data oat did not create through it.",
			})
			return true
		},
		excludes(operationId) {
			const op = model.byOperationId.get(operationId)
			return op !== undefined && excludedByProfile(op, profile.spec) !== null
		},
		readable: (op) => excludedByProfile(op, profile.spec) === null,
	}
}

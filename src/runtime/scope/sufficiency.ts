import type { OperationModel } from "../../spec/graph/types.ts"
import { SAFE } from "../../spec/methods.ts"
import type { PassEvidence } from "../grades.ts"
import type { Sufficiency } from "./types.ts"

export function sufficiencyOf(
	op: Pick<OperationModel, "effects" | "method" | "noEffects">,
	evidence: PassEvidence,
): { sufficiency: Sufficiency; why: string } {
	if (evidence.observation !== undefined) {
		return { sufficiency: "verified", why: "a later exchange shows what this call did" }
	}
	if (op.noEffects) {
		return { sufficiency: "complete", why: "declares no effects, so its contract is the whole promise" }
	}
	if (op.effects.length === 0 && SAFE.has(op.method.toUpperCase())) {
		return { sufficiency: "complete", why: "a read with no declared effects: its contract is the whole promise" }
	}
	return {
		sufficiency: "unproven",
		why:
			op.effects.length > 0
				? "declares effects that no later read observed"
				: "met its contract, but no later read observed what it changed",
	}
}

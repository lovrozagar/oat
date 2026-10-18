import type { Scenario } from "../../config/types/steps.ts"
import { excludedByProfile } from "../profile.ts"
import { assertScenarios } from "../scenario/validate.ts"
import { authStepOperationIds } from "../scope/entities.ts"
import { GradeLedger } from "../grades.ts"
import { resolveTargetScope } from "../scope/target.ts"
import { type TargetScope } from "../scope/types.ts"
import type { UploadContext } from "../upload.ts"
import type { Connected, Planned } from "./context.ts"

/**
 * What this run grades and what it may call, decided before any principal signs up: a typo in
 * --ops, or a scenario naming an operation it never calls, must cost nothing.
 */
export function planScope(connected: Connected): Planned {
	const { options, model, originClients, profile, progress } = connected
	const authCreates = authStepOperationIds(options.principals)
	const scope = resolveTargetScope(model, {
		...(options.ops === undefined ? {} : { ops: options.ops }),
		...(options.only === undefined ? {} : { only: options.only }),
		authCreates,
		exclusion: { profile: profile.name, reason: (op) => excludedByProfile(op, profile.spec) },
		origins: new Map([...originClients].map(([id, origin]) => [id, origin.model])),
	})
	const ownScenarios = scenariosOf(connected)
	progress.tick({ message: scopeMessage(scope), phase: "load", requests: progress.requests })
	return {
		...connected,
		authCreates,
		grades: new GradeLedger(),
		ownScenarios,
		scenarioOwned: new Set(ownScenarios.flatMap((scenario) => scenario.covers)),
		scope,
		uploads: uploadsOf(connected),
	}
}

/* A scenario that belongs to a secondary origin runs in that origin's run, not here. */
function scenariosOf({ options, model, originClients }: Connected): Scenario[] {
	const own = (options.scenarios ?? []).filter((scenario) => scenario.origin === undefined)
	for (const scenario of options.scenarios ?? []) {
		if (scenario.origin !== undefined && !originClients.has(scenario.origin)) {
			throw new Error(
				`oat: scenario "${scenario.id}" belongs to origin "${scenario.origin}", which is not in config.origins`,
			)
		}
	}
	assertScenarios(own, (id, origin) =>
		origin === undefined
			? model.byOperationId.has(id)
			: originClients.get(origin)?.model.byOperationId.has(id) === true,
	)
	return own
}

function scopeMessage(scope: TargetScope): string {
	if (scope.mode === "full") return "scope: full"
	const entities = scope.entities.length
	return `scope: targeted · ${scope.targets.size} operation(s) · ${entities} entit${entities === 1 ? "y" : "ies"}`
}

function uploadsOf({ options, hooks, seed }: Connected): UploadContext {
	return {
		seed,
		...(options.uploads === undefined ? {} : { uploads: options.uploads }),
		...(options.configDir === undefined ? {} : { configDir: options.configDir }),
		...(hooks.resolveUpload === undefined ? {} : { resolveUpload: hooks.resolveUpload }),
		...(hooks.resolveInput === undefined ? {} : { resolveInput: hooks.resolveInput }),
		...(options.warn === undefined ? {} : { warn: options.warn }),
	}
}

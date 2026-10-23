import type { OatConfig } from "../../config/types/config.ts"
import type { PlanView } from "../../report/console/plan.ts"
import { unsetEnvLines } from "../../report/console/doctor.ts"
import { report } from "../../report/console/report.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { EXIT } from "../../runtime/exit.ts"
import { authStepOperationIds } from "../../runtime/scope/entities.ts"
import { planScope } from "../../runtime/scope/plan.ts"
import { resolveTargetScope } from "../../runtime/scope/target.ts"
import { ScopeError } from "../../runtime/scope/scope-error.ts"
import { type Args, list } from "../flags.ts"
import type { Writer } from "../writer.ts"
import { modelled } from "./spec.ts"

/* What of the config the plan reads: its recipes and principals, and the hook that supplies roots. */
function configView(config: OatConfig | undefined): Pick<PlanView, "credentials" | "hooks"> {
	if (config === undefined) return {}
	return {
		credentials: { principals: config.principals ?? {}, security: config.security ?? {} },
		hooks: config.hooks,
	}
}

/** `oat plan`: the test model derived from the document, offline; targeted when `--ops` or `--only` says. */
export async function commandPlan(writer: Writer, flags: Args["flags"]): Promise<number> {
	const read = await modelled(writer, flags)
	if (typeof read === "number") return read
	const { model, config, unsetEnv } = read
	const ops = list(flags, "ops") ?? config?.ops
	const only = list(flags, "only") ?? config?.only
	const authCreates = authStepOperationIds(config ?? {})
	const scope = targetedScope(model, {
		...(ops === undefined ? {} : { ops }),
		...(only === undefined ? {} : { only }),
		authCreates,
	})
	if (scope instanceof ScopeError) {
		writer.err(`${scope.message}\n`)
		return EXIT.usage
	}
	/* A diagnostic beside the plan, so the plan on stdout stays the plan, as text or JSON. */
	const [note] = unsetEnvLines(unsetEnv)
	if (note !== undefined) writer.err(`${note}\n`)
	writer.out(
		report.plan(model, flags.json === true, {
			authCreates,
			...configView(config),
			scope: scope.mode === "targeted" ? scope : undefined,
			unsetEnv,
		}),
	)
	return 0
}

/** The run's scope over `model`, or the caller's mistake in naming it. Any other error is a bug, and propagates. */
export function targetedScope(
	model: SpecModel,
	input: Parameters<typeof resolveTargetScope>[1],
): ReturnType<typeof planScope> | ScopeError {
	try {
		return planScope(model, resolveTargetScope(model, input))
	} catch (error) {
		if (error instanceof ScopeError) return error
		throw error
	}
}

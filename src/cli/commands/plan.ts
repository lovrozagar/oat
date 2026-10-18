import { report } from "../../report/console/report.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { EXIT } from "../../runtime/exit.ts"
import { authStepOperationIds, planScope, resolveTargetScope, ScopeError } from "../../runtime/scope.ts"
import { type Args, list } from "../flags.ts"
import type { Writer } from "../writer.ts"
import { modelled } from "./spec.ts"

/** `oat plan`: the test model derived from the document, offline; targeted when `--ops` or `--only` says. */
export async function commandPlan(writer: Writer, flags: Args["flags"]): Promise<number> {
	const read = await modelled(writer, flags)
	if (typeof read === "number") return read
	const { model, config } = read
	const ops = list(flags, "ops") ?? config?.ops
	const only = list(flags, "only") ?? config?.only
	const scope = targetedScope(model, {
		...(ops === undefined ? {} : { ops }),
		...(only === undefined ? {} : { only }),
		authCreates: authStepOperationIds(config?.principals ?? []),
	})
	if (scope instanceof ScopeError) {
		writer.err(`${scope.message}\n`)
		return EXIT.usage
	}
	writer.out(report.plan(model, flags.json === true, scope.mode === "targeted" ? scope : undefined))
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

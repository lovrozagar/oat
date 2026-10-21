import type { DefectName } from "../../reference/defects/table.ts"
import type { ReferenceOptions } from "../../reference/http/state.ts"
import type { RunOptions } from "../../runtime/run/index.ts"

/**
 * What a run switches on before a defect can show at all: a reference behavior that is off by
 * default, and the opt-in check that looks for it. Every other defect runs with neither.
 */
export interface OptIn {
	reference: Pick<ReferenceOptions, "throttleLogins">
	run: Pick<RunOptions, "checks">
}

/** The defects that need an opt-in, and theirs. */
const OPT_INS: Partial<Record<DefectName, OptIn>> = {
	/* A throttle that is off never answers 429, and oat sends failed logins only when asked to. */
	LOGIN_NOT_THROTTLED: { reference: { throttleLogins: true }, run: { checks: { "auth.login-throttled": true } } },
}

/** Everything `defects` need switched on, in the reference and in oat, merged. */
export function optInFor(defects: readonly DefectName[]): OptIn {
	return defects.reduce<OptIn>(
		(merged, defect) => {
			const own = OPT_INS[defect]
			if (own === undefined) return merged
			return { reference: { ...merged.reference, ...own.reference }, run: { ...merged.run, ...own.run } }
		},
		{ reference: {}, run: {} },
	)
}

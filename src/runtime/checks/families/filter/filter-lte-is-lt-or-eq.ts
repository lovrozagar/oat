import { defineCheck } from "../../core/define.ts"
import type { Outcome } from "../../../finding.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { FOUNDATIONS } from "../../query/capabilities.ts"
import { assertRangeUnion, rangePlan, type RangeProbe } from "./range.ts"

export const filterLteIsLtOrEq = /* @__PURE__ */ defineCheck<RangeProbe>({
	plan: (ctx) => rangePlan(ctx, "lte", "lt"),
	dependsOn: [
		"query.filter-selects-from-whole-set",
		...FOUNDATIONS,
		"filter.equality-selects-exactly-one",
		"filter.numeric-comparison-is-numeric",
	],
	id: "filter.lte-is-lt-or-eq",
	needs: "an ordered field that allows `lte` and `lt`",
	subjects: subjectsOf.list,
	async run(ctx, probe): Promise<Outcome> {
		return assertRangeUnion(ctx, this.id, probe)
	},
})

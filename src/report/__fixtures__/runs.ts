import type { SavedReport } from "../diff.ts"

/*
 * Two runs of the same backend: one root cause persists under run-specific ids and ports, one is
 * fixed, one is new, a coverage gap is not graded, and table.get went from passed to failed.
 */

const finding = (check: string, detail: string) => ({
	check,
	detail,
	entity: "table",
	evidence: [],
	operations: ["table.list"],
	summary: `${check} broke`,
	verdict: "BACKEND_BUG",
})

export const RUN_A: SavedReport = {
	findings: [
		finding("list.read-after-write", "created tbl_a1b2c (port http://127.0.0.1:4000) is missing"),
		finding("pagination.limit-bounds-page-size", "limit=2 returned 5"),
		{ ...finding("gap", "not graded"), verdict: "COVERAGE_GAP" },
	],
	scope: {
		operations: [
			{ operationId: "table.list", status: "failed" },
			{ operationId: "table.get", status: "passed" },
		],
	},
	targetVersion: { value: "1.0.88" },
}

export const RUN_B: SavedReport = {
	findings: [
		finding("list.read-after-write", "created tbl_z9y8x (port http://127.0.0.1:5123) is missing"),
		finding("filter.unknown-field-rejected", "unknown field ignored"),
	],
	scope: {
		operations: [
			{ operationId: "table.list", status: "failed" },
			{ operationId: "table.get", status: "failed" },
		],
	},
	targetVersion: { value: "1.0.89" },
}

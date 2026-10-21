/* What `oat conformance` runs, loaded only when it runs: none of it is needed for any other command. */

/** The self-test's suites and its defect matrix, read as one module. */
type Suite = typeof import("../../conformance/suites/parser.ts") &
	typeof import("../../conformance/suites/example.ts") &
	typeof import("../../conformance/suites/coverage-report.ts") &
	typeof import("../../conformance/suites/tag-unlock.ts") &
	typeof import("../../conformance/suites/tenant-scope.ts") &
	typeof import("../../conformance/suites/payload-catalog.ts") &
	typeof import("../../conformance/suites/render.ts") &
	typeof import("../../conformance/expected/table.ts") &
	typeof import("../../conformance/matrix/defects.ts") &
	typeof import("../../conformance/matrix/engines.ts") &
	typeof import("../../conformance/matrix/render.ts") &
	typeof import("../../conformance/harness/launch.ts") &
	typeof import("../../conformance/harness/counting.ts")

export interface Toolkit {
	suite: Suite
	pool: typeof import("../../conformance/pool.ts")
	fuzz: typeof import("../../conformance/fuzz.ts")
	shapes: typeof import("../../conformance/shapes.ts")
	seedContract: typeof import("../../conformance/seed-contract.ts")
	effects: typeof import("../../conformance/effects.ts")
	featureGate: typeof import("../../conformance/feature-gate.ts")
	rateLimit: typeof import("../../conformance/rate-limit.ts")
	unique: typeof import("../../conformance/unique.ts")
	dialect: typeof import("../../reference/dialect/presets.ts")
	defects: typeof import("../../reference/defects/table.ts")
}

/** Every module of the self-test, loaded at once. */
export async function loadToolkit(): Promise<Toolkit> {
	const suite = Object.assign(
		{},
		...(await Promise.all([
			import("../../conformance/suites/parser.ts"),
			import("../../conformance/suites/example.ts"),
			import("../../conformance/suites/coverage-report.ts"),
			import("../../conformance/suites/tag-unlock.ts"),
			import("../../conformance/suites/tenant-scope.ts"),
			import("../../conformance/suites/payload-catalog.ts"),
			import("../../conformance/suites/render.ts"),
			import("../../conformance/expected/table.ts"),
			import("../../conformance/matrix/defects.ts"),
			import("../../conformance/matrix/engines.ts"),
			import("../../conformance/matrix/render.ts"),
			import("../../conformance/harness/launch.ts"),
			import("../../conformance/harness/counting.ts"),
		])),
	) as Suite
	const [pool, fuzz, shapes, seedContract, effects, featureGate, rateLimit, unique, dialect, defects] =
		await Promise.all([
			import("../../conformance/pool.ts"),
			import("../../conformance/fuzz.ts"),
			import("../../conformance/shapes.ts"),
			import("../../conformance/seed-contract.ts"),
			import("../../conformance/effects.ts"),
			import("../../conformance/feature-gate.ts"),
			import("../../conformance/rate-limit.ts"),
			import("../../conformance/unique.ts"),
			import("../../reference/dialect/presets.ts"),
			import("../../reference/defects/table.ts"),
		])
	return { defects, dialect, effects, featureGate, fuzz, pool, rateLimit, seedContract, shapes, suite, unique }
}

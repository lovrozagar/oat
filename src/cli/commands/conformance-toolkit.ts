/* What `oat conformance` runs, loaded only when it runs: none of it is needed for any other command. */

export interface Toolkit {
	suite: typeof import("../../conformance/suite.ts")
	pool: typeof import("../../conformance/pool.ts")
	fuzz: typeof import("../../conformance/fuzz.ts")
	shapes: typeof import("../../conformance/shapes.ts")
	seedContract: typeof import("../../conformance/seed-contract.ts")
	effects: typeof import("../../conformance/effects.ts")
	featureGate: typeof import("../../conformance/feature-gate.ts")
	rateLimit: typeof import("../../conformance/rate-limit.ts")
	unique: typeof import("../../conformance/unique.ts")
	dialect: typeof import("../../reference/dialect.ts")
	defects: typeof import("../../reference/defects.ts")
}

/** Every module of the self-test, loaded at once. */
export async function loadToolkit(): Promise<Toolkit> {
	const [suite, pool, fuzz, shapes, seedContract, effects, featureGate, rateLimit, unique, dialect, defects] =
		await Promise.all([
			import("../../conformance/suite.ts"),
			import("../../conformance/pool.ts"),
			import("../../conformance/fuzz.ts"),
			import("../../conformance/shapes.ts"),
			import("../../conformance/seed-contract.ts"),
			import("../../conformance/effects.ts"),
			import("../../conformance/feature-gate.ts"),
			import("../../conformance/rate-limit.ts"),
			import("../../conformance/unique.ts"),
			import("../../reference/dialect.ts"),
			import("../../reference/defects.ts"),
		])
	return { defects, dialect, effects, featureGate, fuzz, pool, rateLimit, seedContract, shapes, suite, unique }
}

import type { Toolkit } from "../commands/conformance-toolkit.ts"

/*
 * A stand-in for the self-test's modules: each suite answers at once with cases a test chooses,
 * and the pool answers each task by its kind. What ran is recorded in order.
 */

/** A case as the stand-in suites report it. */
export interface Case {
	label: string
	failed?: boolean
}

export interface ToolkitOptions {
	/** Cases every suite reports. */
	cases?: Case[]
	sqlite?: boolean
	postgres?: boolean
	d1?: boolean
	/** Cases the shapes task reports. */
	shapes?: Array<{ label: string; problems: string[] }>
	/** Cases each recall task reports. */
	recall?: Array<{ label: string; problems: string[] }>
	/** What each check a leg proves. */
	proven?: string[]
	defectNames?: string[]
	/** Checks no defect proved, as the unproven report names them. */
	unproven?: string[]
}

const rendered = (cases: Case[]) => ({
	failures: cases.filter((one) => one.failed === true).length,
	text: cases.map((one) => `  ${one.failed === true ? "✗" : "✓"} ${one.label}\n`).join(""),
})

/** The stand-in toolkit, and the log of what ran. */
export function fakeToolkit(options: ToolkitOptions = {}): { toolkit: Toolkit; log: string[] } {
	const log: string[] = []
	const cases = options.cases ?? []
	const suite = (name: string) => (): Case[] => {
		log.push(name)
		return cases
	}
	const toolkit = {
		defects: {
			DEFECTS: Object.fromEntries((options.defectNames ?? ["A", "B", "C"]).map((name) => [name, {}])),
			isDefectName: (name: string) => (options.defectNames ?? ["A", "B", "C"]).includes(name),
		},
		dialect: { DIALECTS: { classic: {}, postgrest: {} } },
		effects: { runEffectsSuite: async () => suite("effects")() },
		featureGate: { runFeatureGateSuite: async () => suite("featureGate")() },
		fuzz: {
			renderFuzz: (results: Case[]) => rendered(results),
			renderPrecision: (results: Case[]) => rendered(results),
			runFuzz: async (input: unknown) => (log.push(`fuzz ${JSON.stringify(input)}`), cases),
			runPrecision: async (input: unknown) => (log.push(`precision ${JSON.stringify(input)}`), cases),
		},
		pool: { createPool: (jobs: number) => fakePool(jobs, options, log), defaultJobs: () => 3 },
		rateLimit: { runRateLimitSuite: async () => suite("rateLimit")() },
		seedContract: { runSeedContractSuite: async () => suite("seedContract")() },
		shapes: {
			renderShapeSuite: (shapes: Array<{ label: string; problems: string[] }>, recall?: boolean) => ({
				failures: shapes.filter((one) => one.problems.length > 0).length,
				text: `${recall === true ? "recall" : "shapes"} ${shapes.length}\n`,
			}),
		},
		suite: fakeSuite(options, log),
		unique: { runUniqueSuite: async () => suite("unique")() },
	}
	return { log, toolkit: toolkit as unknown as Toolkit }
}

/** The stand-in suite module: its runners record themselves and report the chosen cases. */
function fakeSuite(options: ToolkitOptions, log: string[]) {
	const cases = options.cases ?? []
	const suite = (name: string) => (): Case[] => {
		log.push(name)
		return cases
	}
	return {
		EXPECTED: { A: "check.a", B: ["check.b", "check.b2"] },
		d1Available: () => options.d1 === true,
		defectsFor: (_backend: string, _dialect: string, only: string[] | undefined) =>
			only ?? ["A", "B", "C", "D", "E", "F", "G"],
		passAnswer: (results: Case[], backend: string, dialect: string) => ({
			baselines: { tagged: [], untagged: [] },
			failures: results.filter((one) => one.failed === true).length,
			primaryOps: {},
			proven: options.proven ?? [],
			text: `leg ${backend}/${dialect} ${results.length}\n`,
		}),
		postgresAvailable: async () => options.postgres === true,
		renderParserSuite: (results: Case[]) => rendered(results),
		renderUnproven: (proven: Set<string>) => ({
			failures: (options.unproven ?? []).filter((id) => !proven.has(id)).length,
			text: `unproven ${[...proven].sort().join(",")}\n`,
		}),
		runCoverageReportSuite: suite("coverage"),
		runExampleSpecSuite: async () => suite("example")(),
		runParserSuite: suite("parser"),
		runPayloadCatalogSuite: suite("payloads"),
		runTagUnlockSuite: async (baselines?: unknown) => (
			log.push(`unlocks ${baselines === undefined ? "own" : "matrix"}`),
			cases
		),
		runTenantScopeSuite: async () => suite("tenant")(),
		sqliteAvailable: async () => options.sqlite === true,
	}
}

/** A pool that answers each task by its kind, and records it. */
function fakePool(jobs: number, options: ToolkitOptions, log: string[]) {
	log.push(`pool ${jobs}`)
	return {
		close: async () => void log.push("pool closed"),
		run: async (task: { kind: string; backend?: string; dialect?: string; defects?: string[] }) => {
			log.push(
				`task ${task.kind}${task.backend === undefined ? "" : ` ${task.backend}/${task.dialect}`}${task.defects === undefined ? "" : ` ${task.defects.length}`}`,
			)
			if (task.kind === "shapes") return { cases: options.shapes ?? [], kind: "cases" }
			if (task.kind === "recall") return { cases: options.recall ?? [], kind: "cases" }
			if (task.kind === "scope") return { kind: "results", results: options.cases ?? [] }
			return { kind: "leg", results: (task.defects ?? ["baseline"]).map((label) => ({ label })) }
		},
	}
}

import { requestLines, sumRequests } from "../../conformance/harness/counting.ts"
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
	/** The shapes, each as its own task judges it: `shape:<name>`, with its problems. */
	shapes?: Array<{ label: string; problems: string[] }>
	/** Defects recalled behind every clean shape. */
	recallDefects?: string[]
	/** Problems a recalled defect reports, by defect name; none for the rest. */
	recallProblems?: Record<string, string[]>
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
			runFuzz: async ({ via, ...input }: { via?: unknown }) => (
				via === undefined ? undefined : reachedBySocket(via),
				log.push(`fuzz ${JSON.stringify(input)}`),
				cases
			),
			runPrecision: async (input: unknown) => (log.push(`precision ${JSON.stringify(input)}`), cases),
		},
		pool: { createPool: (jobs: number) => fakePool(jobs, options, log), defaultJobs: () => 3 },
		rateLimit: { runRateLimitSuite: async () => suite("rateLimit")() },
		seedContract: { runSeedContractSuite: async () => suite("seedContract")() },
		shapes: {
			SHAPE_NAMES: (options.shapes ?? []).map((shape) => shape.label.replace(/^shape:/, "")),
			recallDefects: () => options.recallDefects ?? ["A", "B"],
			renderShapeSuite: (shapes: Array<{ label: string; problems: string[] }>, recall?: boolean) => ({
				failures: shapes.filter((one) => one.problems.length > 0).length,
				text: `${recall === true ? "recall" : "shapes"} ${shapes.length}\n`,
			}),
			waitingRecall: (shape: { label: string }) => ({
				label: `recall:${shape.label.replace(/^shape:/, "")}`,
				problems: ["waits"],
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
		/* A counter that has seen 7 requests, from two sources, on the transport it wraps. */
		counting: (via: unknown) => ({
			requests: () => ({ sources: { "check a": 4, seed: 3 }, total: 7 }),
			via: { counted: via },
		}),
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
		requestLines,
		renderUnproven: (proven: Set<string>) => ({
			failures: (options.unproven ?? []).filter((id) => !proven.has(id)).length,
			text: `unproven ${[...proven].sort().join(",")}\n`,
		}),
		runCoverageReportSuite: suite("coverage"),
		runExampleSpecSuite: async () => suite("example")(),
		runParserSuite: suite("parser"),
		runPayloadCatalogSuite: suite("payloads"),
		listening: LISTENING,
		runTagUnlockSuite: async (via: unknown, baselines?: unknown) => (
			reachedBySocket(via),
			log.push(`unlocks ${baselines === undefined ? "own" : "matrix"}`),
			cases
		),
		runTenantScopeSuite: async (via: unknown) => (reachedBySocket(via), suite("tenant")()),
		sqliteAvailable: async () => options.sqlite === true,
		sumRequests,
	}
}

/* The commands run the suites behind a socket: the transport the gate tests. */
const LISTENING = { host: async () => undefined, launch: async () => undefined }

/* Reached behind the socket, counted or not. */
function reachedBySocket(via: unknown): void {
	const inner = (via as { counted?: unknown } | undefined)?.counted ?? via
	if (inner !== LISTENING) throw new Error("a suite was not given the socket transport")
}

/** A pool that answers each task by its kind, and records it. */
function fakePool(jobs: number, options: ToolkitOptions, log: string[]) {
	log.push(`pool ${jobs}`)
	const memory = { heapUsed: 50 * 2 ** 20, rss: 300 * 2 ** 20 }
	/* Every task sent 10 requests, from two sources. */
	const requests = { sources: { "check a": 6, seed: 4 }, total: 10 }
	return {
		close: async () => void log.push("pool closed"),
		run: async (task: {
			kind: string
			backend?: string
			dialect?: string
			defects?: string[]
			name?: string
			shape?: string
		}) => {
			const where = task.backend === undefined ? "" : ` ${task.backend}/${task.dialect}`
			log.push(
				`task ${task.kind}${where}${task.name === undefined ? "" : ` ${task.name}`}${task.shape === undefined ? "" : ` ${task.shape}`}${task.defects === undefined ? "" : ` ${task.defects.length}`}`,
			)
			if (task.kind === "shape-reference") return { checks: ["c1"], kind: "reference", memory, requests }
			if (task.kind === "shape") {
				const shape = (options.shapes ?? []).find((one) => one.label === `shape:${task.name}`)
				return { cases: shape === undefined ? [] : [shape], kind: "cases", memory, requests }
			}
			if (task.kind === "recall") {
				const cases = (task.defects ?? []).map((defect) => ({
					label: `recall:${task.shape}:${defect}`,
					problems: options.recallProblems?.[defect] ?? [],
				}))
				return { cases, kind: "cases", memory, requests }
			}
			if (task.kind === "scope") return { kind: "results", memory, requests, results: options.cases ?? [] }
			return { kind: "leg", memory, requests, results: (task.defects ?? ["baseline"]).map((label) => ({ label })) }
		},
	}
}

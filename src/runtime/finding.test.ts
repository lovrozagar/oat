import { describe, expect, it } from "vitest"
import type { Exchange } from "./exchange.ts"
import { asserted, FindingCollector, isFailingRootCause, isRootCause } from "./finding.ts"

describe("finding attribution", () => {
	it("an attributed view shares the collector and stamps its operations", () => {
		const root = new FindingCollector()
		const view = root.attributed(["row.list"])
		view.backend("filter.in-is-union-of-eq", "row", { summary: "s", detail: "d", evidence: [] })
		view.unresolved("sort.order-is-applied", "row", "no field")
		view.gap("world.seed", "row", { summary: "s", detail: "d" })
		expect(root.findings.map((f) => f.operations)).toEqual([["row.list"], ["row.list"]])
		expect(root.inconclusive).toEqual([
			{ check: "sort.order-is-applied", entity: "row", operations: ["row.list"], reason: "no field" },
		])
	})

	it("an explicit attribution wins over the view's default", () => {
		const root = new FindingCollector()
		root
			.attributed(["job.start", "job.other"])
			.attributed(["job.start"])
			.spec("effects.x", "job", { summary: "s", detail: "d", evidence: [] })
		expect(root.findings[0]?.operations).toEqual(["job.start"])
	})

	it("leaves run-level findings unattributed", () => {
		const root = new FindingCollector()
		root.gap("world.teardown", "run", { summary: "s", detail: "d" })
		root.unresolved("net", "run", "down")
		expect(root.findings[0]?.operations).toBeUndefined()
		expect(root.inconclusive[0]).toEqual({ check: "net", entity: "run", reason: "down" })
	})

	it("blocked carries evidence", () => {
		const root = new FindingCollector()
		const exchange = { method: "POST", status: 500 } as never
		root
			.attributed(["row.list"])
			.blocked("world.seed", "row", { summary: "s", cause: "support table.create failed (500)", evidence: [exchange] })
		expect(root.findings[0]).toMatchObject({
			detail: "blocked by support table.create failed (500)",
			evidence: [exchange],
			operations: ["row.list"],
			verdict: "BLOCKED",
		})
	})
})

describe("a check's own findings", () => {
	it("cannot be filed under another check's id", () => {
		const findings = new FindingCollector().ownedBy("sort.order-is-applied")
		expect(() => findings.gap("filter.unknown-field-rejected", "row", { summary: "s", detail: "d" })).toThrow(
			/tried to report under/,
		)
		expect(() => findings.unresolved("filter.unknown-field-rejected", "row", "r")).toThrow(/tried to report under/)
		findings.attributed(["row.list"]).gap("sort.order-is-applied", "row", { summary: "s", detail: "d" })
		expect(findings.findings).toHaveLength(1)
	})
})

describe("what a finding may say", () => {
	const cwd = process.cwd()
	const stack = "TypeError: x is not a function\n    at run (/home/ann/oat/src/a.ts:3:9)\n\tat async /Users/bo/b.ts:1:1"
	const pathy = `open '${cwd}/specs/a.yaml' then /home/ann/x/spec.yaml:3 and C:\\Users\\cy\\c.ts, file:///root/d.ts`
	const clean = "open './specs/a.yaml' then spec.yaml:3 and c.ts, d.ts"
	const evidence: Exchange[] = []
	const recorders: Record<string, (findings: FindingCollector) => unknown> = {
		backend: (f) => f.backend("c", "row", { detail: pathy, evidence, summary: stack }),
		blocked: (f) => f.blocked("c", "row", { cause: pathy, summary: stack }),
		gap: (f) => f.gap("c", "row", { detail: pathy, summary: stack }),
		report: (f) =>
			f.report({ check: "c", detail: pathy, entity: "row", evidence, summary: stack, verdict: "AMBIGUITY" }),
		security: (f) => f.security("c", "row", { detail: pathy, evidence, summary: stack }),
		spec: (f) => f.spec("c", "row", { detail: pathy, evidence, summary: stack }),
	}

	it.each(Object.keys(recorders))("%s drops stack frames and every user path", (method) => {
		const findings = new FindingCollector()
		recorders[method]?.(findings)
		const [finding] = findings.findings
		expect(finding?.summary).toBe("TypeError: x is not a function")
		expect(finding?.detail).toMatch(new RegExp(`${clean.replaceAll(/[.*+?()\\]/g, String.raw`\$&`)}$`))
	})

	it("unresolved does the same to its reason, in the record and the outcome", () => {
		const findings = new FindingCollector()
		const outcome = findings.unresolved("c", "row", `${stack}: ${pathy}`)
		const said = `TypeError: x is not a function`
		expect(findings.inconclusive[0]?.reason).toBe(said)
		expect(outcome).toEqual({ kind: "unresolved", reason: said })
	})

	it("keeps API routes, and rewrites the cwd only as a whole path", () => {
		const findings = new FindingCollector()
		findings.unresolved("c", "row", `GET /rows/{id} and /roots/1 in ${cwd}. not ${cwd}2/x or ${cwd}.bak`)
		const reason = findings.inconclusive[0]?.reason
		expect(reason).toMatch(/^GET \/rows\/\{id\} and \/roots\/1 in \.\. not /)
		expect(reason).not.toMatch(/\.2\/x|\.\.bak/)
	})
})

describe("verdicts and outcomes", () => {
	it("a root cause is what oat found, and fails the run unless a baseline knows it", () => {
		expect(isRootCause({ verdict: "BACKEND_BUG" })).toBe(true)
		expect(isRootCause({ verdict: "COVERAGE_GAP" })).toBe(false)
		expect(isRootCause({ verdict: "BLOCKED" })).toBe(false)
		expect(isFailingRootCause({ verdict: "SECURITY" })).toBe(true)
		expect(isFailingRootCause({ known: { reason: "r" }, verdict: "SECURITY" })).toBe(false)
		expect(isFailingRootCause({ verdict: "BLOCKED" })).toBe(false)
	})

	it("each recorder answers with the outcome its verdict means", () => {
		const findings = new FindingCollector()
		expect(asserted("ignored")).toEqual({ kind: "asserted", note: "ignored" })
		expect(findings.backend("c", "row", { detail: "d", evidence: [], summary: "s" })).toEqual({
			kind: "finding",
			verdict: "BACKEND_BUG",
		})
		expect(findings.gap("c", "row", { detail: "d", summary: "s" })).toEqual({ kind: "stood-down", reason: "s" })
		expect(findings.blocked("c", "row", { cause: "x", summary: "s" })).toEqual({ kind: "unresolved", reason: "s" })
		expect(findings.byVerdict("COVERAGE_GAP").map((f) => f.verdict)).toEqual(["COVERAGE_GAP"])
	})

	it("names the fixture when one drove the invocation, and keeps operations a finding names itself", () => {
		const findings = new FindingCollector().attributed(["row.list"])
		findings.spec("c", "row", { detail: "d", evidence: [], fixture: "a.png", summary: "s" })
		findings.spec("c", "row", { detail: "d", evidence: [], fixture: "", summary: "s" })
		findings.report({
			check: "c",
			detail: "d",
			entity: "row",
			evidence: [],
			operations: [],
			summary: "s",
			verdict: "AMBIGUITY",
		})
		expect(findings.findings.map((f) => [f.fixture, f.operations])).toEqual([
			["a.png", ["row.list"]],
			[undefined, ["row.list"]],
			[undefined, []],
		])
	})
})

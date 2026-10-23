import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../spec/types.ts"
import { CHECK_IDS, familyOf } from "../check-ids.ts"
import { contextFor, modelOf, op } from "./__fixtures__/harness.ts"
import { entityChecks, validateRegistry } from "./core/registry.ts"
import { runCheck } from "./core/run.ts"
import { widgetApi, widgetDoc } from "./families/write/__fixtures__/widget-api.ts"
import { CHECKS } from "./registry.ts"

/*
 * The registry is the run order. Every check id is there once, each after the checks it depends
 * on, so cascade suppression has their results to consult; the foundations come first and the
 * checks that judge the whole transcript come last, after everything that writes to it.
 */

const at = (id: string): number => CHECKS.findIndex((check) => check.id === id)

describe("the check registry", () => {
	it("holds every id it names, once, with each dependency registered earlier", () => {
		expect(() => validateRegistry(CHECKS)).not.toThrow()
		expect(new Set(CHECKS.map((check) => check.id))).toEqual(new Set(CHECK_IDS))
		expect(CHECKS).toHaveLength(CHECK_IDS.length)
	})

	it("puts every check in a family", () => {
		for (const id of CHECK_IDS) expect(familyOf(id)).toBeTypeOf("string")
	})

	it("runs the foundations before the checks that rely on them", () => {
		expect(at("create.keeps-submitted-identity")).toBe(0)
		expect(at("list.read-after-write")).toBeLessThan(at("filter.equality-selects-exactly-one"))
		expect(at("pagination.page-walk-covers-set")).toBeLessThan(at("sort.reverse-symmetry"))
	})

	it("judges the transcript last, after every check that writes to it", () => {
		const last = CHECKS.slice(-4).map((check) => check.id)
		expect(last).toEqual([
			"response.status-is-documented",
			"schema.error-response-matches-document",
			"schema.problem-json-shape",
			"spec.declared-rate-limit-is-honoured",
		])
		for (const check of entityChecks(CHECKS).slice(-4)) expect(check.judgesTranscript).toBe(true)
		/* The precondition check writes the 412 the status and problem judges read. */
		expect(at("concurrency.if-match-enforced")).toBe(at("response.status-is-documented") - 1)
	})
})

/* The checks the precondition checks brought in, and the widget document with a rate each judge reads. */
const PRECONDITION_CHECKS: ReadonlySet<string> = new Set(["concurrency.if-match-enforced", "schema.problem-json-shape"])

function judgedDocument(): OpenApiDocument {
	const doc = widgetDoc() as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> }
	const read = doc.paths["/widgets/{id}"]?.["get"]
	if (read !== undefined) read["x-rate-limit"] = { category: "reads", rps: 5 }
	return doc as unknown as OpenApiDocument
}

describe("registering the precondition checks", () => {
	/*
	 * An entity check's salts are drawn from its place among the entity checks, and they are what its
	 * bodies hold, so a check registered between two others changes what every later one sends. The
	 * precondition checks sit among the transcript judges only, and no judge draws a salt.
	 */
	it("moves no salt: every check whose place moved is a transcript judge that draws none", async () => {
		const now = entityChecks(CHECKS)
		const before = now.filter((check) => !PRECONDITION_CHECKS.has(check.id))
		const moved = before.filter((check, index) => now.indexOf(check) !== index)
		expect(moved.map((check) => check.id)).toEqual([
			"response.status-is-documented",
			"schema.error-response-matches-document",
			"spec.declared-rate-limit-is-honoured",
		])
		const model = modelOf(judgedDocument())
		const { ctx } = contextFor(model, "listWidgets", {
			respond: widgetApi(new Map([["w1", { id: "w1", name: "n" }]])),
			fields: { createOp: op(model, "createWidget"), readOp: op(model, "getWidget") },
		})
		for (const [path, operationId] of [
			["/widgets", "createWidget"],
			["/widgets/w1", "getWidget"],
		] as const) {
			await ctx.client.request("GET", path, { as: { principal: "alpha" }, operationId })
		}
		const drawn: string[] = []
		const judges = [...moved, ...now.filter((judge) => judge.id === "schema.problem-json-shape")]
		const outcomes: string[] = []
		for (const judge of judges) {
			const outcome = await runCheck(judge, {
				...ctx,
				nextSalt: () => {
					drawn.push(judge.id)
					return "drawn"
				},
			})
			outcomes.push(`${judge.id}: ${outcome.kind}`)
		}
		/* No answer here is a problem detail, so that judge has nothing to judge and stands down. */
		expect(outcomes).toEqual([
			...moved.map((judge) => `${judge.id}: asserted`),
			"schema.problem-json-shape: stood-down",
		])
		expect(drawn).toEqual([])
	})
})

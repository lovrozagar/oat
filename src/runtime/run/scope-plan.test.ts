import { describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../progress/types.ts"
import { connected, notesApi, notesDoc, optionsFor } from "./__fixtures__/api.ts"
import { uploadMemory } from "../upload.ts"
import { planScope } from "./scope-plan.ts"
import type { RunOptions } from "./types.ts"

/*
 * What a run grades and may call, decided before anyone signs up: a scenario that names an
 * operation no document has, or an origin nobody configured, is refused before a request.
 */

const OTHER = {
	baseUrl: "http://other.test",
	id: "other",
	security: { bearer: "bearer" },
	spec: "http://other.test/openapi.json",
}

/** Notes, plus a tag collection: two entities to target. */
const twoEntities = notesDoc({
	"/tags": {
		get: {
			operationId: "tags.list",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
						},
					},
					description: "ok",
				},
			},
		},
	},
})

const resolveUpload = async (): Promise<null> => null
const resolveInput = async (): Promise<null> => null
const warn = (): undefined => undefined

async function plannedWith(extra: Partial<RunOptions>) {
	const snaps: ProgressSnapshot[] = []
	const run = await connected(optionsFor(notesApi(twoEntities), { ...extra, onProgress: (snap) => snaps.push(snap) }))
	return { planned: planScope(run), snaps }
}

describe("planScope", () => {
	it("grades everything in a full run, and says so", async () => {
		const { planned, snaps } = await plannedWith({})
		expect(planned.scope.mode).toBe("full")
		expect(snaps.at(-1)).toMatchObject({ message: "scope: full", phase: "load" })
		expect(planned.ownScenarios).toEqual([])
		expect(planned.uploads).toEqual({ memory: uploadMemory(), seed: 1 })
	})

	it("names a targeted run's operations and entities", async () => {
		const one = await plannedWith({ ops: ["notes.list"] })
		expect(one.snaps.at(-1)?.message).toBe("scope: targeted · 1 operation(s) · 1 entity")
		const both = await plannedWith({ only: ["note", "tag"] })
		expect(both.snaps.at(-1)?.message).toMatch(/^scope: targeted · \d+ operation\(s\) · 2 entities$/)
	})
})

describe("planScope scenarios", () => {
	it("keeps this origin's scenarios, and what they cover", async () => {
		const scenario = { covers: ["notes.create"], id: "s1", steps: [{ operationId: "notes.create" }] }
		const { planned } = await plannedWith({
			origins: [OTHER],
			scenarios: [scenario, { ...scenario, id: "s2", origin: "other" }] as never,
		})
		expect(planned.ownScenarios.map((own) => own.id)).toEqual(["s1"])
		expect(planned.scenarioOwned).toEqual(new Set(["notes.create"]))
	})

	it("refuses a scenario of an origin that is not configured", async () => {
		const run = await connected(
			optionsFor(notesApi(), { scenarios: [{ covers: [], id: "s1", origin: "gone", steps: [] }] as never }),
		)
		expect(() => planScope(run)).toThrow('oat: scenario "s1" belongs to origin "gone", which is not in config.origins')
	})

	it("refuses a scenario that names an operation its document lacks", async () => {
		const missing = { covers: ["no.such"], id: "s1", steps: [{ operationId: "no.such" }] }
		const run = await connected(
			optionsFor(notesApi(), { origins: [OTHER], scenarios: [missing, { ...missing, origin: "other" }] as never }),
		)
		expect(() => planScope(run)).toThrow(/no\.such/)
	})

	it("refuses a step on an origin that is not configured", async () => {
		const stray = { covers: [], id: "s1", steps: [{ operationId: "notes.list", origin: "gone" }] }
		const run = await connected(optionsFor(notesApi(), { scenarios: [stray] as never }))
		expect(() => planScope(run)).toThrow('calls notes.list, which is not in the "gone" origin\'s document')
	})

	it("gives uploads everything that resolves them", async () => {
		const { planned } = await plannedWith({
			configDir: "/cfg",
			hooks: { resolveInput, resolveUpload } as never,
			uploads: { "notes.create": "a.png" } as never,
			warn,
		})
		expect(planned.uploads).toEqual({
			configDir: "/cfg",
			memory: uploadMemory(),
			resolveInput,
			resolveUpload,
			seed: 1,
			uploads: { "notes.create": "a.png" },
			warn,
		})
	})
})

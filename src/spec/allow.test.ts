import { describe, expect, it } from "vitest"
import type { Principal } from "../config/types/principals.ts"
import type { Scenario } from "../config/types/steps.ts"
import { UsageError } from "../errors/usage-error.ts"
import { assertAllowedReferences, pruneToAllow } from "./allow.ts"
import type { OpenApiDocument } from "./types.ts"

const doc = {
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/notes": {
			get: { operationId: "note.list" },
			parameters: [],
			post: { operationId: "note.create" },
		},
		"/notes/{id}": { delete: {}, get: { operationId: "note.read" } },
		"/odd": "not a path item",
		"/tags": { get: { operationId: "tag.list" }, put: "not an operation" },
	},
} as unknown as OpenApiDocument

describe("pruneToAllow", () => {
	it("removes every operation the allowlist leaves out, and path items left empty", () => {
		const { doc: pruned, removed } = pruneToAllow(doc, ["note.list", "DELETE /notes/{id}"])
		expect(removed).toEqual(["note.create", "note.read", "tag.list"])
		expect(pruned.paths).toEqual({
			"/notes": { get: { operationId: "note.list" }, parameters: [] },
			"/notes/{id}": { delete: {} },
			"/odd": "not a path item",
		})
		expect(doc.paths?.["/tags"]).toBeDefined()
	})

	it("refuses an allowlist naming an operation the document does not have", () => {
		expect(() => pruneToAllow(doc, ["note.list", "nope", "GET /x"])).toThrow(
			new UsageError('allow names "nope", "GET /x", which the document does not have'),
		)
	})

	it("reads a document without paths as having no operations", () => {
		expect(pruneToAllow({ openapi: "3.1.0" }, [])).toEqual({ doc: { openapi: "3.1.0" }, removed: [] })
	})
})

const kept: ReadonlySet<string> = new Set(["login", "note.list"])
const step = (operationId: string, origin?: string) => ({ operationId, ...(origin === undefined ? {} : { origin }) })

describe("assertAllowedReferences", () => {
	it("accepts a config that calls only kept operations, or calls elsewhere", () => {
		const principals = [
			{ auth: { refresh: { steps: [step("login")] }, steps: [step("login"), step("sso", "https://idp")] }, id: "a" },
			{ auth: { token: "t" }, id: "b" },
			{ id: "c" },
			{ auth: { steps: [{ request: {} }] }, id: "d" },
		] as unknown as Principal[]
		const scenarios = [
			{ covers: ["note.list"], id: "s", steps: [step("note.list"), { wait: 1 }, step("x", "https://other")] },
			{ covers: ["gone"], id: "remote", origin: "https://other", steps: [step("gone")] },
		] as unknown as Scenario[]
		expect(() => assertAllowedReferences(kept, { principals, scenarios })).not.toThrow()
		expect(() => assertAllowedReferences(kept, {})).not.toThrow()
	})

	it("names every removed operation the config still calls, once each", () => {
		const principals = [
			{ auth: { refresh: { steps: [step("renew")] }, steps: [step("signin")] }, id: "a" },
			{ auth: { steps: [step("signin")] }, id: "a" },
		] as unknown as Principal[]
		const scenarios = [{ covers: ["note.read"], id: "s", steps: [step("note.create")] }] as unknown as Scenario[]
		expect(() => assertAllowedReferences(kept, { principals, scenarios })).toThrow(
			new UsageError(
				'allow removes operations the config still calls: principal "a" auth step "signin"; ' +
					'principal "a" auth step "renew"; scenario "s" step "note.create"; scenario "s" covers "note.read"',
			),
		)
	})
})

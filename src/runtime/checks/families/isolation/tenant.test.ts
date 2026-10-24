import { describe, expect, it } from "vitest"
import { modelOf, op } from "../../__fixtures__/harness.ts"
import { notesDocument } from "./__fixtures__/notes.ts"
import { tenantBoundary } from "./tenant.ts"

describe("tenantBoundary", () => {
	it("is false without an operation", () => {
		expect(tenantBoundary(undefined)).toBe(false)
	})

	it("holds for a tenant tagged with x-tenant", () => {
		const model = modelOf(notesDocument({ root: "/spaces/{space}", tenant: "space" }))
		expect(tenantBoundary(op(model, "readNote"))).toBe(true)
	})

	it("holds for a tenant inferred from a tenant-named path parameter", () => {
		expect(tenantBoundary(op(modelOf(notesDocument()), "readNote"))).toBe(true)
	})

	it("is false for a shared catalog under a project path, tagged x-tenant: false", () => {
		expect(tenantBoundary(op(modelOf(notesDocument({ tenant: false })), "readNote"))).toBe(false)
	})

	it("is false when no path parameter names a tenant", () => {
		expect(tenantBoundary(op(modelOf(notesDocument({ root: "/shelves/{shelf}" })), "readNote"))).toBe(false)
	})
})

describe("tenantBoundary on a hand-built operation", () => {
	it("is false when the operation states neither a tenant source nor a parameter", () => {
		const read = op(modelOf(notesDocument({ root: "/shelves/{shelf}" })), "readNote")
		expect(tenantBoundary({ ...read, tenantParam: undefined as unknown as null, tenantSource: null })).toBe(false)
		expect(tenantBoundary({ ...read, tenantParam: "shelf", tenantSource: null })).toBe(true)
	})
})

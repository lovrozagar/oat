import { describe, expect, it } from "vitest"
import { operationName, resolveOperationName } from "./operation-name.ts"

const names = new Set(["notes.list", "POST /notes", "DELETE /notes/{id}"])

describe("operationName", () => {
	it("is the operationId, or METHOD /path with the method uppercased when the document gives none", () => {
		expect(operationName("get", "/notes", "notes.list")).toBe("notes.list")
		expect(operationName("post", "/notes", undefined)).toBe("POST /notes")
	})
})

describe("resolveOperationName", () => {
	it("resolves an operationId, and METHOD /path in any case of the method", () => {
		expect(resolveOperationName("notes.list", names)).toBe("notes.list")
		expect(resolveOperationName("POST /notes", names)).toBe("POST /notes")
		expect(resolveOperationName("post /notes", names)).toBe("POST /notes")
		expect(resolveOperationName("Delete /notes/{id}", names)).toBe("DELETE /notes/{id}")
	})

	it("matches the path template exactly, and only a method a path item can declare", () => {
		expect(resolveOperationName("POST /notes/", names)).toBeUndefined()
		expect(resolveOperationName("POST /Notes", names)).toBeUndefined()
		expect(resolveOperationName("delete /notes/{noteId}", names)).toBeUndefined()
		expect(resolveOperationName("fetch /notes", new Set(["FETCH /notes"]))).toBeUndefined()
		expect(resolveOperationName(" /notes", names)).toBeUndefined()
		expect(resolveOperationName("notes.lsit", names)).toBeUndefined()
	})

	it("names an operation that has an operationId by that id alone", () => {
		expect(resolveOperationName("GET /notes", names)).toBeUndefined()
	})
})

import { describe, expect, it } from "vitest"
import { REDACTED, Redactor } from "../../security/redact.ts"
import { formFieldPart, formFilePart } from "./form-parts.ts"

describe("formFieldPart", () => {
	it("keeps a field's value, unless the field names a secret", () => {
		const redactor = new Redactor()
		expect(formFieldPart("note", "hello", redactor)).toEqual({ field: "note", value: "hello" })
		expect(formFieldPart("password", "hunter2", redactor)).toEqual({ field: "password", value: REDACTED })
	})

	it("scrubs a placed credential's value, and a field named like a placed query credential", () => {
		const redactor = new Redactor()
		redactor.registerSecret("issued-token-value")
		redactor.registerQuery("api_key")
		expect(formFieldPart("note", "sent issued-token-value", redactor)).toEqual({
			field: "note",
			value: `sent ${REDACTED}`,
		})
		expect(formFieldPart("api_key", "k", redactor)).toEqual({ field: "api_key", value: REDACTED })
	})
})

describe("formFilePart", () => {
	it("keeps a file by name, type, size and hash", () => {
		const file = new File(["abc"], "a.txt", { type: "text/plain" })
		expect(formFilePart("doc", file, { bytes: 3, sha256: "h" })).toEqual({
			bytes: 3,
			field: "doc",
			filename: "a.txt",
			mediaType: "text/plain",
			sha256: "h",
		})
		expect(formFilePart("doc", new File(["x"], "b"), { bytes: 1, sha256: "h" })).toMatchObject({
			mediaType: "application/octet-stream",
		})
	})
})

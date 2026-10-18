import { describe, expect, it } from "vitest"
import { REDACTED } from "../../security/redact.ts"
import { formFieldPart, formFilePart } from "./form-parts.ts"

describe("formFieldPart", () => {
	it("keeps a field's value, unless the field names a secret", () => {
		expect(formFieldPart("note", "hello")).toEqual({ field: "note", value: "hello" })
		expect(formFieldPart("password", "hunter2")).toEqual({ field: "password", value: REDACTED })
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

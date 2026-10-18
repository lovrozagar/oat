import { describe, expect, it } from "vitest"
import type { OperationObject } from "../types.ts"
import { readCleanup, readInvalidate } from "./routes.ts"

describe("route tags", () => {
	it("reads x-invalidate as normalised routes, keeping what is not one trimmed", () => {
		const op = { "x-invalidate": [" get /v1/notes/:id ", 1, "  stray  ", "GET /v1/notes/{id}"] } as OperationObject
		expect(readInvalidate(op)).toEqual(["GET /v1/notes/{id}", "stray", "GET /v1/notes/{id}"])
		expect(readInvalidate({ "x-invalidate": "GET /x" } as OperationObject)).toEqual([])
	})

	it("reads x-cleanup as one route", () => {
		expect(readCleanup({ "x-cleanup": "delete /v1/notes/:id" } as OperationObject)).toBe("DELETE /v1/notes/{id}")
		expect(readCleanup({ "x-cleanup": 1 } as OperationObject)).toBeNull()
	})
})

import { describe, expect, it } from "vitest"
import type { OperationObject } from "../types.ts"
import { readAsync, readWait } from "./async.ts"

const op = (tags: Record<string, unknown>) => tags as OperationObject

describe("x-async", () => {
	it("reads the poll target with defaults, and its optional pointers", () => {
		expect(readAsync(op({ "x-async": { poll: "job.get" } }))).toEqual({
			poll: "job.get",
			pollIntervalMs: 2000,
			timeoutMs: 120_000,
		})
		expect(
			readAsync(
				op({
					"x-async": {
						idFrom: "$.id",
						poll: "job.get",
						pollIntervalMs: 5,
						successWhen: "$.ok",
						timeoutMs: 9,
						until: "$.done",
					},
				}),
			),
		).toEqual({
			idFrom: "$.id",
			poll: "job.get",
			pollIntervalMs: 5,
			successWhen: "$.ok",
			timeoutMs: 9,
			until: "$.done",
		})
	})

	it("is null without a poll target", () => {
		expect(readAsync(op({}))).toBeNull()
		expect(readAsync(op({ "x-async": { poll: 1 } }))).toBeNull()
	})
})

describe("x-wait", () => {
	it("reads the operation with defaults, keeping only positive timings", () => {
		expect(readWait(op({ "x-wait": { operationId: "note.get" } }))).toEqual({
			operationId: "note.get",
			pollIntervalMs: 1000,
			timeoutMs: 30_000,
		})
		expect(
			readWait(op({ "x-wait": { operationId: "note.get", pollIntervalMs: 0, timeoutMs: -1, until: "" } })),
		).toEqual({
			operationId: "note.get",
			pollIntervalMs: 1000,
			timeoutMs: 30_000,
		})
		expect(
			readWait(op({ "x-wait": { operationId: "note.get", pollIntervalMs: 5, timeoutMs: 9, until: "$.x" } })),
		).toEqual({
			operationId: "note.get",
			pollIntervalMs: 5,
			timeoutMs: 9,
			until: "$.x",
		})
	})

	it("is null without an operation", () => {
		expect(readWait(op({}))).toBeNull()
		expect(readWait(op({ "x-wait": { operationId: "" } }))).toBeNull()
		expect(readWait(op({ "x-wait": { operationId: 1 } }))).toBeNull()
	})
})

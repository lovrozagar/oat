import { describe, expect, it } from "vitest"
import type { OperationObject } from "../types.ts"
import { documentsEventStream, successSchema } from "./responses.ts"

const json = (schema?: unknown) => ({ content: { "application/json": schema === undefined ? {} : { schema } } })

describe("successSchema", () => {
	it("takes the first JSON schema among the success codes, in order", () => {
		const op = {
			responses: {
				"201": json({ type: "object" }),
				"200": { content: { "text/plain": { schema: { type: "string" } }, "application/problem+json": {} } },
				default: json({ type: "array" }),
			},
		} as OperationObject
		expect(successSchema(op)).toEqual({ type: "object" })
		expect(successSchema({ responses: { "2XX": json({ type: "string" }) } } as OperationObject)).toEqual({
			type: "string",
		})
	})

	it("is null without one", () => {
		expect(successSchema({} as OperationObject)).toBeNull()
		expect(
			successSchema({ responses: { "200": { description: "ok" }, "404": json({}) } } as OperationObject),
		).toBeNull()
	})
})

describe("documentsEventStream", () => {
	it("is true when a success response lists text/event-stream", () => {
		const stream = { content: { "text/event-stream; charset=utf-8": {} } }
		expect(documentsEventStream({ responses: { "200": stream } } as OperationObject)).toBe(true)
		expect(documentsEventStream({ responses: { "2XX": stream } } as OperationObject)).toBe(true)
		expect(documentsEventStream({ responses: { default: stream } } as OperationObject)).toBe(true)
	})

	it("is false otherwise", () => {
		const stream = { content: { "text/event-stream": {} } }
		expect(documentsEventStream({} as OperationObject)).toBe(false)
		expect(documentsEventStream({ responses: { "400": stream } } as OperationObject)).toBe(false)
		expect(
			documentsEventStream({ responses: { "200": json({}), "204": { description: "none" } } } as OperationObject),
		).toBe(false)
		expect(documentsEventStream({ responses: { "200": null } } as unknown as OperationObject)).toBe(false)
	})
})

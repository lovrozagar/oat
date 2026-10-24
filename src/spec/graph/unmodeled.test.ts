import { describe, expect, it } from "vitest"
import { GapCollector } from "../extensions/gaps.ts"
import type { OpenApiDocument } from "../types.ts"
import { recordUnmodeled } from "./unmodeled.ts"

function gapsOf(doc: Record<string, unknown>) {
	const gaps = new GapCollector()
	recordUnmodeled({ openapi: "3.1.0", ...doc } as OpenApiDocument, gaps)
	return gaps.gaps
}

/* The gap each kind records, spelled out once so every case asserts the exact wording. */
const webhook = (name: string) => ({
	detail: "is a call the API sends to a subscriber's URL; oat receives no inbound call",
	operationId: `webhook ${name}`,
	tag: "webhooks",
})
const callback = (operationId: string, name: string) => ({
	detail: `declares callback "${name}", a call the API makes back to a URL the request names`,
	operationId,
	tag: "callbacks",
})
const link = (operationId: string, status: string, name: string) => ({
	detail: `response ${status} links "${name}" to a follow-up call oat does not make`,
	operationId,
	tag: "links",
})
const additional = (operationId: string, method: string) => ({
	detail: `declares method ${method} under additionalOperations, which oat does not send`,
	operationId,
	tag: "additionalOperations",
})

describe("recordUnmodeled", () => {
	it("records nothing for a document that declares none of them", () => {
		expect(gapsOf({})).toEqual([])
		expect(gapsOf({ paths: { "/a": { get: { operationId: "a.get", responses: { "200": {} } } } } })).toEqual([])
	})

	it("records one gap per top-level webhook", () => {
		const webhooks = { petAdopted: { post: {} }, petLost: { post: {} } }
		expect(gapsOf({ webhooks })).toEqual([webhook("petAdopted"), webhook("petLost")])
	})

	it("records one gap per callback an operation declares, under the operation's id", () => {
		const paths = {
			"/subscriptions": { post: { callbacks: { onEvent: {}, onError: {} }, operationId: "subscribe" } },
			"/plain": { put: { callbacks: { onDone: {} } } },
		}
		expect(gapsOf({ paths })).toEqual([
			callback("subscribe", "onEvent"),
			callback("subscribe", "onError"),
			callback("PUT /plain", "onDone"),
		])
	})

	it("records one gap per response link, naming the status", () => {
		const responses = {
			"201": { links: { GetUser: { operationId: "users.get" }, ListPets: {} } },
			"404": { description: "missing" },
			default: { links: { Retry: {} } },
		}
		expect(gapsOf({ paths: { "/users": { post: { operationId: "users.create", responses } } } })).toEqual([
			link("users.create", "201", "GetUser"),
			link("users.create", "201", "ListPets"),
			link("users.create", "default", "Retry"),
		])
	})

	it("records one gap per additionalOperations method, named by its id or its method and path", () => {
		const paths = {
			"/files/{id}": {
				additionalOperations: { COPY: {}, LINK: { operationId: "files.link" } },
				get: { operationId: "files.get" },
			},
		}
		expect(gapsOf({ paths })).toEqual([additional("COPY /files/{id}", "COPY"), additional("files.link", "LINK")])
	})

	it("reads a malformed declaration as declaring none", () => {
		const paths = {
			"/a": {
				additionalOperations: ["COPY"],
				get: { callbacks: null, operationId: "a.get", responses: { "200": null, "201": { links: [] } } },
				post: { callbacks: "x", operationId: "a.create", responses: "none" },
			},
			"/b": null,
			"/c": { additionalOperations: { MOVE: null } },
		}
		expect(gapsOf({ paths, webhooks: [] })).toEqual([additional("MOVE /c", "MOVE")])
		expect(gapsOf({ webhooks: "x" })).toEqual([])
	})
})

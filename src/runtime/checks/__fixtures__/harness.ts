import { checkContext } from "../../../../tests/support/check-context.ts"
import type { Client } from "../../../client/client.ts"
import type { RequestOptions } from "../../../client/types.ts"
import type { Exchange } from "../../exchange.ts"
import { FindingCollector } from "../../finding.ts"
import { buildModel, type OperationModel, type SpecModel } from "../../../spec/graph.ts"
import { dereference } from "../../../spec/load.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { CheckContext, WriteContext } from "../core/context.ts"

/*
 * A socket-free stage for one check: a model from a small document, a client whose answers a
 * test scripts by method and path, and a context with every field `run()` would set. What the
 * check sent is recorded in order, so a test asserts on the requests as well as the findings.
 */

/** One request as the fake client saw it. */
export interface Sent {
	method: string
	path: string
	options: RequestOptions
}

/** The answer to a request: a status and a body, or a whole exchange. */
export type Answer = { status: number; body?: unknown; headers?: Record<string, string> }

/** Answers each request; `undefined` means a 404 with an empty body. */
export type Responder = (method: string, path: string, options: RequestOptions) => Answer | undefined

let seq = 0

/** An exchange as the client would record it. */
export function exchange(method: string, path: string, answer: Answer, options: RequestOptions = {}): Exchange {
	seq += 1
	return {
		at: 0,
		durationMs: 0,
		method,
		requestBody: options.body,
		requestBytes: 0,
		requestHeaders: typeof options.headers === "function" ? options.headers() : (options.headers ?? {}),
		requestId: "",
		responseBody: answer.body ?? null,
		responseBytes: 0,
		responseHeaders: answer.headers ?? {},
		seq,
		status: answer.status,
		url: `http://api.test${path}`,
		...(options.operationId === undefined ? {} : { operationId: options.operationId }),
	}
}

export interface FakeClient {
	client: Client
	sent: Sent[]
}

/** A client that answers through `respond` and records every request. */
export function fakeClient(respond: Responder): FakeClient {
	const sent: Sent[] = []
	const transcript: Exchange[] = []
	const request = async (method: string, path: string, options: RequestOptions = {}): Promise<Exchange> => {
		sent.push({ method, options, path })
		const answered = exchange(method, path, respond(method, path, options) ?? { status: 404 }, options)
		transcript.push(answered)
		if (method !== "GET" && method !== "HEAD") fake.writes += 1
		return answered
	}
	const fake = {
		exchangesFor: (operationId: string) => transcript.filter((e) => e.operationId === operationId),
		exchangesForEntity: () => transcript,
		get: (path: string, options: RequestOptions = {}) => request("GET", path, options),
		hydrate: async (e: Exchange) => e,
		readOnlyView: () => fake,
		relativePath: (url: URL | string) => new URL(String(url), "http://api.test").pathname,
		request,
		transcript,
		view: () => fake,
		writes: 0,
	}
	return { client: fake as unknown as Client, sent }
}

/** The model of a small document. */
export function modelOf(doc: OpenApiDocument): SpecModel {
	return buildModel(dereference(doc).doc)
}

/** The operation `operationId` in `model`; throws when the document lacks it. */
export function op(model: SpecModel, operationId: string): OperationModel {
	const found = model.byOperationId.get(operationId)
	if (found === undefined) throw new Error(`the test document has no ${operationId}`)
	return found
}

/** A full context for a check against `model`, with the fake client and fresh findings. */
export function contextFor(
	model: SpecModel,
	listOperation: string,
	respond: Responder,
	fields: Partial<CheckContext> = {},
): { ctx: WriteContext; sent: Sent[]; findings: FindingCollector } {
	const { client, sent } = fakeClient(respond)
	const findings = new FindingCollector()
	const listOp = op(model, listOperation)
	const ctx = checkContext<Client>({
		client,
		entityName: listOp.entity ?? "",
		findings,
		listOp,
		model,
		...(fields as Partial<WriteContext>),
	})
	return { ctx, findings, sent }
}

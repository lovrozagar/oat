import { checkContext } from "../../../../tests/support/check-context.ts"
import type { Client } from "../../../client/client.ts"
import type { RequestOptions } from "../../../client/types.ts"
import type { Exchange } from "../../exchange.ts"
import { FindingCollector } from "../../finding.ts"
import { buildModel } from "../../../spec/graph/build.ts"
import type { OperationModel, SpecModel } from "../../../spec/graph/types.ts"
import { dereference } from "../../../spec/load/dereference.ts"
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

/**
 * Answers a request by what it carries on the wire, never by who it acts as, which the client resolved
 * already; `undefined` means a 404 with an empty body.
 */
export type Responder = (method: string, path: string, options: Omit<RequestOptions, "as">) => Answer | undefined

let seq = 0

/** An exchange as the client would record it, for an anonymous request sent with no other options. */
export function exchange(method: string, path: string, answer: Answer): Exchange {
	return exchangeOf({ method, options: { as: { anonymous: true } }, path }, answer)
}

/* Who the exchange names as the sender: the principal a request acted as, if it acted as one. */
function principalOf(options: RequestOptions): { principal: string } | Record<string, never> {
	return "principal" in options.as ? { principal: options.as.principal } : {}
}

/** The exchange the client records when `sent` draws `answer`. */
export function exchangeOf(sent: Sent, answer: Answer): Exchange {
	const { method, options, path } = sent
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
		...principalOf(options),
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
	const request = async (method: string, path: string, options: RequestOptions): Promise<Exchange> => {
		const asked: Sent = { method, options, path }
		sent.push(asked)
		const answered = exchangeOf(asked, respond(method, path, options) ?? { status: 404 })
		transcript.push(answered)
		if (method !== "GET" && method !== "HEAD") fake.writes += 1
		return answered
	}
	const fake = {
		exchangesFor: (operationId: string) => transcript.filter((e) => e.operationId === operationId),
		exchangesForEntity: () => transcript,
		get: (path: string, options: RequestOptions) => request("GET", path, options),
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

/** How a staged check is answered, and the context fields it overrides. */
export interface Stage {
	respond: Responder
	fields?: Partial<CheckContext>
}

/** A full context for a check against `model`, with the fake client and fresh findings. */
export function contextFor(
	model: SpecModel,
	listOperation: string,
	{ respond, fields }: Stage,
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

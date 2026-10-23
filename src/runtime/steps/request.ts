/*
 * A step resolved to the request it sends: an operation named in the document, or a raw method
 * and path for an endpoint the document does not describe, on the primary origin or a named one,
 * with `{name}` placeholders filled (one nothing fills is refused, never sent as written) and the body
 * encoded the way the operation documents it.
 */

import type { Client } from "../../client/client.ts"
import type { Hooks } from "../../config/types/hooks.ts"
import { isBytes, placeholderNames } from "../../config/types/placeholder.ts"
import type { AuthStep, OperationStep, RequestStep } from "../../config/types/steps.ts"
import { requestContent } from "../../spec/collection/request.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { encodeRequest } from "../body/encode.ts"
import type { BackoffConfig } from "../poll.ts"
import { interpolate } from "./interpolate.ts"

/** A named origin's client and the document it serves. */
export interface OriginClient {
	client: Client
	model: SpecModel
}

/** What a chain of steps runs against, and whose chain it is. */
export interface StepContext {
	client: Client
	model: SpecModel
	hooks: Hooks
	principalId: string
	outOfBand?: Partial<BackoffConfig>
	originClients?: ReadonlyMap<string, OriginClient>
}

/** The request a step sends, and the client it goes through. */
export interface ResolvedRequest {
	method: string
	path: string
	body?: unknown
	contentType?: string | null
	headers?: Record<string, string>
	query?: Record<string, string>
	client: Client
	redirect?: "follow" | "manual"
}

/** True for a step that names an operation from the document. */
export function isOperationStep(step: AuthStep): step is OperationStep {
	return "operationId" in step
}

/** True for a step that gives a raw method and path. */
export function isRequestStep(step: AuthStep): step is RequestStep {
	return "method" in step && "path" in step
}

/** Step `index` of a chain resolved against `scope`; throws when it cannot be sent. */
export async function resolveRequest(
	ctx: StepContext,
	step: AuthStep,
	scope: Record<string, string>,
	index: number,
): Promise<ResolvedRequest> {
	const target = targetOf(ctx, step, index)
	const fill = (value: unknown): unknown => filled(value, scope, index)
	/* Two shapes, distinguished structurally: name an operation from the document, or give a raw
	 * method and path for an endpoint the document does not describe. */
	if (isOperationStep(step)) {
		const op = target.model.byOperationId.get(step.operationId)
		if (op === undefined) {
			throw new Error(`oat: auth step ${index + 1} names operation "${step.operationId}", which is not in the document`)
		}
		const raw = target.model.rawOperations.get(step.operationId)
		const interpolated = step.body === undefined ? undefined : fill(step.body)
		const encoded = await encodeAuthBody(raw, interpolated, {
			mediaType: step.mediaType,
			operationId: step.operationId,
		})
		return {
			client: target.client,
			method: op.method,
			path: String(fill(op.path)),
			...encoded,
			...(step.headers === undefined ? {} : { headers: fill(step.headers) as Record<string, string> }),
			...(step.query === undefined ? {} : { query: fill(step.query) as Record<string, string> }),
		}
	}

	if (!isRequestStep(step)) {
		throw new Error(`oat: auth step ${index + 1} declares neither an operationId nor a method and path`)
	}
	return {
		client: target.client,
		method: step.method,
		path: String(fill(step.path)),
		redirect: step.redirect ?? "follow",
		...(step.body === undefined ? {} : { body: fill(step.body) }),
		...(step.headers === undefined ? {} : { headers: fill(step.headers) as Record<string, string> }),
		...(step.query === undefined ? {} : { query: fill(step.query) as Record<string, string> }),
	}
}

/* A `{name}` left in what a step sends would reach the backend as written and read as its fault. */
function filled(value: unknown, scope: Record<string, string>, index: number): unknown {
	const out = interpolate(value, scope)
	const name = placeholderNames(out)[0]
	if (name === undefined) return out
	throw new Error(
		`oat: step ${index + 1}'s placeholder {${name}} has no value: no bind, saveAs or earlier step fills it`,
	)
}

/** The named origin a step goes to, if it names one. */
function stepOrigin(step: AuthStep): string | undefined {
	if ("outOfBand" in step) return undefined
	if ("origin" in step && typeof step.origin === "string" && step.origin !== "") return step.origin
	return undefined
}

/** The client and document a step goes through: its named origin's, or the primary one. */
function targetOf(ctx: StepContext, step: AuthStep, index: number): OriginClient {
	const origin = stepOrigin(step)
	if (origin === undefined) return { client: ctx.client, model: ctx.model }
	const named = ctx.originClients?.get(origin)
	if (named === undefined) {
		const known = [...(ctx.originClients?.keys() ?? [])].join(", ")
		throw new Error(
			`oat: auth step ${index + 1} names origin "${origin}", which is not in config.origins` +
				(known === "" ? "" : ` (known: ${known})`),
		)
	}
	return named
}

/** A step body encoded as the operation documents it; anything it cannot encode goes as it is. */
async function encodeAuthBody(
	raw: ReturnType<SpecModel["rawOperations"]["get"]>,
	body: unknown,
	options: { operationId: string; mediaType: string | undefined },
): Promise<{ body?: unknown; contentType?: string | null }> {
	const { mediaType, operationId } = options
	if (body === undefined) return {}
	/* An upload goes as it is, under the media type the step names. */
	if (isBytes(body)) return mediaType === undefined ? { body } : { body, contentType: mediaType }
	const content = raw === undefined ? null : requestContent(raw, mediaType)
	if (content === null || body === null || typeof body !== "object" || Array.isArray(body)) {
		return { body }
	}
	const encoded = await encodeRequest({
		fields: body as Record<string, unknown>,
		index: 0,
		mediaType: content.mediaType,
		operationId,
		schema: content.schema,
		uploads: { seed: 1 },
		variant: "baseline",
		...(content.encoding === undefined ? {} : { encoding: content.encoding }),
	})
	return encoded.contentType === undefined
		? { body: encoded.body }
		: { body: encoded.body, contentType: encoded.contentType }
}

import { checkContext } from "../../../../tests/support/check-context.ts"
import { json, transport } from "../../../client/__fixtures__/transport.ts"
import { Client } from "../../../client/client.ts"
import { Redactor } from "../../../security/redact.ts"
import { FindingCollector } from "../../finding.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { WriteContext } from "../core/context.ts"
import { modelOf, op } from "./harness.ts"

/*
 * A check staged over the real client: requests go out as URLs through a scripted transport, so
 * a backend reads the query string the way a server would, not the options the check passed.
 */

export const BASE = "http://api.test"

/** A listing's answer to one request, by its URL; `undefined` is a 404. */
export type Serve = (url: URL, method: string) => unknown

export interface WireStage {
	ctx: WriteContext
	findings: FindingCollector
	/** Each request as `METHOD /path?query`, in order. */
	requests: string[]
}

/** A context for a check against `listOperation` in `document`, answered over the wire by `serve`. */
export function wireStage(
	document: OpenApiDocument,
	listOperation: string,
	stage: { serve: Serve; fields?: Partial<WriteContext> },
): WireStage {
	const requests: string[] = []
	const wire = transport((sent) => {
		const url = new URL(sent.url)
		requests.push(`${sent.method} ${url.pathname}${url.search}`)
		const body = stage.serve(url, sent.method)
		return body === undefined ? new Response(null, { status: 404 }) : json(body)
	})
	/* The document declares no security: every request goes as nobody. */
	const client = new Client({
		baseUrl: BASE,
		credentials: { resolve: async () => ({ kind: "anonymous" }) },
		network: { fetchImpl: wire.fetch },
		redactor: new Redactor(),
	})
	const model = modelOf(document)
	const listOp = op(model, listOperation)
	const findings = new FindingCollector()
	const fields = { query: listOp.query, ...stage.fields }
	const ctx = checkContext<Client>({ client, entityName: listOp.entity ?? "", findings, listOp, model, ...fields })
	return { ctx, findings, requests }
}

import type { Hooks } from "../../../config/types/hooks.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { SpecModel } from "../../../spec/graph/types.ts"
import { fakeClient, modelOf, type Responder, type Sent } from "../../checks/__fixtures__/harness.ts"
import { FindingCollector } from "../../finding.ts"
import { GradeLedger } from "../../grades.ts"
import { SchemaValidator } from "../../validate.ts"
import type { ConfirmInput, ContractInput } from "../types.ts"

/*
 * A socket-free stage for the contract floor: a model from a small document, a client whose
 * answers a test scripts, and the ledgers the floor writes to.
 */

export const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
export const ok = (schema?: unknown) => ({
	"200": { description: "ok", ...(schema === undefined ? {} : json(schema)) },
})
export const pathParam = (name: string, schema: unknown = { type: "string" }) => ({
	in: "path",
	name,
	required: true,
	schema,
})

/** A document of `paths`. */
export function doc(paths: Record<string, unknown>): OpenApiDocument {
	return { info: { title: "contract", version: "1" }, openapi: "3.1.0", paths } as unknown as OpenApiDocument
}

export interface Stage {
	input: ContractInput & ConfirmInput
	sent: Sent[]
	model: SpecModel
}

/** The floor's input over `document`, answered by `respond`. */
export function stage(document: OpenApiDocument, respond: Responder, fields: Partial<ContractInput> = {}): Stage {
	const model = modelOf(document)
	const { client, sent } = fakeClient(respond)
	const input = {
		acting: { identity: {}, sending: async () => undefined },
		checksRun: new Set<string>(),
		client,
		findings: new FindingCollector(),
		grades: new GradeLedger(),
		hooks: {} as Hooks,
		inScope: () => true,
		madeByRun: () => false,
		mode: "full" as const,
		model,
		nonce: "n0",
		owned: new Set<string>(),
		principal: "alpha",
		roots: {},
		seed: 1,
		stopped: () => false,
		validator: new SchemaValidator(model.defs),
		...fields,
	}
	return { input, model, sent }
}

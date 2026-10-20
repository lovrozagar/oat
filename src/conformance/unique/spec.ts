/** The widget document the unique suite runs oat against: one entity, its sets tagged as asked. */

import type { OpenApiDocument } from "../../spec/types.ts"
import { bearerSecurity } from "../harness/security.ts"

const ITEM = {
	properties: { email: { type: "string" }, id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

const ERROR_SCHEMA = {
	properties: { error_key: { type: "string" }, status: { type: "integer" } },
	required: ["error_key"],
	type: "object",
}

const GATE_SCHEMA = {
	properties: {
		error_key: { type: "string" },
		vars: { additionalProperties: true, type: "object" },
	},
	type: "object",
}

export interface SpecOptions {
	tag?: unknown
	omitTag?: boolean
	generated?: string[]
	immutable?: string[]
	idempotencyRequired?: boolean
	featureGate?: string
	updateBody?: string[]
}

/** The tags both writes carry: the unique sets, unless omitted, and the feature gate, when asked. */
function writeTags(options: SpecOptions): Record<string, unknown> {
	return {
		...(options.omitTag === true ? {} : { "x-unique": options.tag === undefined ? [["name"]] : options.tag }),
		...(options.featureGate === undefined ? {} : { "x-feature-gate": options.featureGate }),
	}
}

function orgParam(): Record<string, unknown> {
	return { in: "path", name: "org_id", required: true, schema: { type: "string" } }
}

function itemParams(): Array<Record<string, unknown>> {
	return [orgParam(), { in: "path", name: "widget_id", required: true, schema: { type: "string" } }]
}

function json(schema: unknown): Record<string, unknown> {
	return { "application/json": { schema } }
}

function createBody(): Record<string, unknown> {
	return { email: { type: "string" }, name: { type: "string", maxLength: 128 }, slug: { type: "string" } }
}

function createOperation(options: SpecOptions): Record<string, unknown> {
	return {
		operationId: "widget.create",
		parameters: [
			orgParam(),
			{
				in: "header",
				name: "Idempotency-Key",
				required: options.idempotencyRequired === true,
				schema: { type: "string" },
			},
		],
		requestBody: {
			content: json({ additionalProperties: false, properties: createBody(), required: ["name"], type: "object" }),
			required: true,
		},
		responses: {
			"201": { content: json(ITEM), description: "created" },
			"402": { description: "plan limit" },
			"403": { content: json(GATE_SCHEMA), description: "forbidden" },
			"409": { content: json(ERROR_SCHEMA), description: "conflict" },
		},
		"x-entity": { action: "create", identity: "id", name: "widget" },
		"x-generated": options.generated ?? ["id"],
		...writeTags(options),
	}
}

function updateOperation(options: SpecOptions): Record<string, unknown> {
	const known = createBody()
	const properties: Record<string, unknown> = {}
	for (const name of options.updateBody ?? ["email", "name", "slug"])
		properties[name] = known[name] ?? { type: "string" }
	return {
		operationId: "widget.update",
		parameters: itemParams(),
		requestBody: { content: json({ additionalProperties: false, properties, type: "object" }) },
		responses: {
			"200": { content: json(ITEM), description: "ok" },
			"402": { description: "plan limit" },
			"403": { content: json(GATE_SCHEMA), description: "forbidden" },
			"409": { content: json(ERROR_SCHEMA), description: "conflict" },
		},
		"x-entity": { action: "update", identity: "id", name: "widget" },
		"x-immutable": options.immutable ?? [],
		...writeTags(options),
	}
}

function listOperation(): Record<string, unknown> {
	return {
		operationId: "widget.list",
		parameters: [orgParam()],
		responses: {
			"200": {
				content: json({
					properties: { widgets: { items: ITEM, type: "array" } },
					required: ["widgets"],
					type: "object",
				}),
				description: "ok",
			},
		},
		"x-entity": { action: "list", identity: "id", name: "widget" },
	}
}

function itemPath(options: SpecOptions): Record<string, unknown> {
	return {
		delete: {
			operationId: "widget.delete",
			parameters: itemParams(),
			responses: { "204": { description: "gone" } },
			"x-entity": { action: "delete", identity: "id", name: "widget" },
		},
		get: {
			operationId: "widget.read",
			parameters: itemParams(),
			responses: {
				"200": { content: json(ITEM), description: "ok" },
				"404": { content: json(ERROR_SCHEMA), description: "missing" },
			},
			"x-entity": { action: "read", identity: "id", name: "widget" },
		},
		patch: updateOperation(options),
	}
}

/** Widgets under an org: list and create, then read, update and delete one. */
export function widgetSpec(options: SpecOptions = {}): OpenApiDocument {
	return {
		info: { title: "unique harness", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/orgs/{org_id}/widgets": {
				get: listOperation(),
				parameters: [orgParam()],
				post: createOperation(options),
			},
			"/v1/orgs/{org_id}/widgets/{widget_id}": itemPath(options),
		},
		...bearerSecurity(),
	} as OpenApiDocument
}

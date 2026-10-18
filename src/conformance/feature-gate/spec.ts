/** The feature-gate suite's document: webhooks whose writes may carry `x-feature-gate`, and untagged invites. */

import type { OpenApiDocument } from "../../spec/types.ts"

const FORBIDDEN_SCHEMA = {
	properties: {
		error_key: { type: "string" },
		status: { type: "integer" },
		status_key: { type: "string" },
		success: { type: "boolean" },
		vars: { additionalProperties: true, type: "object" },
	},
	type: "object",
}

const WEBHOOK_ITEM = {
	properties: { id: { type: "string" }, url: { type: "string" } },
	required: ["id", "url"],
	type: "object",
}

const ORG_ID = { in: "path", name: "org_id", required: true, schema: { type: "string" } }
const WEBHOOK_ID = { in: "path", name: "webhook_id", required: true, schema: { type: "string" } }

const NOT_FOUND = {
	content: {
		"application/json": {
			schema: { properties: { error_key: { type: "string" } }, type: "object" },
		},
	},
	description: "not found",
}

/** A JSON body of `schema`, described as `description`. */
function json(schema: unknown, description: string): Record<string, unknown> {
	return { content: { "application/json": { schema } }, description }
}

/** The list operation of `entity`: `<entity>.list`, answering `{ <entity>s: items[] }`. */
function listOf(entity: string, items: unknown): Record<string, unknown> {
	const key = `${entity}s`
	return {
		operationId: `${entity}.list`,
		parameters: [ORG_ID],
		responses: {
			"200": json({ properties: { [key]: { items, type: "array" } }, required: [key], type: "object" }, "ok"),
		},
		"x-entity": { action: "list", identity: "id", name: entity },
	}
}

/** A request body object with only `field`, a string. */
function onlyField(field: string, required: boolean): Record<string, unknown> {
	return {
		additionalProperties: false,
		properties: { [field]: { type: "string" } },
		...(required ? { required: [field] } : {}),
		type: "object",
	}
}

/** `x-feature-gate: tag`, or nothing when the document leaves it out. */
function gated(tag: string | null): Record<string, unknown> {
	return tag === null ? {} : { "x-feature-gate": tag }
}

function webhookCollection(tag: string | null): Record<string, unknown> {
	return {
		get: listOf("webhook", WEBHOOK_ITEM),
		parameters: [ORG_ID],
		post: {
			operationId: "webhook.create",
			requestBody: { content: { "application/json": { schema: onlyField("url", true) } }, required: true },
			responses: { "201": json(WEBHOOK_ITEM, "created"), "403": json(FORBIDDEN_SCHEMA, "forbidden") },
			"x-entity": { action: "create", identity: "id", name: "webhook" },
			...gated(tag),
		},
	}
}

function webhookItem(tag: string | null): Record<string, unknown> {
	return {
		get: {
			operationId: "webhook.read",
			parameters: [ORG_ID, WEBHOOK_ID],
			responses: { "200": json(WEBHOOK_ITEM, "ok"), "404": NOT_FOUND },
			"x-entity": { action: "read", identity: "id", name: "webhook" },
		},
		patch: {
			operationId: "webhook.update",
			parameters: [ORG_ID, WEBHOOK_ID],
			requestBody: { content: { "application/json": { schema: onlyField("url", false) } } },
			responses: { "200": json(WEBHOOK_ITEM, "ok"), "403": json(FORBIDDEN_SCHEMA, "forbidden"), "404": NOT_FOUND },
			"x-entity": { action: "update", identity: "id", name: "webhook" },
			...gated(tag),
		},
	}
}

function inviteCollection(): Record<string, unknown> {
	const invite = { properties: { email: { type: "string" }, id: { type: "string" } }, type: "object" }
	return {
		get: listOf("invite", invite),
		parameters: [ORG_ID],
		post: {
			operationId: "invite.create",
			requestBody: { content: { "application/json": { schema: onlyField("email", true) } }, required: true },
			responses: { "201": json(invite, "created") },
			"x-entity": { action: "create", identity: "id", name: "invite" },
		},
	}
}

/** The document, with webhook create and update tagged `tag`, or untagged when it is null. */
export function webhookSpec(tag: string | null): OpenApiDocument {
	return {
		info: { title: "Feature-gate harness", version: "1.0" },
		openapi: "3.1.0",
		paths: {
			"/v1/orgs/{org_id}/webhooks": webhookCollection(tag),
			"/v1/orgs/{org_id}/webhooks/{webhook_id}": webhookItem(tag),
			"/v1/orgs/{org_id}/invites": inviteCollection(),
		},
	} as OpenApiDocument
}

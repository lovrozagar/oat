/** Writes whose effect arrives later: an async job, and a notification delivered to an inbox. */

import type { EntityDef } from "../model.ts"
import { errorResponses } from "./errors.ts"
import { jsonResponse, ok } from "./operation.ts"
import { pathParams, tenantParam } from "./params.ts"
import type { Json, SpecContext } from "./types.ts"

/* The async lifecycle: a start operation returning a receipt, and a poll route that
 * eventually reports a terminal state. x-async ties the two together. */
function startOperation(ctx: SpecContext, job: EntityDef): Json {
	return {
		operationId: "job.start",
		parameters: pathParams(ctx, job, false),
		requestBody: {
			content: {
				"application/json": {
					schema: {
						additionalProperties: false,
						properties: { name: { maxLength: 128, minLength: 1, type: "string" } },
						required: ["name"],
						type: "object",
					},
				},
			},
			required: true,
		},
		responses: {
			[ok(ctx, 202)]: jsonResponse("Job accepted", {
				additionalProperties: false,
				properties: { accepted: { type: "boolean" }, job_id: { type: "string" } },
				required: ["job_id", "accepted"],
				type: "object",
			}),
			...errorResponses(ctx, [400, 401, 403, 404, 415]),
		},
		summary: "Start a job",
		tags: ["Job"],
		"x-async": {
			idFrom: "$.job_id",
			poll: `GET ${job.itemPath}`,
			pollIntervalMs: 20,
			successWhen: "status.eq.complete",
			timeoutMs: 3000,
			until: "status.in.(complete,failed)",
		},
		"x-effects": [{ count: 1, entity: "job", op: "create" }],
		"x-entity": { action: "action", identity: "id", name: "job" },
		"x-tenant": tenantParam(job),
	}
}

/* A write whose effect arrives elsewhere, later. x-wait tells oat where to look and how long. */
function notifyOperation(ctx: SpecContext, job: EntityDef): Json {
	return {
		operationId: "job.notify",
		parameters: pathParams(ctx, job, false),
		requestBody: {
			content: {
				"application/json": {
					schema: {
						additionalProperties: false,
						properties: { message: { maxLength: 200, minLength: 1, type: "string" } },
						required: ["message"],
						type: "object",
					},
				},
			},
			required: true,
		},
		responses: {
			[ok(ctx, 202)]: jsonResponse("Notification queued", {
				additionalProperties: false,
				properties: { accepted: { type: "boolean" }, notification_id: { type: "string" } },
				required: ["accepted", "notification_id"],
				type: "object",
			}),
			...errorResponses(ctx, [400, 401, 403, 404, 415]),
		},
		summary: "Queue a notification for delivery to the project inbox",
		tags: ["Job"],
		"x-entity": { action: "action", identity: "id", name: "job" },
		"x-tenant": tenantParam(job),
		"x-wait": { operationId: "job.inbox", timeoutMs: 2000, until: "$.messages[0]" },
	}
}

function inboxOperation(ctx: SpecContext, job: EntityDef): Json {
	return {
		operationId: "job.inbox",
		parameters: pathParams(ctx, job, false),
		responses: {
			[ok(ctx, 200)]: jsonResponse("Delivered notifications", {
				additionalProperties: false,
				properties: {
					messages: {
						items: {
							additionalProperties: false,
							properties: { id: { type: "string" }, message: { type: "string" } },
							required: ["id", "message"],
							type: "object",
						},
						type: "array",
					},
				},
				required: ["messages"],
				type: "object",
			}),
			...errorResponses(ctx, [401, 403, 404]),
		},
		summary: "List delivered notifications",
		tags: ["Job"],
		"x-entity": { action: "action", identity: "id", name: "job" },
		"x-tenant": tenantParam(job),
	}
}

export function jobPaths(ctx: SpecContext, job: EntityDef): Json {
	const project = job.collectionPath.replace("/jobs", "")
	return {
		[`${job.collectionPath}/start`]: { post: startOperation(ctx, job) },
		[`${project}/notifications`]: { post: notifyOperation(ctx, job) },
		[`${project}/inbox`]: { get: inboxOperation(ctx, job) },
	}
}

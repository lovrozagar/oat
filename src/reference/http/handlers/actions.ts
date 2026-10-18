/** Actions whose effect lands later or elsewhere: an async job, and a notification and its inbox. */

import { assertWrite } from "../access.ts"
import { readJson, requireJson } from "../body.ts"
import { HttpError } from "../errors.ts"
import { withDefaults } from "../records.ts"
import { type ReferenceResponse, respond } from "../wire.ts"
import { ownProject, type Route } from "./fixed.ts"

export const startJob: Route = async (state, request) => {
	if (!request.url.pathname.endsWith("/jobs/start") || request.method !== "POST") return undefined
	const projectId = request.url.pathname.split("/")[3] ?? ""
	ownProject(state, request, projectId)
	requireJson(request, state.defects)
	const name = ((await readJson(request)) as { name?: unknown }).name
	if (typeof name !== "string" || name === "") throw new HttpError(400, "invalid_input", 'field "name" is required')
	if (state.defects.has("ACTION_CRASHES")) throw new HttpError(500, "internal_error", "job runner unavailable")
	const job = withDefaults(state, { entity: state.job, scope: { project_id: projectId } }, { name })
	job.status = "pending"
	job.progress = 0
	if (!state.defects.has("EFFECT_NOT_APPLIED")) {
		await state.store.insert(state.job, job)
		state.jobStartedAt.set(String(job.id), Date.now())
	}
	return respond(
		202,
		state.defects.has("ASYNC_RECEIPT_MISSING_ID") ? { accepted: true } : { accepted: true, job_id: job.id },
	)
}

/* A write whose effect lands elsewhere, later: the message reaches the inbox after a short delay,
 * the way a queue consumer or a webhook delivery would. x-wait documents it. */
export const notify: Route = async (state, request) => {
	const match = /^\/v1\/projects\/([^/]+)\/notifications$/.exec(request.url.pathname)
	if (match === null || request.method !== "POST") return undefined
	const projectId = match[1] as string
	assertWrite(state, ownProject(state, request, projectId), "create")
	requireJson(request, state.defects)
	const message = ((await readJson(request)) as { message?: unknown }).message
	if (typeof message !== "string" || message === "" || message.length > 200) {
		throw new HttpError(400, "invalid_input", 'field "message" is required')
	}
	const id = `ntf_${String(state.ids.tick()).padStart(6, "0")}`
	if (!state.defects.has("SIDE_EFFECT_NEVER_ARRIVES")) {
		setTimeout(() => {
			const inbox = state.inboxes.get(projectId) ?? []
			inbox.push({ id, message })
			state.inboxes.set(projectId, inbox)
		}, 40)
	}
	return respond(202, { accepted: true, notification_id: id })
}

export const inbox: Route = async (state, request): Promise<ReferenceResponse | undefined> => {
	const match = /^\/v1\/projects\/([^/]+)\/inbox$/.exec(request.url.pathname)
	if (match === null || request.method !== "GET") return undefined
	const projectId = match[1] as string
	ownProject(state, request, projectId)
	return respond(200, { messages: state.inboxes.get(projectId) ?? [] })
}

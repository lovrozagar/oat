/**
 * An upload whose proof is a later read. An image commit passes when the profile read
 * shows the published url, and the remove passes when that url is gone. An object upload
 * passes when the read body is those bytes and the head headers describe them.
 */

import type { Client, Exchange } from "./client.ts"
import type { FindingCollector } from "./finding.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { GradeLedger } from "./scope.ts"
import { sleep } from "./poll.ts"
import { parseRouteRef } from "../spec/load.ts"

export const IMAGE_CHECK_ID = "image.profile-shows-the-upload"
export const OBJECT_CHECK_ID = "object.read-is-the-upload"

const RATE_LIMIT_WAIT_MS = 13_000
const IMAGE_MEDIA_TYPE = "image/png"

/* A 1×1 PNG. The commit sniffs magic bytes, so a text fixture cannot stand in. */
const PNG = Uint8Array.of(
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a,
	0x00,
	0x00,
	0x00,
	0x0d,
	0x49,
	0x48,
	0x44,
	0x52,
	0x00,
	0x00,
	0x00,
	0x01,
	0x00,
	0x00,
	0x00,
	0x01,
	0x08,
	0x06,
	0x00,
	0x00,
	0x00,
	0x1f,
	0x15,
	0xc4,
	0x89,
	0x00,
	0x00,
	0x00,
	0x0a,
	0x49,
	0x44,
	0x41,
	0x54,
	0x78,
	0x9c,
	0x63,
	0x00,
	0x01,
	0x00,
	0x00,
	0x05,
	0x00,
	0x01,
	0x0d,
	0x0a,
	0x2d,
	0xb4,
	0x00,
	0x00,
	0x00,
	0x00,
	0x49,
	0x45,
	0x4e,
	0x44,
	0xae,
	0x42,
	0x60,
	0x82,
)

export async function runImages(input: {
	auth: () => Record<string, string>
	client: Client
	cdn?: Client
	findings: FindingCollector
	grades: GradeLedger
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
}): Promise<void> {
	const commits = input.model.operations.filter((op) => {
		if (!hasTag(input.model, op, "x-image")) return false
		const remove = siblingDelete(input.model, op)
		return (
			input.mode === "full" ||
			input.inScope(op.operationId) ||
			(remove !== undefined && input.inScope(remove.operationId))
		)
	})
	for (const commit of commits) {
		const remove = siblingDelete(input.model, commit)
		const ids = remove === undefined ? [commit.operationId] : [commit.operationId, remove.operationId]
		const blame = input.findings.attributed(ids).ownedBy(IMAGE_CHECK_ID)
		const read = invalidatedGet(input.model, commit)
		const userId = subjectOf(input.auth())
		if (input.cdn === undefined || read === undefined || userId === null) {
			blame.backend(
				IMAGE_CHECK_ID,
				"caller",
				"the image upload was not prepared",
				`${commit.operationId} had no scratch upload or no profile read.`,
				[],
			)
			input.grades.graded(ids, IMAGE_CHECK_ID)
			continue
		}
		if (commit.path.includes("banner")) await ensureProfile(input, userId)
		const key = await scratchKey(input.cdn, input.auth, userId)
		if (key === null) {
			blame.backend(
				IMAGE_CHECK_ID,
				"caller",
				"the scratch upload was refused",
				`${commit.operationId} had no stored key.`,
				[],
			)
			input.grades.graded(ids, IMAGE_CHECK_ID)
			continue
		}
		const before = await once(input.client, read.method, read.path, input.auth, read.operationId)
		const committed = await once(input.client, commit.method, commit.path, input.auth, commit.operationId, { key })
		const after = await once(input.client, read.method, read.path, input.auth, read.operationId)
		const url = publishedUrl(committed.responseBody, after.responseBody, before.responseBody)
		if (url === null) {
			blame.backend(
				IMAGE_CHECK_ID,
				"caller",
				"the profile read did not show the upload",
				`${commit.operationId} returned ${committed.status}.`,
				[committed, after],
			)
		}
		input.grades.graded([commit.operationId], IMAGE_CHECK_ID)
		if (remove === undefined || url === null) continue
		const removed = await once(input.client, remove.method, remove.path, input.auth, remove.operationId)
		const gone = await once(input.client, read.method, read.path, input.auth, read.operationId)
		if (removed.status < 200 || removed.status >= 300 || bodyText(gone.responseBody).includes(url)) {
			blame.backend(
				IMAGE_CHECK_ID,
				"caller",
				"the profile read still shows the upload",
				`${remove.operationId} returned ${removed.status}.`,
				[removed, gone],
			)
		}
		input.grades.graded([remove.operationId], IMAGE_CHECK_ID)
	}
}

export async function runObjects(input: {
	auth: () => Record<string, string>
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
	roots?: Record<string, string>
}): Promise<void> {
	const uploads = input.model.operations.filter(
		(op) =>
			hasTag(input.model, op, "x-object") &&
			(input.mode === "full" || input.inScope(op.operationId) || readsInScope(input, op)),
	)
	for (const upload of uploads) {
		const read = objectRead(input.model, "GET")
		const head = objectRead(input.model, "HEAD")
		const ids = [upload.operationId]
		if (read !== undefined) ids.push(read.operationId)
		if (head !== undefined) ids.push(head.operationId)
		const blame = input.findings.attributed(ids).ownedBy(OBJECT_CHECK_ID)
		const orgId = input.roots?.organization_id
		if (orgId === undefined || orgId === "") {
			blame.backend(
				OBJECT_CHECK_ID,
				"caller",
				"the object upload had no scope",
				`${upload.operationId} had no organization.`,
				[],
			)
			input.grades.graded(ids, OBJECT_CHECK_ID)
			continue
		}
		const name = `oat-object.png`
		const putPath = `/cdn/u/o/${orgId}/${name}`
		const uploaded = await input.client.request("PUT", putPath, {
			body: PNG,
			contentType: IMAGE_MEDIA_TYPE,
			headers: input.auth,
			operationId: upload.operationId,
		})
		const key = stringField(uploaded.responseBody, "key")
		if (uploaded.status < 200 || uploaded.status >= 300 || key === null) {
			blame.backend(
				OBJECT_CHECK_ID,
				"caller",
				"the object upload was refused",
				`${upload.operationId} returned ${uploaded.status}.`,
				[uploaded],
			)
			input.grades.graded(ids, OBJECT_CHECK_ID)
			continue
		}
		input.grades.graded([upload.operationId], OBJECT_CHECK_ID)
		const readPath = `/cdn/${key}`
		if (read !== undefined) {
			const body = await input.client.request(read.method, readPath, {
				headers: input.auth,
				operationId: read.operationId,
			})
			if (!sameBytes(body.responseBody, PNG)) {
				blame.backend(
					OBJECT_CHECK_ID,
					"caller",
					"the read was not the upload",
					`${read.operationId} returned ${body.status}.`,
					[uploaded, body],
				)
			}
			input.grades.graded([read.operationId], OBJECT_CHECK_ID)
		}
		if (head !== undefined) {
			const meta = await input.client.request(head.method, readPath, {
				headers: input.auth,
				operationId: head.operationId,
			})
			const type = header(meta, "content-type")
			const length = header(meta, "content-length")
			if (meta.status < 200 || meta.status >= 300 || type !== IMAGE_MEDIA_TYPE || length !== String(PNG.byteLength)) {
				blame.backend(
					OBJECT_CHECK_ID,
					"caller",
					"the head did not describe the upload",
					`${head.operationId} returned ${meta.status}.`,
					[uploaded, meta],
				)
			}
			input.grades.graded([head.operationId], OBJECT_CHECK_ID)
		}
	}
}

async function scratchKey(cdn: Client, auth: () => Record<string, string>, userId: string): Promise<string | null> {
	const name = `oatimg${Date.now().toString(36)}.png`
	const uploaded = await cdn.request("PUT", `/cdn/u/u/${userId}/${name}`, {
		body: PNG,
		contentType: IMAGE_MEDIA_TYPE,
		headers: auth,
	})
	const key = stringField(uploaded.responseBody, "key")
	return uploaded.status >= 200 && uploaded.status < 300 && key !== null ? key : null
}

async function ensureProfile(
	input: { auth: () => Record<string, string>; client: Client; model: SpecModel },
	userId: string,
): Promise<void> {
	const read = input.model.operations.find((op) => op.method === "GET" && op.path.endsWith("/public-profiles/me"))
	const create = input.model.operations.find((op) => op.method === "POST" && op.path.endsWith("/public-profiles/me"))
	if (read === undefined || create === undefined) return
	const current = await once(input.client, read.method, read.path, input.auth, read.operationId)
	if (current.status >= 200 && current.status < 300) return
	const handle = `oat${userId
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(-12)}`.slice(0, 20)
	await once(input.client, create.method, create.path, input.auth, create.operationId, {
		display_name: "Oat",
		handle: handle.length >= 3 ? handle : "oatprofile",
		is_public: true,
	})
}

async function once(
	client: Client,
	method: string,
	path: string,
	auth: () => Record<string, string>,
	operationId: string,
	body?: Record<string, unknown>,
): Promise<Exchange> {
	const send = () =>
		client.request(method, path, {
			headers: auth,
			operationId,
			...(body === undefined ? {} : { body }),
		})
	const first = await send()
	if (first.status !== 429) return first
	await sleep(RATE_LIMIT_WAIT_MS)
	return send()
}

function publishedUrl(committed: unknown, after: unknown, before: unknown): string | null {
	const afterText = bodyText(after)
	const beforeText = bodyText(before)
	for (const value of stringsOf(committed)) {
		if (!value.startsWith("https://") || !value.includes("/cdn/p/")) continue
		if (afterText.includes(value) && !beforeText.includes(value)) return value
	}
	return null
}

function sameBytes(body: unknown, bytes: Uint8Array): boolean {
	if (!(body instanceof Uint8Array)) return false
	if (body.byteLength !== bytes.byteLength) return false
	for (let index = 0; index < bytes.byteLength; index += 1) {
		if (body[index] !== bytes[index]) return false
	}
	return true
}

function objectRead(model: SpecModel, method: string): OperationModel | undefined {
	return model.operations.find((op) => op.method === method && op.path.includes("/cdn/s/"))
}

function readsInScope(
	input: { inScope: (operationId: string) => boolean; model: SpecModel },
	_upload: OperationModel,
): boolean {
	const read = objectRead(input.model, "GET")
	const head = objectRead(input.model, "HEAD")
	return (
		(read !== undefined && input.inScope(read.operationId)) || (head !== undefined && input.inScope(head.operationId))
	)
}

function siblingDelete(model: SpecModel, commit: OperationModel): OperationModel | undefined {
	return model.operations.find((op) => op.method === "DELETE" && op.path === commit.path)
}

function invalidatedGet(model: SpecModel, op: OperationModel): OperationModel | undefined {
	for (const named of op.invalidates) {
		const parsed = parseRouteRef(named)
		if (parsed === null || parsed.method !== "GET") continue
		const found = model.operations.find((item) => item.method === "GET" && item.path === parsed.path)
		if (found !== undefined) return found
	}
	return undefined
}

function hasTag(model: SpecModel, op: OperationModel, tag: string): boolean {
	const raw = model.rawOperations.get(op.operationId) as Record<string, unknown> | undefined
	return raw?.[tag] === true
}

function subjectOf(headers: Record<string, string>): string | null {
	const authorization = headers.authorization ?? headers.Authorization
	if (authorization === undefined) return null
	const token = authorization.replace(/^Bearer\s+/i, "")
	const part = token.split(".")[1]
	if (part === undefined || part === "") return null
	try {
		const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { sub?: unknown }
		return typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null
	} catch {
		return null
	}
}

function header(exchange: Exchange, name: string): string | undefined {
	for (const [key, value] of Object.entries(exchange.responseHeaders)) {
		if (key.toLowerCase() === name) return value
	}
	return undefined
}

function bodyText(body: unknown): string {
	if (typeof body === "string") return body
	if (body === null || body === undefined) return ""
	return JSON.stringify(body)
}

function stringsOf(body: unknown): string[] {
	const out: string[] = []
	const walk = (value: unknown) => {
		if (typeof value === "string") {
			out.push(value)
			return
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item)
			return
		}
		if (value !== null && typeof value === "object") {
			for (const child of Object.values(value as Record<string, unknown>)) walk(child)
		}
	}
	walk(body)
	return out
}

function stringField(body: unknown, key: string): string | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null
	const value = (body as Record<string, unknown>)[key]
	return typeof value === "string" && value !== "" ? value : null
}

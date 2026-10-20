/**
 * The backend behind the unique suite: widgets under one org, which enforces the document's
 * `x-unique` sets the way a case asks — a 409, an insert anyway, a gate, a plan limit, or a 409
 * whose body drifts from the document.
 */

import type { PrincipalsConfig, SecurityConfig } from "../../config/types/security.ts"
import { bearer } from "../../reference/http/access.ts"
import type { Handle } from "../../reference/http/node.ts"
import type { ReferenceRequest, ReferenceResponse } from "../../reference/http/wire.ts"
import { run } from "../../runtime/run/index.ts"
import type { RunResult } from "../../runtime/run/types.ts"
import { readUnique } from "../../spec/extensions/unique.ts"
import type { OpenApiDocument, OperationObject } from "../../spec/types.ts"
import { reach, type Via } from "../harness/launch.ts"
import { answer, guarded, readJson } from "../harness/serve.ts"
import { type SpecOptions, widgetSpec } from "./spec.ts"

/** How a duplicate create is answered. */
export type DuplicateMode = "409" | "201" | "per-set" | "gate-403" | "402" | "409-drift"

export interface HarnessOptions {
	spec: SpecOptions
	/** The first create is refused as a duplicate. */
	seedConflict?: boolean
	/** A widget is listed before oat creates any. */
	listSeeded?: boolean
	duplicate?: DuplicateMode
	/** How a colliding update is answered: refused with a 409 (the default), or applied. */
	updateDuplicate?: "409" | "201" | "ok"
}

/** A write as the backend received it. */
export interface Post {
	headers: Readonly<Record<string, string>>
	body: unknown
}

interface Row {
	email: string
	id: string
	name: string
	slug: string
}

/** One harness's state: its rows, and every write it was sent. */
interface Widgets {
	options: HarnessOptions
	spec: OpenApiDocument
	sets: string[][]
	rows: Map<string, Row>
	posts: Post[]
	seq: number
}

const COLLECTION = "/v1/orgs/org_1/widgets"
const ITEM = /^\/v1\/orgs\/org_1\/widgets\/[^/]+$/

const conflicted = (): ReferenceResponse => answer(409, { error_key: "conflict", status: 409 })
const notFound = (): ReferenceResponse => answer(404, { error_key: "not_found" })

/** A row about to be written: its values, and its own id when it already exists. */
export interface Candidate {
	values: Record<string, unknown>
	id?: string
}

/** The first set the candidate collides on with a row other than itself, or null. */
export function conflict(sets: string[][], existing: Row[], candidate: Candidate): string[] | null {
	const { values: incoming, id: exceptId } = candidate
	for (const set of sets) {
		const hit = existing.find(
			(row) =>
				row.id !== exceptId &&
				set.every((col) => incoming[col] !== undefined && String(row[col as keyof Row]) === String(incoming[col])),
		)
		if (hit !== undefined) return set
	}
	return null
}

/** What a duplicate create gets, per mode; null inserts it anyway. */
const ON_DUPLICATE: Record<DuplicateMode, (state: Widgets, colliding: string[]) => ReferenceResponse | null> = {
	"201": () => null,
	"402": () => answer(402, { error_key: "payment_required" }),
	"409": conflicted,
	"409-drift": () => answer(409, { oops: true }),
	"gate-403": (state) =>
		answer(403, {
			error_key: "forbidden",
			vars: { feature: state.options.spec.featureGate ?? "widgets", type: "feature_gate" },
		}),
	"per-set": (_, colliding) => (colliding.includes("name") || colliding.includes("email") ? conflicted() : null),
}

async function received(state: Widgets, request: ReferenceRequest): Promise<Record<string, unknown>> {
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>
	state.posts.push({ body, headers: { ...request.headers } })
	return body
}

function text(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback
}

async function create(state: Widgets, request: ReferenceRequest): Promise<ReferenceResponse> {
	const body = await received(state, request)
	if (state.options.seedConflict === true && state.posts.length === 1) return conflicted()
	const colliding = conflict(state.sets, [...state.rows.values()], { values: body })
	const refused = colliding === null ? null : ON_DUPLICATE[state.options.duplicate ?? "409"](state, colliding)
	if (refused !== null) return refused
	state.seq += 1
	const id = `w_${String(state.seq)}`
	const row: Row = {
		email: text(body.email, `${id}@example.test`),
		id,
		name: text(body.name, id),
		slug: text(body.slug, id),
	}
	state.rows.set(id, row)
	return answer(201, row)
}

async function update(state: Widgets, id: string, request: ReferenceRequest): Promise<ReferenceResponse> {
	const row = state.rows.get(id)
	if (row === undefined) return notFound()
	const body = await received(state, request)
	const colliding = conflict(state.sets, [...state.rows.values()], { id, values: { ...row, ...body } })
	if (colliding !== null && (state.options.updateDuplicate ?? "409") === "409") return conflicted()
	row.email = text(body.email, row.email)
	row.name = text(body.name, row.name)
	row.slug = text(body.slug, row.slug)
	return answer(200, row)
}

type ItemHandler = (
	state: Widgets,
	id: string,
	request: ReferenceRequest,
) => Promise<ReferenceResponse> | ReferenceResponse

/** What each method does to one widget; any other method finds nothing. */
const ON_ITEM: Readonly<Record<string, ItemHandler>> = {
	DELETE: (state, id) => {
		state.rows.delete(id)
		return answer(204)
	},
	GET: (state, id) => {
		const row = state.rows.get(id)
		return row === undefined ? notFound() : answer(200, row)
	},
	PATCH: update,
}

function route(state: Widgets, request: ReferenceRequest): Promise<ReferenceResponse> | ReferenceResponse {
	const { pathname } = request.url
	if (pathname === "/v1/openapi/spec" && request.method === "GET") return answer(200, state.spec)
	if (bearer(request) === undefined) return answer(401, { error_key: "unauthorized" })
	if (pathname === COLLECTION && request.method === "GET") return answer(200, { widgets: [...state.rows.values()] })
	if (pathname === COLLECTION && request.method === "POST") return create(state, request)
	const onItem = ITEM.test(pathname) ? ON_ITEM[request.method] : undefined
	if (onItem === undefined) return notFound()
	return onItem(state, decodeURIComponent(pathname.slice(COLLECTION.length + 1)), request)
}

/** A fresh backend for `options`, and every write it is sent. */
export function widgetBackend(options: HarnessOptions): { handle: Handle; posts: Post[] } {
	const tag = options.spec.omitTag === true ? null : (options.spec.tag ?? [["name"]])
	const state: Widgets = {
		options,
		posts: [],
		rows: new Map(),
		seq: 0,
		sets: tag === null ? [] : (readUnique({ "x-unique": tag } as OperationObject) ?? []),
		spec: widgetSpec(options.spec),
	}
	if (options.listSeeded === true) {
		state.rows.set("w_existing", {
			email: "seed@example.test",
			id: "w_existing",
			name: "Existing Widget",
			slug: "existing",
		})
	}
	return {
		handle: guarded(async (request) => route(state, request), answer(500, { error_key: "internal" })),
		posts: state.posts,
	}
}

/** What one run against the harness saw. */
export interface Outcome {
	result: Pick<RunResult, "checksRun" | "entitiesTested" | "findings">
	posts: Post[]
}

const PRINCIPALS: PrincipalsConfig = { alpha: { scope: { org_id: "org_1" }, tenant: "org_1" } }
const SECURITY: SecurityConfig = { bearer: { static: "tok_alpha" } }

/** oat run once, on the widget entity alone, against a fresh harness reached through `via`. */
export async function against(via: Via, options: HarnessOptions): Promise<Outcome> {
	const { handle, posts } = widgetBackend(options)
	const hosted = await via.host(handle)
	try {
		const result = await run({
			baseUrl: hosted.url,
			only: ["widget"],
			principals: PRINCIPALS,
			security: SECURITY,
			seed: 1,
			spec: `${hosted.url}/v1/openapi/spec`,
			...reach(hosted),
		})
		return { posts, result }
	} finally {
		await hosted.close()
	}
}

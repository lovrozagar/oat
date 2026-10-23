import type { Hooks } from "../../../config/types/hooks.ts"
import type { Scenario, ScenarioStep } from "../../../config/types/steps.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import { type Answer, fakeClient, modelOf, type Responder, type Sent } from "../../checks/__fixtures__/harness.ts"
import { FindingCollector } from "../../finding.ts"
import { GradeLedger } from "../../grades.ts"
import type { ScenarioInput, ScenarioRun } from "../types.ts"
import { startScenario } from "../state.ts"

/*
 * A socket-free stage for scenarios: a notes document with a token endpoint, a notes API that
 * answers from memory, and the input `runScenarios` takes — two principals, fresh ledgers. The
 * fake client records who each request acts as; it places no credential.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const note = { properties: { id: { type: "string" }, text: { type: "string" } }, type: "object" }
const idParam = { in: "path", name: "id", required: true, schema: { type: "string" } }
const ok = (schema: unknown) => ({ "200": { description: "ok", ...json(schema) } })

export const notesDoc = {
	info: { title: "notes", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/notes": {
			get: {
				operationId: "notes.list",
				responses: ok({
					properties: { items: { items: note, type: "array" }, total: { type: "integer" } },
					type: "object",
				}),
			},
			post: {
				operationId: "notes.create",
				requestBody: json(note),
				responses: { "201": { description: "made", ...json(note) } },
			},
		},
		"/notes/{id}": {
			get: { operationId: "notes.get", parameters: [idParam], responses: ok(note) },
			patch: { operationId: "notes.rename", parameters: [idParam], requestBody: json(note), responses: ok(note) },
		},
		"/token": {
			post: { operationId: "auth.token", responses: ok({ properties: { token: { type: "string" } }, type: "object" }) },
		},
	},
} as unknown as OpenApiDocument

/* One base64url-encoded JSON part of a JWT. */
const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url")

/** A JWT whose payload is `claims`; the signature is not checked. */
export function jwt(claims: Record<string, unknown>): string {
	return `${part({ alg: "none" })}.${part(claims)}.sig`
}

/** The notes held, by id, and answers that replace the API's own by `METHOD /path`. */
export interface Notes {
	rows: Map<string, string>
	answers: Record<string, Answer | (() => Answer)>
}

export function notes(fields: Partial<Notes> = {}): Notes {
	return { answers: {}, rows: new Map(), ...fields }
}

export function notesApi(held: Notes): Responder {
	return (method, path, options) => {
		const fixed = held.answers[`${method} ${path}`]
		if (fixed !== undefined) return typeof fixed === "function" ? fixed() : fixed
		const body = (options.body ?? {}) as Record<string, unknown>
		if (`${method} ${path}` === "POST /notes") {
			const id = `n${held.rows.size + 1}`
			held.rows.set(id, String(body["text"]))
			return { body: { id, text: body["text"] }, headers: { "set-cookie": `last=${id}`, "x-note": id }, status: 201 }
		}
		if (`${method} ${path}` === "GET /notes") {
			const items = [...held.rows].map(([id, text]) => ({ id, text }))
			return { body: { items, total: items.length }, status: 200 }
		}
		if (`${method} ${path}` === "POST /token") return { body: { token: jwt({ org: "o1", sub: "u1" }) }, status: 200 }
		const id = /^\/notes\/([^/]+)$/.exec(path)?.[1] ?? ""
		if (!held.rows.has(id)) return { status: 404 }
		if (method === "PATCH") held.rows.set(id, String(body["text"]))
		return { body: { id, text: held.rows.get(id) }, status: 200 }
	}
}

export function scenario(steps: ScenarioStep[], fields: Partial<Scenario> = {}): Scenario {
	return { covers: [], id: "flow", steps, ...fields }
}

/** Fields to set; one given as `undefined` is left out, so a test can drop a default. */
export type Overrides<T> = { [K in keyof T]?: T[K] | undefined }

function overriding<T extends object>(base: T, fields: Overrides<T>): T {
	const out: Record<string, unknown> = { ...base, ...fields }
	for (const [key, value] of Object.entries(fields)) if (value === undefined) delete out[key]
	return out as T
}

/** `runScenarios`' input over the notes API, and what the client sent. */
export function stage(
	respond: Responder,
	fields: Overrides<ScenarioInput> = {},
): { input: ScenarioInput; sent: Sent[] } {
	const { client, sent } = fakeClient(respond)
	const base: ScenarioInput = {
		checksRun: new Set(),
		client,
		defaultPrincipal: "alpha",
		findings: new FindingCollector(),
		grades: new GradeLedger(),
		hooks: {} as Hooks,
		inScope: () => true,
		mode: "full",
		model: modelOf(notesDoc),
		principals: new Map([
			["alpha", { scope: { org: "o1" } }],
			["beta", { scope: {} }],
		]),
		scenarios: [],
		sleep: async () => undefined,
	}
	return { input: overriding(base, fields), sent }
}

/** One scenario's running state over the notes API, and the requests its client sent. */
export function runOf(
	held: Notes,
	fields: Overrides<ScenarioInput> = {},
	of: Scenario = scenario([]),
): ScenarioRun & { requests: Sent[] } {
	const { input, sent } = stage(notesApi(held), fields)
	return { ...startScenario(input, of, input.sleep ?? (async () => undefined)), requests: sent }
}

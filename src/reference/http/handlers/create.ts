/** A create: the body validated, the identity issued or the client's, uniqueness kept, a replay answered. */

import type { Row } from "../../store-api.ts"
import { assertWrite } from "../access.ts"
import { readJson, requireForm, requireJson } from "../body.ts"
import { HttpError } from "../errors.ts"
import { assertPrivileged } from "../privileged.ts"
import { answerCreated, present, snapshotKey, withDefaults } from "../records.ts"
import { type ReferenceState, TENANT_FIELD } from "../state.ts"
import { assertUnique, liveRows, refreshParentCount } from "../store-ops.ts"
import { formFields, validateBody } from "../validation.ts"
import { type ReferenceRequest, type ReferenceResponse, respond } from "../wire.ts"
import type { EntityCall } from "./entity.ts"

const createdStatus = (state: ReferenceState): number => (state.defects.has("CREATED_201_AS_200") ? 200 : 201)

/* An acknowledgment-only create answers success and nothing else. */
const acknowledged = (state: ReferenceState, call: EntityCall): boolean =>
	state.shape.ackCreate === true && call.entity.name === state.table.name

export async function create(
	state: ReferenceState,
	request: ReferenceRequest,
	call: EntityCall,
): Promise<ReferenceResponse> {
	const { entity, principal } = call
	const { defects } = state
	assertWrite(state, principal, "create")
	const form = state.shape.formCreate === true
	if (form) requireForm(request, defects)
	else requireJson(request, defects)
	/* Scoped by principal as well as key: two tenants using the same key must not be able to read
	 * each other's result back. */
	const idempotencyKey = request.headers["idempotency-key"] ?? ""
	const replayKey = idempotencyKey === "" ? null : `${principal.projectId}:${entity.name}:${idempotencyKey}`
	const replay = replayKey === null ? undefined : await replayed(state, call, { replayKey, request })
	if (replay !== undefined) return replay
	const received = form ? formFields(entity, await request.text()) : await readJson(request)
	/* The crash happens on the bytes as received, before anything sanitizes them. */
	if (defects.has("CREATE_500_ON_NON_ASCII") && nonAscii(received as Row)) {
		throw new Error("encoding error: could not write row")
	}
	const input = validateBody(received, { defects, entity, mode: "create" })
	assertPrivileged(state, call, input)
	const scope = { ...call.scope, project_id: principal.projectId }
	const key = snapshotKey(entity, call.scope)
	if (defects.has("STALE_LIST") && !state.staleSnapshot.has(key)) {
		state.staleSnapshot.set(key, await liveRows(state, entity, scope))
	}
	if (defects.has("CREATE_DROPS_FIELD")) delete input["description"]
	const record = withDefaults(state, { entity, scope }, input)
	const overwritten = await clientChosenId(state, call, { input, record })
	if (overwritten !== undefined) return overwritten
	await assertUnique(state, { entity, record })
	const created = await state.store.insert(entity, record)
	await refreshParentCount(state, entity, call.scope)
	if (replayKey !== null) state.idempotent.set(replayKey, created)
	return createdAnswer(state, { call, created, request })
}

/* What a create answers: the record, `{ success }` under ackCreate, or what `createAnswer` names. */
function createdAnswer(
	state: ReferenceState,
	{ call, created, request }: { call: EntityCall; created: Row; request: ReferenceRequest },
): ReferenceResponse {
	const { entity } = call
	const status = createdStatus(state)
	if (acknowledged(state, call)) return respond(status, { success: true })
	const answer = entity.name === state.job.name ? undefined : state.shape.createAnswer
	if (answer === "id-message") return respond(status, { id: created[entity.identity], message: "created" })
	if (answer === "location")
		return { body: "", headers: { location: locationOf(state, { call, created, request }) }, status }
	return respond(status, answerCreated(state, entity, present(state, entity, created)))
}

/* The new record's absolute URL, as a server that answers only `Location` gives it. */
function locationOf(
	state: ReferenceState,
	{ call, created, request }: { call: EntityCall; created: Row; request: ReferenceRequest },
): string {
	const { entity, principal } = call
	const scope: Record<string, unknown> = { ...call.scope, project_id: principal.projectId }
	const params = [...entity.itemPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
	const last = params.at(-1)
	const path = entity.itemPath.replace(/\{([^}]+)\}/g, (_, name: string) =>
		encodeURIComponent(String(name === last ? created[entity.identity] : scope[name])),
	)
	return new URL(`${state.shape.basePath ?? ""}${path}`, request.url).href
}

function nonAscii(received: Row): boolean {
	return Object.values(received).some(
		(value) => typeof value === "string" && [...value].some((ch) => (ch.codePointAt(0) as number) > 0x7f),
	)
}

/* A repeated Idempotency-Key answers with the first create's record — or, under the defect, inserts again. */
async function replayed(
	state: ReferenceState,
	call: EntityCall,
	{ replayKey, request }: { replayKey: string; request: ReferenceRequest },
): Promise<ReferenceResponse | undefined> {
	if (state.defects.has("IDEMPOTENCY_IGNORED")) return undefined
	const previous = state.idempotent.get(replayKey)
	if (previous === undefined) return undefined
	const { entity, principal } = call
	if (state.defects.has("IDEMPOTENT_REPLAY_INSERTS")) {
		const copy: Row = { ...previous }
		delete copy[entity.identity]
		for (const column of (entity.unique ?? []).flat()) {
			if (typeof copy[column] === "string") copy[column] = `${copy[column] as string}-replay`
		}
		await state.store.insert(
			entity,
			withDefaults(state, { entity, scope: { ...call.scope, project_id: principal.projectId } }, copy),
		)
	}
	return createdAnswer(state, { call, created: previous, request })
}

/*
 * Under the client-ids shape the table's id is the client's to choose: a taken one is a 409.
 * CLIENT_ID_IGNORED stores the record under an id of the server's own and still acknowledges. It
 * counts down from the top of the range by the entity's own creates, the first free one: drawn from
 * the sequence every entity shares, it would move with other entities' writes, and whether a later
 * chosen id names it, so what a run grades, would depend on which lane the server answered first.
 * CLIENT_ID_OVERWRITES replaces the tenant's record that holds the id and says so with a 200.
 */
/* The first free id counted down from the top of the range by the entity's own creates; the issued one when none is free. */
async function ownId(
	state: ReferenceState,
	entity: EntityCall["entity"],
	{ range, record }: { range: { min: number; max: number }; record: Row },
): Promise<void> {
	for (let own = range.max + 1 - state.ids.countOf(entity); own >= range.min;) {
		if ((await state.store.byId(entity, own)) === null) {
			state.ids.renumber(entity, record[entity.identity], own)
			record[entity.identity] = own
			return
		}
		own = range.max + 1 - state.ids.countOf(entity)
	}
}

async function clientChosenId(
	state: ReferenceState,
	call: EntityCall,
	made: { input: Row; record: Row },
): Promise<ReferenceResponse | undefined> {
	const { entity } = call
	const range = entity.name === state.table.name ? state.shape.clientIds : undefined
	if (range === undefined) return undefined
	const chosen = made.input[entity.identity]
	if (typeof chosen !== "number" || !Number.isInteger(chosen) || chosen < range.min || chosen > range.max) {
		throw new HttpError(
			400,
			"invalid_input",
			`field "${entity.identity}" must be an integer from ${range.min} to ${range.max}`,
		)
	}
	if (state.defects.has("CLIENT_ID_IGNORED")) {
		await ownId(state, entity, { range, record: made.record })
		return undefined
	}
	made.record[entity.identity] = chosen
	const holder = await state.store.byId(entity, chosen)
	if (holder === null) return undefined
	if (state.defects.has("CLIENT_ID_OVERWRITES") && holder[TENANT_FIELD] === made.record[TENANT_FIELD]) {
		await state.store.update(entity, chosen, { ...made.input, updated_at: made.record["updated_at"] })
		return respond(200, { success: true })
	}
	throw new HttpError(409, "conflict", `${entity.identity} ${chosen} is taken`)
}

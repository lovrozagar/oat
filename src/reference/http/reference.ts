/**
 * The reference backend in process — one implementation, any store, no socket.
 *
 * Routing, auth, tenancy, validation and the defect behaviors that live above storage are written
 * once. Each engine supplies only a `Store`, so a defect is defined in one place and exercised
 * identically on every backend; when two engines then disagree about what that defect *does*, the
 * disagreement is real rather than an artifact of two implementations drifting apart.
 *
 * This is a test fixture. It is excluded from the published package; oat itself never talks to a
 * database.
 */

import { type DefectSet, DefectSet as Defects } from "../defects/defect-set.ts"
import { DIALECTS } from "../dialect/presets.ts"
import type { Dialect } from "../dialect/types.ts"
import type { EntityDef } from "../model/types.ts"
import { shapedEntities } from "../model/shaped.ts"
import { DEFAULT_CONVENTIONS } from "../query/conventions.ts"
import type { ReferenceShape } from "../shapes/types.ts"
import { shapedDialect } from "../shapes/dialect.ts"
import { shapeNamed } from "../shapes/named.ts"
import type { Row, Store } from "../store-api.ts"
import { asFetch } from "./fetch.ts"
import { newAuthState } from "./auth/sessions.ts"
import { Ids } from "./ids.ts"
import { hiddenFromCreator } from "./records.ts"
import { handle } from "./router.ts"
import { type Account, PRINCIPALS, type ReferenceOptions, type ReferenceState } from "./state.ts"
import { prepopulate } from "./store-ops.ts"

/** Builds the store for the entities a shape serves, with the defects it carries. */
export type StoreFactory = (defects: DefectSet, entities: readonly EntityDef[]) => Promise<Store>

/** Where an in-process reference answers: no socket stands behind it. */
export const IN_PROCESS_ORIGIN = "http://reference.test"

export interface Reference {
	/** The API's base URL: the origin, and the shape's base path. */
	url: string
	/** The reference as a transport: hand it to the client as its `fetch`. */
	fetch: typeof fetch
	defects: DefectSet
	principals: readonly Account[]
	/** Every record currently stored, per entity, for leak accounting. Reads the store directly. */
	snapshot: () => Promise<Record<string, Row[]>>
	/** Every id the server issued or stored since it started serving, per entity, deleted since or not. */
	createdIds: () => Record<string, string[]>
	/** Every TOTP secret the server issued, so a test can look for it in what a run saved. */
	issuedTotpSecrets: () => readonly string[]
	/** Closes the store. Teardown must not turn a completed run into a failed one: a failure is swallowed. */
	close: () => Promise<void>
}

/**
 * One reference, any store. `createStore` is required, and every caller supplies it by dynamic
 * import: a static import of a storage module would load that engine's driver for *every* backend,
 * and a missing optional runtime (node:sqlite behind a flag) would then take down paths that never
 * touch it.
 */
export async function createReference(options: ReferenceOptions, createStore: StoreFactory): Promise<Reference> {
	const state = await referenceState(options, createStore)
	return {
		close: () => closeStore(state),
		createdIds: () => createdIds(state),
		issuedTotpSecrets: () => [...state.totpSecrets],
		defects: state.defects,
		/* The same handler a listening server runs, without the socket. */
		fetch: asFetch((request) => handle(state, request)),
		principals: PRINCIPALS,
		snapshot: () => snapshot(state),
		url: `${IN_PROCESS_ORIGIN}${state.basePath}`,
	}
}

function resolveDialect(name: string | undefined): Dialect {
	const dialect = DIALECTS[name ?? "postgrest"]
	if (dialect === undefined) {
		throw new Error(`unknown dialect "${name}" — expected one of ${Object.keys(DIALECTS).join(", ")}`)
	}
	return dialect
}

export async function referenceState(options: ReferenceOptions, createStore: StoreFactory): Promise<ReferenceState> {
	const defects = new Defects(options.defects ?? [])
	const shape: ReferenceShape =
		typeof options.shape === "string" ? shapeNamed(options.shape).shape : (options.shape ?? {})
	const dialect = shapedDialect(resolveDialect(options.dialect), shape)
	const entities = shapedEntities(shape)
	const store = await createStore(defects, entities)
	const state: ReferenceState = {
		auth: newAuthState(options),
		basePath: shape.basePath ?? "",
		conventions: { ...DEFAULT_CONVENTIONS, ...shape.conventions },
		defects,
		dialect,
		entities,
		grants: new Map(),
		idempotent: new Map(),
		ids: new Ids(),
		inboxes: new Map(),
		job: entities.find((entity) => entity.name === "job") as EntityDef,
		jobStartedAt: new Map(),
		listingStore: defects.has("HIDDEN_FROM_CREATOR") ? withoutHidden(defects, store) : store,
		profiles: new Map(),
		totpSecrets: [],
		shape,
		slugOf: new Map(),
		staleSnapshot: new Map(),
		store,
		table: entities.find((entity) => entity.name === "table") as EntityDef,
		throttled: new Set(),
		untagged: options.untagged === true,
		updateMethod: shape.updateMethod ?? "PATCH",
	}
	if (shape.prepopulate !== undefined) await prepopulate(state, shape.prepopulate)
	serve(state)
	return state
}

/* From here on every issued id and stored record is one a client caused: the ids a run may ledger. */
function serve(state: ReferenceState): void {
	state.ids.serve()
	const { store } = state
	const insert = store.insert.bind(store)
	store.insert = async (entity, record) => {
		const stored = await insert(entity, record)
		state.ids.note(entity, stored[entity.identity])
		return stored
	}
}

/* The store as a listing sees it under HIDDEN_FROM_CREATOR: hidden rows are not there. */
function withoutHidden(defects: DefectSet, store: Store): Store {
	return new Proxy(store, {
		get(target, property) {
			const value = Reflect.get(target, property, target) as unknown
			if (property === "select") {
				return async (entity: EntityDef, query: Parameters<Store["select"]>[1]) =>
					(await target.select(entity, query)).filter((row) => !hiddenFromCreator(defects, entity, row))
			}
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

/** Closes the store. Teardown must not turn a completed run into a failed one. */
export async function closeStore(state: ReferenceState): Promise<void> {
	try {
		await state.store.close()
	} catch {
		/* A store that fails to close has nothing left to report. */
	}
}

/* A table's id, under `tableKey: "slug"`, is its slug: what a client could have ledgered. */
export function createdIds(state: ReferenceState): Record<string, string[]> {
	return {
		...Object.fromEntries(
			Object.entries(state.ids.caused).map(([name, ids]) => [
				name,
				[...new Set(name === state.table.name ? ids.map((id) => state.slugOf.get(id) ?? id) : ids)],
			]),
		),
		/* An account by the email it was made with, as teardown names it. */
		...(state.auth.registered.length === 0 ? {} : { account: [...new Set(state.auth.registered)] }),
	}
}

export async function snapshot(state: ReferenceState): Promise<Record<string, Row[]>> {
	const out: Record<string, Row[]> = {}
	for (const entity of state.entities) {
		const rows = await state.store.select(entity, {
			collation: "binary",
			order: [],
			shuffleTies: false,
			where: { kind: "const", value: true },
		})
		/* Keyed by `id` whatever the identity is called, so the leak checks read every shape. */
		const known = state.shape.tableKey === "slug" && entity.name === state.table.name ? "slug" : entity.identity
		out[entity.name] = known === "id" ? rows : rows.map((row) => ({ ...row, id: row[known] }))
	}
	/* The accounts the register made, by the email they were made with: a leftover is named by it. */
	const registered = [...state.auth.accounts.values()].filter(
		(account) => !PRINCIPALS.some((principal) => principal.key === account.key),
	)
	/* The register makes each one with an email. */
	if (registered.length > 0) out["account"] = registered.map((account) => ({ id: account.email as string }))
	return out
}

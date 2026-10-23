/**
 * Ledgers every create a configured principal sends, as that principal, from the answer itself.
 *
 * Recording at each call site missed whatever a site did not foresee: a probe that writes under
 * another tenant's root, a create declared as PUT, a scenario's create. Every view's request
 * passes through `Client.request`, so the tracker reads each answer there, before the caller sees
 * it: a create the backend accepted becomes a record of whoever's credential it carried, scoped
 * where its own path put it.
 */

import type { OperationModel, SpecModel } from "../spec/graph/types.ts"
import { pathTemplateParams } from "../spec/routes.ts"
import type { Client } from "../client/client.ts"
import type { Exchange } from "./exchange.ts"
import { returnedId } from "./proven-id.ts"
import { SELF_IDENTITY } from "./self/operations.ts"
import type { Ledger } from "./teardown/ledger.ts"
import type { Owner } from "./teardown/types.ts"
import { makesAccount } from "./accounts/ops.ts"
import { inferredCreate } from "./inferred-create.ts"
import { isProbeExchange } from "./probe-judging.ts"
import { createdRecord } from "./world/created-record.ts"
import { idOf, recordsFromList } from "./world/records.ts"

/** A configured principal as the tracker needs it: who removes the record, and its roots. */
export interface TrackedOwner {
	owner: Owner
	/** The principal's root values: path parameters a create's own path may not name. */
	roots: Record<string, string>
}

/** What the tracker reads answers against. */
export interface TrackerInput {
	model: SpecModel
	ledger: Ledger
	/** Configured principals by id. A credential none of them holds is not tracked. */
	owners: ReadonlyMap<string, TrackedOwner>
	client: Client
	readable: (op: OperationModel) => boolean
	/** Called with every record the tracker ledgers. */
	onRecorded?: (entity: string, id: string) => void
	/**
	 * Who reads back, and removes, what a probe made with no configured principal's credential: an
	 * anonymous or forged write a backend let through. The first principal; without one, such a write
	 * is never tracked.
	 */
	stranger?: TrackedOwner
}

/** Each entity's create, read and list, by operation. */
interface Routes {
	creates: Map<string, { entity: string; identity: string; op: OperationModel }>
	reads: Map<string, { entity: string; op: OperationModel }>
	lists: Map<string, { entity: string; identity: string; op: OperationModel }>
}

interface Tracker {
	input: TrackerInput
	routes: Routes
}

/* The caller's own account is teardownPrincipal's. */
function routesOf(model: SpecModel): Routes {
	const routes: Routes = { creates: new Map(), lists: new Map(), reads: new Map() }
	const opOf = (operationId: string | undefined): OperationModel | undefined =>
		operationId === undefined ? undefined : model.byOperationId.get(operationId)
	for (const entity of model.entities.values()) {
		if (entity.identity === SELF_IDENTITY) continue
		const identity = entity.identity ?? "id"
		const create = opOf(entity.create)
		if (create !== undefined) routes.creates.set(create.operationId, { entity: entity.name, identity, op: create })
		const read = opOf(entity.read)
		if (read !== undefined) routes.reads.set(read.operationId, { entity: entity.name, op: read })
		const list = opOf(entity.list)
		if (list !== undefined) routes.lists.set(list.operationId, { entity: entity.name, identity, op: list })
	}
	return routes
}

/* The parameters an exchange's path gave the operation's own template. */
function paramsOf(client: Client, exchange: Exchange, op: OperationModel): Record<string, string> | null {
	return exchange.template === op.path && exchange.pathParams !== undefined
		? exchange.pathParams
		: pathTemplateParams(op.path, client.relativePath(exchange.url))
}

/* A principal read records back: under the read's id, or as the rows of a listing. */
function sight(tracker: Tracker, exchange: Exchange, principal: string): void {
	const { input, routes } = tracker
	const operationId = exchange.operationId ?? ""
	const read = routes.reads.get(operationId)
	if (read !== undefined) {
		const param = read.op.pathParams.at(-1)
		const id = param === undefined ? undefined : paramsOf(input.client, exchange, read.op)?.[param]
		if (id !== undefined) input.ledger.sighted(read.entity, id, principal)
		return
	}
	const list = routes.lists.get(operationId)
	if (list === undefined) return
	for (const row of recordsFromList(exchange.responseBody, list.op.collection)) {
		const id = idOf(row, list.identity)
		if (id !== undefined) input.ledger.sighted(list.entity, id, principal)
	}
}

/* A create a principal sent, ledgered as theirs where its own path put it. */
async function recordCreate(tracker: Tracker, exchange: Exchange, owned: TrackedOwner): Promise<void> {
	const { input, routes } = tracker
	const { ledger } = input
	const create = exchange.operationId === undefined ? undefined : routes.creates.get(exchange.operationId)
	/* The account a sign-up makes is the account ledger's, which removes it as itself or names it. */
	if (create !== undefined && makesAccount(create.op)) return
	if (create === undefined) {
		await recordInferred(tracker, exchange, owned)
		return
	}
	const { entity, identity, op } = create
	/* The exchange's parameters belong to the template it resolved to: the create's, unless the
	 * caller named the create for another path. */
	const params = paramsOf(input.client, exchange, op)
	if (params === null) {
		ledger.unidentified(entity, op.operationId, exchange)
		return
	}
	/* Where the record lives is where its path put it: a root the path names is the path's. */
	const scope = { ...owned.roots, ...params }
	const made = await createdRecord({
		client: input.client.view({ purpose: "assertion", subject: entity }),
		createOp: op,
		exchange,
		model: input.model,
		principal: owned.owner.id,
		readable: input.readable,
		scope,
		sent: exchange.requestBody,
	})
	const id = made === null ? undefined : returnedId(made.record, identity)
	/* An empty identity names nothing a delete could reach. */
	if (id === undefined || id === "") {
		ledger.unidentified(entity, op.operationId, exchange)
		return
	}
	ledger.record({ entity, id, scope }, owned.owner)
	input.onRecorded?.(entity, id)
}

/*
 * A POST that is not a create, ledgered as its sender's when its answer shows it made a record. One a
 * stranger's probe sent was applied whatever it made, so without that evidence it is reported as a
 * record that may remain.
 */
async function recordInferred(tracker: Tracker, exchange: Exchange, owned: TrackedOwner): Promise<void> {
	const { input } = tracker
	const stranger = exchange.principal === undefined || !input.owners.has(exchange.principal)
	const op = exchange.operationId === undefined ? undefined : input.model.byOperationId.get(exchange.operationId)
	const params = op === undefined ? null : paramsOf(input.client, exchange, op)
	const sender = { principal: owned.owner.id, roots: owned.roots }
	const made =
		op === undefined || params === null ? undefined : await inferredCreate(input, { exchange, op, params, sender })
	if (made !== undefined) {
		input.ledger.record(made, owned.owner)
		input.onRecorded?.(made.entity, made.id)
	} else if (stranger) {
		const operationId = exchange.operationId ?? `${exchange.method} ${input.client.relativePath(exchange.url)}`
		input.ledger.unidentified(op?.entity ?? operationId, operationId, exchange)
	}
}

/* Whose read and removal an answer falls to: its sender's, or the stranger's for a probe POST no principal sent. */
function ownerOf(input: TrackerInput, exchange: Exchange): TrackedOwner | undefined {
	if (exchange.principal !== undefined && input.owners.has(exchange.principal))
		return input.owners.get(exchange.principal)
	return isProbeExchange(exchange) && exchange.method === "POST" ? input.stranger : undefined
}

export function createTracker(input: TrackerInput): { observe: (exchange: Exchange) => Promise<void> } {
	const tracker: Tracker = { input, routes: routesOf(input.model) }
	const observe = async (exchange: Exchange): Promise<void> => {
		if (exchange.status < 200 || exchange.status >= 300) return
		/* Teardown reads back what it needs itself. */
		if (exchange.purpose === "teardown") return
		const owned = ownerOf(input, exchange)
		if (owned === undefined) return
		if (exchange.method === "GET") {
			sight(tracker, exchange, owned.owner.id)
			return
		}
		/* Seeding ledgers each create it makes through its own callbacks. */
		if (exchange.purpose === "seed") return
		/* What the credential store issued, a mint say, is the store's to revoke, never the ledger's. The
		 * same operation sent any other way, by a scenario or a raw request, is ledgered as usual. */
		if (exchange.issuedBy === "credentials") return
		await recordCreate(tracker, exchange, owned)
	}
	return { observe }
}

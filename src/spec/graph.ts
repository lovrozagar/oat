/**
 * Builds the entity graph — the model every scenario is planned against.
 *
 * The central move: `x-invalidate` is read as a graph edge, not a cache hint. Inverting it
 * gives each entity its *read surface*, the set of projections through which an instance is
 * observable. That set is the criss-cross matrix.
 */

import { deriveCollectionShape, deriveIdentity, requestSchema, successSchema } from "./collection.ts"
import type { CollectionShape } from "./collection.ts"
import {
	type AsyncSpec,
	type EffectSpec,
	type EntityAction,
	GapCollector,
	type QueryCapability,
	pathParameterNames,
	readAsync,
	readCleanup,
	readCost,
	readEffects,
	readEntity,
	readFlag,
	readGenerated,
	readImmutable,
	readInvalidate,
	readQueryCapability,
	readRootParams,
	readSoftDelete,
	readTenantParam,
	singularise,
} from "./extensions.ts"
import { parseRouteRef } from "./load.ts"
import {
	type Endpoint,
	MUTATING_METHODS,
	type OpenApiDocument,
	type OperationObject,
	listEndpoints,
} from "./types.ts"

export interface OperationModel {
	operationId: string
	method: string
	path: string
	route: string
	entity: string | null
	action: EntityAction | null
	entitySource: "tag" | "heuristic" | null
	invalidates: string[]
	effects: EffectSpec[]
	async: AsyncSpec | null
	tenantParam: string | null
	pathParams: string[]
	rootParams: string[]
	queryParamNames: string[]
	documentedStatuses: number[]
	securitySchemes: string[]
	collection: CollectionShape | null
	identity: string | null
	query: QueryCapability | null
	immutable: string[]
	generated: string[]
	softDelete: string | null
	cost: "low" | "medium" | "high"
	destructive: boolean
	idempotent: boolean
	freshPrincipal: boolean
	cleanup: string | null
	hasRequestBody: boolean
	isMutation: boolean
}

export interface EntityModel {
	name: string
	identity: string | null
	create?: string
	list?: string
	read?: string
	update?: string
	delete?: string
	actions: string[]
	/** Read routes through which an instance is observable — the criss-cross matrix. */
	readSurface: string[]
	/** Read routes contributed by `x-invalidate` rather than by sibling inference. */
	declaredSurface: string[]
	tenantParams: string[]
	trackable: boolean
}

export interface SpecModel {
	operations: OperationModel[]
	byOperationId: Map<string, OperationModel>
	byRoute: Map<string, OperationModel>
	/** The untouched operation objects, keyed by id — schemas are read from here. */
	rawOperations: Map<string, OperationObject>
	entities: Map<string, EntityModel>
	roots: string[]
	gaps: GapCollector
	securitySchemes: string[]
	hasAuthOperations: boolean
}

export function buildModel(doc: OpenApiDocument): SpecModel {
	const gaps = new GapCollector()
	const endpoints = listEndpoints(doc)
	const operations = endpoints.map((e) => modelOperation(e, doc, gaps))

	demoteNonEntities(operations, gaps)

	const byOperationId = new Map(operations.map((o) => [o.operationId, o]))
	const byRoute = new Map(operations.map((o) => [o.route, o]))

	const entities = buildEntities(operations, byRoute, gaps)
	const roots = collectRoots(operations, entities)

	return {
		byOperationId,
		byRoute,
		entities,
		gaps,
		hasAuthOperations: operations.some((o) => /auth|login|token|session/i.test(o.path)),
		operations,
		rawOperations: new Map(endpoints.map((e) => [e.operationId, e.op])),
		roots,
		securitySchemes: Object.keys(doc.components?.securitySchemes ?? {}),
	}
}

function modelOperation(
	endpoint: Endpoint,
	doc: OpenApiDocument,
	gaps: GapCollector,
): OperationModel {
	const { op, method, path, operationId } = endpoint
	const responseSchema = successSchema(op)
	const collection = deriveCollectionShape(responseSchema)
	const bodySchema = requestSchema(op)
	const entity = readEntity(endpoint, gaps)
	const pathParams = pathParameterNames(path)
	const lastParam = pathParams.at(-1)

	const itemSchema = collection?.itemSchema ?? responseSchema
	const identity =
		entity?.identity ?? deriveIdentity(itemSchema, lastParam === undefined ? undefined : lastParam)

	const security = op.security ?? doc.security ?? []
	const securitySchemes = [...new Set(security.flatMap((group) => Object.keys(group)))]

	const documentedStatuses = Object.keys(op.responses ?? {})
		.map((s) => Number.parseInt(s, 10))
		.filter((n) => !Number.isNaN(n))
		.sort((a, b) => a - b)

	return {
		action: entity?.action ?? null,
		async: readAsync(op),
		cleanup: readCleanup(op),
		collection,
		cost: readCost(op),
		destructive: readFlag(op, "x-destructive"),
		documentedStatuses,
		effects: readEffects(op),
		entity: entity?.name ?? null,
		entitySource: entity?.source ?? null,
		freshPrincipal: readFlag(op, "x-fresh-principal"),
		generated: readGenerated(op, bodySchema),
		hasRequestBody: bodySchema !== null,
		identity,
		idempotent: readFlag(op, "x-idempotent"),
		immutable: readImmutable(op),
		invalidates: readInvalidate(op),
		isMutation: MUTATING_METHODS.has(method.toUpperCase()),
		method: method.toUpperCase(),
		operationId,
		path,
		pathParams,
		query: collection === null ? null : readQueryCapability(endpoint, collection.itemSchema, gaps),
		queryParamNames: (op.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name),
		rootParams: readRootParams(op),
		route: `${method.toUpperCase()} ${path}`,
		securitySchemes,
		softDelete: readSoftDelete(op),
		tenantParam: readTenantParam(endpoint, gaps),
	}
}

const PARAM_SEGMENT = /^\{[^}]+\}$/

/**
 * The naming heuristic cannot tell a collection from a verb: `POST /tables/{id}/duplicate` and
 * `POST /tables` are the same shape. The document itself settles it — a noun names an entity
 * only if the API exposes an *item route* for it (`.../<noun>/{param}`), or if a GET on the
 * collection returns a collection-shaped body.
 *
 * Everything else is an action on the nearest enclosing entity. Without this pass a spec with
 * 5 entities models as 24, and every spurious one drags a full lifecycle plan behind it.
 */
function demoteNonEntities(operations: OperationModel[], gaps: GapCollector): void {
	const nounsWithItemRoute = new Set<string>()
	for (const op of operations) {
		const segments = op.path.split("/").filter(Boolean)
		for (let i = 1; i < segments.length; i++) {
			const seg = segments[i]
			const prev = segments[i - 1]
			if (seg === undefined || prev === undefined) continue
			if (PARAM_SEGMENT.test(seg) && !PARAM_SEGMENT.test(prev)) {
				nounsWithItemRoute.add(singularise(prev))
			}
		}
	}

	for (const op of operations) {
		if (op.entity === null || op.entitySource === "tag") continue
		if (nounsWithItemRoute.has(op.entity)) continue

		const collectionShaped = op.method === "GET" && op.collection !== null
		if (collectionShaped) {
			/* A collection-shaped GET with no item route is usually a named view of another
			 * entity (`/table-templates/mine`). oat cannot know which, so it says so. */
			gaps.record(
				op.operationId,
				"x-entity",
				`returns a collection but exposes no item route, so oat treats "${op.entity}" as its ` +
					"own entity. If it is a filtered view of another entity, name that entity explicitly",
			)
			continue
		}

		const parent = enclosingEntity(op.path, nounsWithItemRoute)
		op.entity = parent
		op.action = parent === null ? null : "action"
	}
}

/** Nearest ancestor segment in the path that names a real entity. */
function enclosingEntity(path: string, entities: ReadonlySet<string>): string | null {
	const segments = path.split("/").filter(Boolean)
	for (let i = segments.length - 1; i >= 0; i--) {
		const seg = segments[i]
		if (seg === undefined || PARAM_SEGMENT.test(seg)) continue
		const name = singularise(seg)
		if (entities.has(name)) return name
	}
	return null
}

function buildEntities(
	operations: OperationModel[],
	byRoute: Map<string, OperationModel>,
	gaps: GapCollector,
): Map<string, EntityModel> {
	const entities = new Map<string, EntityModel>()

	const get = (name: string): EntityModel => {
		const existing = entities.get(name)
		if (existing !== undefined) return existing
		const created: EntityModel = {
			actions: [],
			declaredSurface: [],
			identity: null,
			name,
			readSurface: [],
			tenantParams: [],
			trackable: false,
		}
		entities.set(name, created)
		return created
	}

	for (const op of operations) {
		if (op.entity === null || op.action === null) continue
		const entity = get(op.entity)
		if (entity.identity === null && op.identity !== null) entity.identity = op.identity
		if (op.tenantParam !== null && !entity.tenantParams.includes(op.tenantParam)) {
			entity.tenantParams.push(op.tenantParam)
		}
		switch (op.action) {
			case "create":
				entity.create = op.operationId
				break
			case "list":
				entity.list = op.operationId
				break
			case "read":
				entity.read = op.operationId
				break
			case "update":
				entity.update = op.operationId
				break
			case "delete":
				entity.delete = op.operationId
				break
			case "action":
				entity.actions.push(op.operationId)
				break
		}
	}

	/* Invert x-invalidate: a mutator's declared read routes belong to its entity's surface. */
	for (const op of operations) {
		if (op.entity === null || op.invalidates.length === 0) continue
		const entity = get(op.entity)
		for (const ref of op.invalidates) {
			const parsed = parseRouteRef(ref)
			if (parsed === null || parsed.method !== "GET") continue
			if (!entity.readSurface.includes(ref)) {
				entity.readSurface.push(ref)
				entity.declaredSurface.push(ref)
			}
			if (!byRoute.has(ref)) {
				gaps.record(
					op.operationId,
					"x-invalidate",
					`names "${ref}", which is not an operation in this document`,
				)
			}
		}
	}

	/* Sibling fallback for entities whose mutators declared nothing. */
	for (const entity of entities.values()) {
		if (entity.readSurface.length > 0) continue
		for (const opId of [entity.list, entity.read]) {
			if (opId === undefined) continue
			const op = operations.find((o) => o.operationId === opId)
			if (op !== undefined) entity.readSurface.push(op.route)
		}
		if (entity.readSurface.length > 0 && (entity.create ?? entity.update ?? entity.delete)) {
			gaps.record(
				entity.create ?? entity.update ?? entity.delete ?? entity.name,
				"x-invalidate",
				`entity "${entity.name}" has mutators but no declared read surface; ` +
					`falling back to sibling routes ${entity.readSurface.join(", ")}`,
			)
		}
	}

	for (const entity of entities.values()) {
		entity.trackable = entity.identity !== null
		if (!entity.trackable && (entity.create !== undefined || entity.update !== undefined)) {
			gaps.record(
				entity.create ?? entity.update ?? entity.name,
				"x-entity.identity",
				`entity "${entity.name}" has no discoverable identity property, so instances cannot ` +
					"be tracked across projections; lifecycle and criss-cross coverage disabled",
			)
		}
	}

	return entities
}

/**
 * A path parameter is a root when nothing in the document can produce it: no entity whose name
 * matches has a create operation. Roots must be supplied by config before a run starts —
 * discovering them late is what turns one missing fixture into a cascade of failures.
 */
function collectRoots(
	operations: OperationModel[],
	entities: Map<string, EntityModel>,
): string[] {
	const roots = new Set<string>()
	for (const op of operations) {
		for (const param of op.rootParams) roots.add(param)
	}
	for (const op of operations) {
		for (const param of op.pathParams) {
			/* Resolve the entity from the segment the parameter qualifies, not from its name:
			 * `/table-templates/{template_id}` identifies a `table-template`, and matching on
			 * the name alone would invent a phantom `template` root. */
			const implied = owningEntityName(op.path, param) ?? impliedEntityName(param)
			if (implied === null) continue
			const entity = entities.get(implied)
			if (entity === undefined || entity.create === undefined) roots.add(param)
		}
	}
	return [...roots].sort()
}

/** The collection segment immediately preceding `{param}` in the path. */
export function owningEntityName(path: string, param: string): string | null {
	const segments = path.split("/").filter(Boolean)
	const index = segments.indexOf(`{${param}}`)
	if (index <= 0) return null
	const previous = segments[index - 1]
	if (previous === undefined || PARAM_SEGMENT.test(previous)) return null
	return singularise(previous)
}

/** `{project_id}` → `project`, `{tableId}` → `table`. */
export function impliedEntityName(param: string): string | null {
	const stripped = param
		.replace(/[_.]?(id|slug|uuid|key)$/i, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
	return stripped.length === 0 ? null : stripped.replace(/_/g, "-")
}

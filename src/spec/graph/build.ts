/**
 * Builds the entity graph — the model every scenario is planned against.
 *
 * The central move: `x-invalidate` is read as a graph edge, not a cache hint. Inverting it
 * gives each entity its *read surface*, the set of projections through which an instance is
 * observable. That set is the criss-cross matrix.
 */

import { listEndpoints } from "../endpoints.ts"
import { GapCollector } from "../extensions/gaps.ts"
import { documentDefs } from "../load/defs.ts"
import { readSchemes } from "../security/schemes.ts"
import type { OpenApiDocument } from "../types.ts"
import { recordDangling } from "./dangling.ts"
import { demoteNonEntities } from "./demote.ts"
import { registerOperations } from "./entities.ts"
import { separateSameNamedCollections } from "./naming.ts"
import { modelOperation } from "./operation.ts"
import { collectRoots } from "./roots.ts"
import { fallBackToSiblings, invertInvalidate, markTrackable } from "./surface.ts"
import type { EntityModel, OperationModel, SpecModel } from "./types.ts"
import { recordUnmodeled, recordUnsendable } from "./unmodeled.ts"
import { parseRouteRef } from "../routes.ts"

export function buildModel(doc: OpenApiDocument): SpecModel {
	const gaps = new GapCollector()
	const endpoints = listEndpoints(doc)
	const operations = endpoints.map((e) => modelOperation(e, doc, gaps))
	recordUnsendable(operations, gaps)
	const defs = documentDefs(doc)
	recordDangling(endpoints, operations, { defs, gaps })

	const views = demoteNonEntities(operations, gaps)
	separateSameNamedCollections(operations)
	/* Named once the entities have their final names: a split `member` is `org-member` here. */
	for (const op of views) {
		gaps.record(
			op.operationId,
			"x-entity",
			`returns a collection but exposes no item route, so oat treats "${op.entity}" as its ` +
				"own entity. If it is a filtered view of another entity, name that entity explicitly",
		)
	}

	const byOperationId = indexByOperationId(operations, gaps)
	const byRoute = new Map(operations.map((o) => [o.route, o]))
	const entities = buildEntities(operations, byRoute, gaps)
	reportMissingCleanup(operations, byRoute, gaps)
	recordUnmodeled(doc, gaps)

	return {
		byOperationId,
		byRoute,
		entities,
		gaps,
		hasAuthOperations: operations.some((o) => /auth|login|token|session/i.test(o.path)),
		operations,
		/* First wins, like `byOperationId`. */
		rawOperations: new Map(endpoints.toReversed().map((e) => [e.operationId, e.op])),
		defs,
		roots: collectRoots(operations, entities),
		securitySchemes: Object.keys(doc.components?.securitySchemes ?? {}),
		schemes: readSchemes(doc),
	}
}

/* An `x-cleanup` naming a route the document lacks removes nothing: teardown would leave its records. */
function reportMissingCleanup(
	operations: readonly OperationModel[],
	byRoute: ReadonlyMap<string, OperationModel>,
	gaps: GapCollector,
): void {
	for (const op of operations) {
		const route = op.cleanup === null ? null : parseRouteRef(op.cleanup)
		if (route === null || byRoute.has(`${route.method} ${route.path}`)) continue
		gaps.record(op.operationId, "x-cleanup", `names "${op.cleanup}", which is not an operation in this document`)
	}
}

/*
 * Two operations sharing an id would silently become one. The first keeps the id; the other is
 * reported, since findings, scope and `--ops` all name operations by it.
 */
function indexByOperationId(operations: readonly OperationModel[], gaps: GapCollector): Map<string, OperationModel> {
	const byOperationId = new Map<string, OperationModel>()
	for (const op of operations) {
		const first = byOperationId.get(op.operationId)
		if (first === undefined) {
			byOperationId.set(op.operationId, op)
			continue
		}
		gaps.record(
			op.operationId,
			"operationId",
			`is declared by both ${first.route} and ${op.route}; operation ids must be unique, so ` +
				`${op.route} is reachable only by its route`,
		)
	}
	return byOperationId
}

function buildEntities(
	operations: readonly OperationModel[],
	byRoute: ReadonlyMap<string, OperationModel>,
	gaps: GapCollector,
): Map<string, EntityModel> {
	const entities = new Map<string, EntityModel>()
	registerOperations(entities, operations)
	invertInvalidate(entities, { byRoute, operations }, gaps)
	fallBackToSiblings(entities, operations, gaps)
	markTrackable(entities, gaps)
	return entities
}

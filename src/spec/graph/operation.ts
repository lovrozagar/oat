/** One operation read into the model: its tags, its contract, and what its query parameters mean. */

import { ambiguousRows, type CollectionShape, deriveCollectionShape } from "../collection/shape.ts"
import { documentsEventStream, successSchema } from "../collection/responses.ts"
import { hasRequestBody, requestSchema } from "../collection/request.ts"
import { deriveQueryConventions } from "../conventions/derive.ts"
import type { GapCollector } from "../extensions/gaps.ts"
import { pathParameterNames, readRootParams, readTenantParam, readTenantSource } from "../extensions/tenant.ts"
import { readAsync, readWait } from "../extensions/async.ts"
import { readCleanup, readInvalidate } from "../extensions/routes.ts"
import { readConsistency } from "../extensions/consistency.ts"
import {
	readCost,
	readFeatureGate,
	readFlag,
	readGenerated,
	readImmutable,
	readRateLimit,
	readSoftDelete,
} from "../extensions/flags.ts"
import { readCreatedIdFrom, readEntity, readRecordPath } from "../extensions/entity.ts"
import { readEffects } from "../extensions/effects.ts"
import { readInvite } from "../extensions/invite.ts"
import { readPrivileged, requiredPrivileged } from "../extensions/privileged.ts"
import { readQueryCapability } from "../extensions/query-tag.ts"
import { ext, extObject } from "../extensions/tag.ts"
import { readUnique } from "../extensions/unique.ts"
import { MUTATING, unsendableReason } from "../methods.ts"
import type { QueryTag } from "../query/tag.ts"
import { resolveSecurity } from "../security/requirements.ts"
import { validateTags } from "../tags/validate.ts"
import type { Endpoint, OpenApiDocument, JsonSchema } from "../types.ts"
import { operationIdentity } from "./identity.ts"
import {
	idempotencyHeader,
	readParamStyles,
	readRequiredCookies,
	readRequiredHeaders,
	readRequiredQuery,
	successResponseHeaders,
} from "./parameters.ts"
import { isParamSegment, segmentsOf } from "./segments.ts"
import { readStatuses } from "./statuses.ts"
import type { OperationModel } from "./types.ts"

/** What the facts are read from: the endpoint, and what was derived from it first. */
interface Reading {
	endpoint: Endpoint
	gaps: GapCollector
	collection: CollectionShape | null
	recordPath: string | null
	bodySchema: JsonSchema | null
	entity: ReturnType<typeof readEntity>
	pathParams: string[]
	identity: Pick<OperationModel, "identity" | "identitySource">
	security: OperationModel["security"]
	statuses: OperationModel["statuses"]
}

/* The model's fields, split where they are read; gaps are recorded in field order. */
type ContractFacts =
	| "action"
	| "async"
	| "eventStream"
	| "cleanup"
	| "collection"
	| "createdIdFrom"
	| "recordPath"
	| "cost"
	| "featureGate"
	| "unique"
	| "destructive"
	| "documentedStatuses"
	| "statuses"

export function modelOperation(endpoint: Endpoint, doc: OpenApiDocument, gaps: GapCollector): OperationModel {
	const reading = readOperation(endpoint, doc, gaps)
	return { ...contractFacts(reading), ...behaviorFacts(reading), ...requestFacts(reading) }
}

function readOperation(endpoint: Endpoint, doc: OpenApiDocument, gaps: GapCollector): Reading {
	const { op, path, operationId } = endpoint
	const responseSchema = successSchema(op)
	const recordPath = readRecordPath(endpoint)
	const collection = deriveCollectionShape(responseSchema, recordPath)
	reportAmbiguousRows(endpoint, { recordPath, schema: responseSchema }, gaps)
	const bodySchema = requestSchema(op)
	validateTags(op, operationId, gaps)
	const entity = readEntity(endpoint, gaps)
	const pathParams = pathParameterNames(path)
	const itemSchema = collection?.itemSchema ?? responseSchema
	return {
		bodySchema,
		collection,
		endpoint,
		entity,
		gaps,
		identity: operationIdentity(entity?.identity, itemSchema, { path, pathParams }),
		pathParams,
		recordPath,
		security: readSecurity(endpoint, doc, gaps),
		statuses: readStatuses(op.responses),
	}
}

/* The operation's requirement, with a gap for each scheme whose scopes are not a list. */
function readSecurity({ op, operationId }: Endpoint, doc: OpenApiDocument, gaps: GapCollector): Reading["security"] {
	const security = resolveSecurity(op, doc)
	for (const scheme of security.malformedScopes) {
		gaps.record(
			operationId,
			"security",
			`security requirement "${scheme}" gives its scopes as something other than a list; oat reads it as no scopes`,
		)
	}
	return security
}

/* The success response's body: its schema, and where `x-entity.recordPath` says the rows are. */
interface SuccessBody {
	schema: JsonSchema | null
	recordPath: string | null
}

/** Only a listing has rows to name: a record that holds several arrays is just a record. */
function reportAmbiguousRows(endpoint: Endpoint, { recordPath, schema }: SuccessBody, gaps: GapCollector): void {
	const lastSegment = segmentsOf(endpoint.path).at(-1) ?? ""
	const listing = endpoint.method.toUpperCase() === "GET" && !isParamSegment(lastSegment)
	const ambiguous = recordPath === null && listing ? ambiguousRows(schema) : []
	if (ambiguous.length === 0) return
	gaps.record(
		endpoint.operationId,
		"x-entity.recordPath",
		`the response holds several arrays of objects (${ambiguous.join(", ")}), so oat cannot tell which ` +
			'are the rows; name them with x-entity.recordPath (e.g. "$.' +
			`${ambiguous[0]}")`,
	)
}

function contractFacts(reading: Reading): Pick<OperationModel, ContractFacts> {
	const { endpoint, gaps } = reading
	const { op } = endpoint
	return {
		action: reading.entity?.action ?? null,
		async: readAsync(op),
		eventStream: documentsEventStream(op),
		cleanup: readCleanup(op),
		collection: reading.collection,
		createdIdFrom: readCreatedIdFrom(endpoint),
		recordPath: reading.recordPath,
		cost: readCost(op),
		featureGate: readFeatureGate(op),
		unique: readUnique(op, endpoint.operationId, gaps),
		destructive: readFlag(op, "x-destructive", true),
		documentedStatuses: reading.statuses.exact,
		statuses: reading.statuses,
	}
}

function behaviorFacts(reading: Reading) {
	const { endpoint, gaps } = reading
	const { op, operationId, path } = endpoint
	const effects = ext(op, "x-effects")
	const method = endpoint.method.toUpperCase()
	return {
		consistency: readConsistency(op),
		effects: readEffects(op, operationId, gaps),
		noEffects: Array.isArray(effects) && effects.length === 0,
		entity: reading.entity?.name ?? null,
		entitySource: reading.entity?.source ?? null,
		freshPrincipal: readFlag(op, "x-fresh-principal"),
		generated: readGenerated(op, reading.bodySchema),
		hasRequestBody: hasRequestBody(op),
		...reading.identity,
		idempotent: readFlag(op, "x-idempotent"),
		immutable: readImmutable(op),
		invalidates: readInvalidate(op),
		rateLimit: readRateLimit(op),
		isMutation: MUTATING.has(method),
		unsendable: unsendableReason(method),
		method,
		operationId,
		path,
		pathParams: reading.pathParams,
		...privilegedFacts(reading),
	}
}

/* The request body properties marked x-privileged, and those of them the body requires. */
function privilegedFacts(reading: Reading): { privileged: string[]; privilegedRequired: string[] } {
	const { bodySchema: body, endpoint, gaps } = reading
	const privileged = readPrivileged(endpoint.op, { body, gaps, operationId: endpoint.operationId })
	return { privileged, privilegedRequired: requiredPrivileged(body, privileged) }
}

/** Whether a success response, by its code or the `2XX` range, declares an `ETag` header. */
function declaresEtag(op: Endpoint["op"]): boolean {
	const responses = (op.responses ?? {}) as Record<string, { headers?: Record<string, unknown> }>
	return Object.entries(responses).some(
		([status, response]) =>
			/^2(\d\d|XX)$/i.test(status) &&
			Object.keys(response?.headers ?? {}).some((name) => name.toLowerCase() === "etag"),
	)
}

function requestFacts(reading: Reading) {
	const { endpoint, gaps, collection } = reading
	const { op, operationId } = endpoint
	const parameters = op.parameters ?? []
	return {
		query: collection === null ? null : readQueryCapability(endpoint, collection.itemSchema, gaps),
		conventions: deriveQueryConventions(parameters, collection, {
			declared: extObject<QueryTag>(op, "x-query"),
			onGuess: (message) => gaps.record(operationId, "x-query", message),
			responseHeaders: successResponseHeaders(op),
		}),
		queryParamNames: parameters.filter((p) => p.in === "query").map((p) => p.name),
		requiredQuery: readRequiredQuery(parameters),
		requiredHeaders: readRequiredHeaders(op),
		requiredCookies: readRequiredCookies(parameters),
		paramStyles: readParamStyles(parameters),
		idempotencyHeader: idempotencyHeader(op),
		etag: declaresEtag(op),
		ifMatch: parameters.find((p) => p.in === "header" && p.name.toLowerCase() === "if-match")?.name ?? null,
		rootParams: readRootParams(op),
		route: `${endpoint.method.toUpperCase()} ${endpoint.path}`,
		securitySchemes: [...new Set(reading.security.alternatives.flat().map((requirement) => requirement.scheme))],
		security: reading.security,
		softDelete: readSoftDelete(op),
		invite: readInvite(op),
		wait: readWait(op),
		tenantParam: readTenantParam(endpoint, gaps),
		tenantSource: readTenantSource(endpoint),
	}
}

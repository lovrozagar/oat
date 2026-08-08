/**
 * Run orchestrator: model → world → checks → findings.
 *
 * The world is seeded once and outlives every check. A seeding failure is recorded once and
 * everything downstream is reported BLOCKED against that single cause, rather than re-failing
 * per case — which is what made prior attempts produce dozens of failures from one broken fixture.
 */

import { buildModel, type EntityModel, type SpecModel } from "../spec/graph.ts"
import { dereference, loadSpec } from "../spec/load.ts"
import { CHECKS, type CheckContext } from "./checks.ts"
import { Client } from "./client.ts"
import { type Finding, FindingCollector } from "./finding.ts"
import { SchemaValidator } from "./validate.ts"
import { type Record_, type Scope, SeedError, resolveScope, seedCohort } from "./world.ts"

export interface PrincipalSpec {
	id: string
	/** Static headers, or an acquire step resolved against the spec. */
	headers?: Record<string, string>
	acquire?: {
		operationId: string
		body: unknown
		credentialFrom: string
		header?: string
		template?: string
	}
	roots?: Record<string, string>
}

export interface RunOptions {
	spec: string
	baseUrl: string
	principals: PrincipalSpec[]
	roots?: Record<string, string>
	seed?: number
	cohortSize?: number
	globalHeaders?: Record<string, string>
	only?: string[]
}

export interface RunResult {
	findings: Finding[]
	model: SpecModel
	client: Client
	entitiesTested: string[]
	checksRun: string[]
}

function readPointer(body: unknown, pointer: string): unknown {
	const path = pointer.replace(/^\$\.?/, "").split(".").filter(Boolean)
	let node: unknown = body
	for (const segment of path) {
		if (node === null || typeof node !== "object") return undefined
		node = (node as Record<string, unknown>)[segment]
	}
	return node
}

async function acquire(
	principal: PrincipalSpec,
	model: SpecModel,
	client: Client,
): Promise<Record<string, string>> {
	if (principal.acquire === undefined) return principal.headers ?? {}
	const op = model.byOperationId.get(principal.acquire.operationId)
	if (op === undefined) {
		throw new Error(
			`oat: principal "${principal.id}" names operation "${principal.acquire.operationId}", ` +
				"which is not in the document",
		)
	}
	const exchange = await client.request(op.method, op.path, { body: principal.acquire.body })
	if (exchange.status >= 300) {
		throw new Error(
			`oat: acquiring credential for "${principal.id}" via ${op.operationId} returned ` +
				`${exchange.status}: ${JSON.stringify(exchange.responseBody).slice(0, 200)}`,
		)
	}
	const credential = readPointer(exchange.responseBody, principal.acquire.credentialFrom)
	if (typeof credential !== "string") {
		throw new Error(
			`oat: ${principal.acquire.credentialFrom} did not resolve to a string in the response of ` +
				op.operationId,
		)
	}
	const header = principal.acquire.header ?? "authorization"
	const template = principal.acquire.template ?? "Bearer {credential}"
	return { ...principal.headers, [header]: template.replace("{credential}", credential) }
}

function testableEntities(model: SpecModel, only?: string[]): EntityModel[] {
	return [...model.entities.values()]
		.filter((entity) => entity.list !== undefined && entity.create !== undefined && entity.trackable)
		.filter((entity) => only === undefined || only.length === 0 || only.includes(entity.name))
		.sort((a, b) => a.name.localeCompare(b.name))
}

export async function run(options: RunOptions): Promise<RunResult> {
	const raw = await loadSpec(options.spec)
	const { doc } = dereference(raw)
	const model = buildModel(doc)
	const client = new Client(options.baseUrl, options.globalHeaders ?? {})
	const findings = new FindingCollector()
	const validator = new SchemaValidator()
	const seed = options.seed ?? 1

	const [primary, secondary] = options.principals
	if (primary === undefined) throw new Error("oat: at least one principal is required")

	const primaryHeaders = await acquire(primary, model, client)
	const secondaryHeaders =
		secondary === undefined ? undefined : await acquire(secondary, model, client)

	const entitiesTested: string[] = []
	const checksRun = new Set<string>()

	for (const entity of testableEntities(model, options.only)) {
		const listOp = model.byOperationId.get(entity.list ?? "")
		const createOp = model.byOperationId.get(entity.create ?? "")
		if (listOp === undefined || createOp === undefined) continue

		const rootValues = { ...options.roots, ...primary.roots }
		let scope: Scope
		let records: Record_[]
		try {
			scope = await resolveScope(createOp, model, client, {
				authHeaders: () => primaryHeaders,
				roots: rootValues,
				seed,
			})
			const cohort = await seedCohort(
				createOp,
				model,
				client,
				{
					authHeaders: () => primaryHeaders,
					...(options.cohortSize === undefined ? {} : { cohortSize: options.cohortSize }),
					roots: rootValues,
					seed,
				},
				scope,
			)
			records = cohort.records
		} catch (error) {
			const cause = error instanceof SeedError ? error.cause_ : "unknown"
			findings.blocked(
				"world.seed",
				entity.name,
				`could not seed "${entity.name}"`,
				`${cause}: ${error instanceof Error ? error.message : String(error)}`,
			)
			continue
		}

		let altScope: Record<string, string> | undefined
		if (secondary !== undefined && secondaryHeaders !== undefined) {
			try {
				const resolved = await resolveScope(listOp, model, client, {
					authHeaders: () => secondaryHeaders,
					roots: { ...options.roots, ...secondary.roots },
					seed: seed + 1,
				})
				altScope = resolved.values
			} catch {
				/* No isolated tenant available — the isolation checks simply do not apply. */
			}
		}

		const ctx: CheckContext = {
			altAuth: secondaryHeaders === undefined ? undefined : () => secondaryHeaders,
			altScope,
			auth: () => primaryHeaders,
			client,
			collectionKey: listOp.collection?.key ?? null,
			createOp,
			deleteOp: model.byOperationId.get(entity.delete ?? ""),
			entityName: entity.name,
			findings,
			identity: entity.identity ?? "id",
			listOp,
			model,
			query: listOp.query,
			readOp: model.byOperationId.get(entity.read ?? ""),
			records,
			scope: scope.values,
			softDelete: listOp.softDelete,
			seed,
			updateOp: model.byOperationId.get(entity.update ?? ""),
			validator,
		}

		entitiesTested.push(entity.name)

		for (const check of CHECKS) {
			if (!check.applicable(ctx)) continue
			/* Cascade suppression: a check whose premise is already known broken would report a
			 * consequence, not a defect. One root cause, one finding. */
			const blockedBy = check.dependsOn?.find((dependency) =>
				findings.findings.some((f) => f.check === dependency && f.entity === entity.name),
			)
			if (blockedBy !== undefined) continue
			checksRun.add(check.id)
			try {
				await check.run(ctx)
			} catch (error) {
				findings.gap(
					check.id,
					entity.name,
					`check "${check.id}" could not complete`,
					error instanceof Error ? error.message : String(error),
				)
			}
		}
	}

	return {
		checksRun: [...checksRun].sort(),
		client,
		entitiesTested,
		findings: findings.findings,
		model,
	}
}

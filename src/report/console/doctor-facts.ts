import type { Hooks } from "../../config/types/hooks.ts"
import type { Gap } from "../../spec/extensions/gaps.ts"
import { untestableEntityReason } from "../../runtime/scope/entities.ts"
import type { EntityModel, SpecModel } from "../../spec/graph/types.ts"
import { type CatalogConfig, entityQueryCatalogs, type QueryCatalog } from "./catalog.ts"
import { hasInvite, type InvitingEntity, sortedEntities } from "./describe.ts"
import { type Roots, rootsOf } from "./roots.ts"
import { type SecurityCredentials, type SecurityFacts, securityFacts } from "./security.ts"

export interface DoctorConfig extends CatalogConfig {
	/** Operations config `allow` took out of the document. */
	allowRemoved?: string[]
	/** Operations the config's security recipes send: neither their gaps nor the entities they own are reported. */
	authCreates?: ReadonlySet<string>
	/** The config's recipes and principals: with them, an operation no principal can send blocks. */
	credentials?: SecurityCredentials
	hooks?: Pick<Hooks, "resolveQueryCapabilities" | "resolvePathValue">
}

/** What `doctor` found in a document, before it is printed as text or JSON. */
export interface DoctorFacts {
	entities: EntityModel[]
	/** Entities a run seeds and checks, by the answer the run itself gives (`untestableEntityReason`). */
	testable: EntityModel[]
	/** Every other entity, and why a run cannot test it. */
	untestable: Array<{ entity: string; reason: string }>
	/** Entities with an identity and a read. */
	trackable: EntityModel[]
	/** Testable entities with a list: the ones query checks can run on. */
	listable: EntityModel[]
	/** The document's gaps, less those on an operation a recipe sends: a sign-in call is no entity to tag. */
	gaps: Gap[]
	gapsByTag: Map<string, Gap[]>
	/**
	 * Untestable entities, plus one when a root has to be supplied, plus each operation the config's
	 * principals cannot send. Non-zero exits 1.
	 */
	blocking: number
	featureGates: Array<{ operationId: string; featureGate: string | null }>
	uniqueConstraints: Array<{ entity: string; unique: EntityModel["unique"] }>
	inviting: InvitingEntity[]
	catalogs: QueryCatalog[]
	unknownEntities: string[]
	security: SecurityFacts
	/** The document's roots: those the config supplies, and those a run would still lack. */
	roots: Roots
}

function gapsByTag(gaps: readonly Gap[]): Map<string, Gap[]> {
	const byTag = new Map<string, Gap[]>()
	for (const gap of gaps) {
		const list = byTag.get(gap.tag) ?? []
		list.push(gap)
		byTag.set(gap.tag, list)
	}
	return byTag
}

/** Everything `doctor` reports on, gathered once for both its text and its JSON. */
export function doctorFacts(model: SpecModel, config?: DoctorConfig): DoctorFacts {
	const authCreates = config?.authCreates ?? new Set<string>()
	const entities = sortedEntities(model, authCreates)
	const gaps = model.gaps.gaps.filter((gap) => !authCreates.has(gap.operationId))
	const untestable = entities.flatMap((entity) => {
		const reason = untestableEntityReason(entity, model, authCreates)
		return reason === null ? [] : [{ entity: entity.name, reason }]
	})
	const testable = entities.filter((entity) => !untestable.some((row) => row.entity === entity.name))
	const security = securityFacts(model, config?.credentials)
	const roots = rootsOf(model, config ?? {})
	return {
		blocking: untestable.length + (roots.required.length > 0 ? 1 : 0) + security.blocking,
		entities,
		featureGates: model.operations
			.filter((op) => op.featureGate !== null)
			.map((op) => ({ operationId: op.operationId, featureGate: op.featureGate })),
		gaps,
		gapsByTag: gapsByTag(gaps),
		inviting: entities.filter(hasInvite),
		listable: testable.filter((e) => e.list !== undefined),
		testable,
		trackable: entities.filter((e) => e.trackable && e.readSurface.length > 0),
		uniqueConstraints: entities
			.filter((entity) => entity.unique !== null)
			.map((entity) => ({ entity: entity.name, unique: entity.unique })),
		roots,
		security,
		untestable,
		...entityQueryCatalogs(model, config),
	}
}

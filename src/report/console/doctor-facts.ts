import type { Gap } from "../../spec/extensions/gaps.ts"
import type { EntityModel, SpecModel } from "../../spec/graph/types.ts"
import { type CatalogConfig, entityQueryCatalogs, type QueryCatalog } from "./catalog.ts"
import { hasInvite, type InvitingEntity, sortedEntities } from "./describe.ts"

export interface DoctorConfig extends CatalogConfig {
	/** Operations config `allow` took out of the document. */
	allowRemoved?: string[]
	/** Operations the config's security recipes send: neither their gaps nor the entities they own are reported. */
	authCreates?: ReadonlySet<string>
}

/** What `doctor` found in a document, before it is printed as text or JSON. */
export interface DoctorFacts {
	entities: EntityModel[]
	/** Entities with an identity and a read: the ones a run can follow. */
	trackable: EntityModel[]
	listable: EntityModel[]
	/** The document's gaps, less those on an operation a recipe sends: a sign-in call is no entity to tag. */
	gaps: Gap[]
	gapsByTag: Map<string, Gap[]>
	/** Untrackable entities, plus one when a root has to be supplied. Non-zero exits 1. */
	blocking: number
	featureGates: Array<{ operationId: string; featureGate: string | null }>
	uniqueConstraints: Array<{ entity: string; unique: EntityModel["unique"] }>
	inviting: InvitingEntity[]
	catalogs: QueryCatalog[]
	unknownEntities: string[]
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
	const trackable = entities.filter((e) => e.trackable && e.readSurface.length > 0)
	return {
		blocking: entities.length - trackable.length + (model.roots.length > 0 ? 1 : 0),
		entities,
		featureGates: model.operations
			.filter((op) => op.featureGate !== null)
			.map((op) => ({ operationId: op.operationId, featureGate: op.featureGate })),
		gaps,
		gapsByTag: gapsByTag(gaps),
		inviting: entities.filter(hasInvite),
		listable: trackable.filter((e) => e.list !== undefined),
		trackable,
		uniqueConstraints: entities
			.filter((entity) => entity.unique !== null)
			.map((entity) => ({ entity: entity.name, unique: entity.unique })),
		...entityQueryCatalogs(model, config),
	}
}

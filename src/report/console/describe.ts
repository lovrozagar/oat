import { authOwnedReason } from "../../runtime/scope/entities.ts"
import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { describeFilterGrammar } from "../../spec/render/filter-describe.ts"
import { describeSortGrammar } from "../../spec/render/sort-parse.ts"

/** A declared grammar, described, for one entity's list. */
export interface DeclaredGrammar {
	entity: string
	filter?: string
	sort?: string
}

/** `value` of `total` as a bar `width` cells wide; an empty total draws an empty rule. */
export function bar(value: number, total: number, width = 24): string {
	if (total === 0) return "─".repeat(width)
	const filled = Math.round((value / total) * width)
	return "█".repeat(filled) + "░".repeat(width - filled)
}

/** The lifecycle an entity has, as `CLRUD` with a dot for each missing operation. */
export function lifecycleGlyphs(entity: EntityModel): string {
	const slots: Array<[string, string | undefined]> = [
		["C", entity.create],
		["L", entity.list],
		["R", entity.read],
		["U", entity.update],
		["D", entity.delete],
	]
	return slots.map(([letter, opId]) => (opId === undefined ? "·" : letter)).join("")
}

/** How an invite is accepted: by following its link, or by posting its token. */
export function inviteAcceptMode(spec: NonNullable<EntityModel["invite"]>): string {
	if (spec.acceptFrom === "link") return "GET-link (x-invite.acceptFrom: link)"
	return `JSON token → ${spec.accept}`
}

/** An entity that declares an invite. */
export type InvitingEntity = EntityModel & { invite: NonNullable<EntityModel["invite"]> }

export function hasInvite(entity: EntityModel): entity is InvitingEntity {
	return entity.invite !== null
}

/** The entities sorted by name, less those the auth flow owns: what `plan` and `doctor` print, in order. */
export function sortedEntities(model: SpecModel, authCreates: ReadonlySet<string> = new Set()): EntityModel[] {
	return modelledEntities(model, authCreates).sort((a, b) => a.name.localeCompare(b.name))
}

/** The model's entities in document order, less those the auth flow owns, as a run leaves them out. */
export function modelledEntities(model: SpecModel, authCreates: ReadonlySet<string>): EntityModel[] {
	return [...model.entities.values()].filter((entity) => authOwnedReason(entity, model, authCreates) === null)
}

/** The operation that lists an entity. Its id is an operation's own, so the model holds it. */
export function listOperation(model: SpecModel, list: string): OperationModel {
	return model.byOperationId.get(list) as OperationModel
}

/** The grammars a document or config declared, per entity, as `plan` and `doctor` print them. */
export function declaredGrammars(model: SpecModel): DeclaredGrammar[] {
	return sortedEntities(model).flatMap((entity) => {
		if (entity.list === undefined) return []
		const { conventions } = listOperation(model, entity.list)
		const filter =
			conventions.filterGrammar === undefined ? undefined : describeFilterGrammar(conventions.filterGrammar)
		const sort = conventions.sortSpec === undefined ? undefined : describeSortGrammar(conventions.sortSpec)
		if (filter === undefined && sort === undefined) return []
		return [
			{ entity: entity.name, ...(filter === undefined ? {} : { filter }), ...(sort === undefined ? {} : { sort }) },
		]
	})
}

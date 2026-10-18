import type { SpecModel } from "../../spec/graph/types.ts"

/**
 * Which checks each tag makes possible, measured rather than estimated.
 *
 * `oat conformance` runs the reference backend twice — once with its tags, once with them
 * stripped — and asserts this map matches the difference, so it cannot drift into marketing.
 *
 * The distinction below is the honest part. Some tags *unlock* checks that are otherwise
 * impossible: nothing in a document reveals that a 202 is a receipt, or that a column is a
 * tombstone. Others do not change how much runs at all — they change whether what runs is
 * trustworthy. Without `x-query`, oat assumes every scalar property is filterable and probes
 * fields the backend may never have indexed; without `x-tenant`, a matching path parameter still
 * infers a tenant and a cross-tenant read is an ambiguity; with no tenant at all the check does
 * not apply.
 */
export const TAG_UNLOCKS: Record<string, readonly string[]> = {
	"x-async": ["async.reaches-terminal-state", "async.receipt-identifies-the-job"],
	"x-destructive": ["auth.destructive-spares-the-caller"],
	"x-effects": ["effects.declared-effect-occurs"],
	"x-immutable": ["patch.immutable-field-rejected"],
	"x-invalidate": ["invalidation.declared-route-changes"],
	/* Declaring filterable fields is itself a claim, and a claim is testable: oat probes each
	 * one and reports the document — not the backend — when a declared filter is refused. */
	"x-query": [
		"spec.declared-filterable-is-filterable",
		"spec.declared-sortable-is-sortable",
		"spec.declared-selectable-is-selectable",
		"spec.declared-filterable-ops-accepted",
		"spec.declared-sortable-nulls-accepted",
		"filter.in-is-union-of-eq",
		"filter.nin-complements-in",
		"filter.ilike-is-case-insensitive",
		"filter.is-null-selects-nulls",
		"filter.alias-matches-canonical",
		"filter.illegal-op-rejected",
		/* A malformed term is probed only on a grammar x-query declares. (An unknown sort direction
		 * needs a declared sort grammar, which the reference declares only for its template dialect.) */
		"filter.malformed-term-rejected",
		"filter.empty-in",
		"filter.in-over-limit-rejected",
		"filter.condition-cap-rejected",
		"sort.nulls-first-last",
		"sort.stable-tiebreak",
		"search.empty-q",
		"search.mode-accepted",
		"select.unknown-field-rejected",
		"select.nested-honoured",
		"sort.default-order-applied",
		/* An out-of-range page size is judged only where x-query declares it refused. */
		"pagination.limit-bounds-enforced",
		/* Membership needs an array the document marks filterable; untagged, no array is guessed. */
		"filter.contains-membership",
	],
	/* A declared rate is a claim the backend can break; an undeclared one is only oat's guess. */
	"x-rate-limit": ["spec.declared-rate-limit-is-honoured"],
	"x-soft-delete": ["softdelete.absent-from-default-list"],
	"x-wait": ["effects.side-effect-arrives"],
	"x-invite": ["auth.invite-grants-then-revokes"],
	/* identity: self is an x-entity value. Strip the tag and the caller is no longer the record. */
	"x-entity": ["auth.self-is-the-caller", "read.matches-caller-root"],
	"x-unique": ["create.unique-conflict-rejected", "update.unique-conflict-rejected"],
}

/** Tags that change the *confidence* of checks that already run, not the count. */
export const TAG_SHARPENS: Record<"x-query" | "x-tenant", string> = {
	"x-query":
		"the remaining query checks run against every scalar property, including fields the " +
		"backend never indexed — expect findings you will have to dismiss",
	"x-tenant":
		"an inferred tenant makes a cross-tenant item or filter read an ambiguity, not a " +
		"security finding; with no tenant tagged or inferred those checks do not apply",
}

/** What to declare to close a gap, by the tag the gap names. */
export const TAG_REMEDY: Record<string, string> = {
	"x-async": "declare the poll route so the operation's real outcome can be observed",
	"x-entity": "name the entity and action so this operation joins a lifecycle",
	"x-entity.identity": "name the property identifying an instance",
	"x-invalidate": "list the read routes this mutation must change",
	"x-query": "declare which fields support the filter / order / search / select roles",
	"x-tenant": "name the path parameter that scopes this operation to a tenant",
	"x-invite": "name the invite, accept and revoke operations for delegated access",
	"x-wait": "name the GET to poll after this write until a JSON path is occupied",
	"x-effects": "declare create/append/delete with count or min, not both",
	"x-rate-limit": "declare the rate each category is held to, so a stricter real limit is reported",
	"x-unique": "declare the column sets that must stay unique so a 409 duplicate can be scored",
}

/** The tags the document declares somewhere, as far as `TAG_UNLOCKS` and `TAG_SHARPENS` ask. */
export function declaredTags(model: SpecModel): Set<string> {
	const declared = new Set(
		model.operations.flatMap((op) => [
			...(op.async === null ? [] : ["x-async"]),
			...(op.effects.length > 0 ? ["x-effects"] : []),
			...(op.immutable.length > 0 ? ["x-immutable"] : []),
			...(op.invalidates.length > 0 ? ["x-invalidate"] : []),
			...(op.softDelete === null ? [] : ["x-soft-delete"]),
			...(op.wait === null ? [] : ["x-wait"]),
			...(op.tenantSource === "tag" ? ["x-tenant"] : []),
			...(op.query?.source === "tag" ? ["x-query"] : []),
			...(op.unique !== null ? ["x-unique"] : []),
		]),
	)
	for (const entity of model.entities.values()) {
		if (entity.invite !== null) declared.add("x-invite")
	}
	if (model.operations.some((op) => op.entitySource === "tag" && op.identity === "self")) {
		declared.add("x-entity")
	}
	return declared
}

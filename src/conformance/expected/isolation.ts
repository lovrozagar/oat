import type { DefectName } from "../../reference/defects.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects whose primary check is in the isolation family, and the check each must trip. */
export const ISOLATION_EXPECTED = {
	CROSS_TENANT_READ: "tenant.item-not-readable-cross-tenant",
	EXISTENCE_LEAK_VIA_STATUS: "tenant.denial-does-not-reveal-existence",
	TENANT_LEAK_VIA_FILTER: [
		"tenant.filter-does-not-bypass-scope",
		/* Any filtered query reaches across tenants, so a filter combined with a search returns
		 * foreign records the search alone does not: the same leak, seen from the composition. */
		"query.search-and-filter-compose",
	],
	CALLER_UPDATE_DROPPED: "auth.self-is-the-caller",
	DISPOSABLE_KILLS_CALLER: "auth.destructive-spares-the-caller",
	ROOT_READ_OPEN: "read.matches-caller-root",
	ROLE_MONOTONICITY_BROKEN: "auth.rank-is-monotonic",
	INVITE_NEVER_GRANTS: "auth.invite-grants-then-revokes",
	REVOKE_IGNORED: "auth.invite-grants-then-revokes",
	CROSS_TENANT_WRITE: "tenant.item-not-writable-cross-tenant",
	ROLE_WRITE_INVERTED: "auth.rank-is-monotonic-on-writes",
	FOREIGN_PARENT_ACCEPTED: "tenant.parent-not-reachable-from-another-root",
} satisfies Partial<Record<DefectName, FindingId | FindingId[]>>

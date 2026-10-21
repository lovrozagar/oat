import type { DefectName } from "../../reference/defects/table.ts"
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
	DISPOSABLE_KILLS_CALLER: [
		"auth.destructive-spares-the-caller",
		/* The caller's sessions are dead and every fresh sign-in is refused too, so the control read
		 * blocks it: the defect's own consequence, named, not a second defect. */
		"auth.blocked",
	],
	ROOT_READ_OPEN: [
		"read.matches-caller-root",
		/* A root read open to every caller is open to a caller with no credential, a bad one, or
		 * another scheme's: the security probes on that route see the same hole. */
		"auth.missing-credential-refused",
		"auth.invalid-credential-refused",
		"auth.wrong-scheme-refused",
	],
	ROLE_MONOTONICITY_BROKEN: "auth.rank-is-monotonic",
	INVITE_NEVER_GRANTS: "auth.invite-grants-then-revokes",
	REVOKE_IGNORED: "auth.invite-grants-then-revokes",
	CROSS_TENANT_WRITE: "tenant.item-not-writable-cross-tenant",
	ROLE_WRITE_INVERTED: [
		"auth.rank-is-monotonic-on-writes",
		/* The lowest rank writing where a higher one cannot is the read-only viewer's write accepted. */
		"auth.role-enforced",
	],
	FOREIGN_PARENT_ACCEPTED: "tenant.parent-not-reachable-from-another-root",
} satisfies Partial<Record<DefectName, FindingId | FindingId[]>>

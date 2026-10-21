import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects whose primary check is in the security family, and the check each must trip. */
export const SECURITY_EXPECTED = {
	AUTH_IGNORED_ON_ROUTE: [
		"auth.missing-credential-refused",
		/* A route that checks no credential takes any credential too: garbage, a bad signature and
		 * another scheme's value are each accepted there, the same hole seen from each probe. */
		"auth.invalid-credential-refused",
		"auth.wrong-scheme-refused",
	],
	TOKEN_NOT_VERIFIED: "auth.invalid-credential-refused",
	ANY_SCHEME_ACCEPTED: "auth.wrong-scheme-refused",
	SCOPE_NOT_CHECKED: "auth.scope-enforced",
	APIKEY_ALTERNATIVE_BROKEN: "auth.alternative-accepted",
	PUBLIC_ROUTE_GUARDED: "auth.anonymous-operation-open",
	REVOKED_TOKEN_ACCEPTED: [
		"auth.revoked-credential-refused",
		/* A logout that revokes nothing leaves the disposable user's ended session working too. */
		"auth.destructive-spares-the-caller",
	],
	REFRESH_REUSE_ACCEPTED: "auth.refresh-reuse-refused",
	ROLE_NOT_CHECKED: "auth.role-enforced",
	CROSS_TENANT_KEY_ACCEPTED: "auth.cross-tenant-key-refused",
	PRIVILEGED_FIELD_WRITABLE: "auth.privileged-field-ignored",
	LOGIN_NOT_THROTTLED: "auth.login-throttled",
} satisfies Partial<Record<DefectName, FindingId | FindingId[]>>

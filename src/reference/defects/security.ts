/** Credentials, schemes, scopes, sessions, roles and logins: what a secured operation promises and breaks. */
export const SECURITY_DEFECTS = {
	/** The notices listing, secured by the document's root security, answers a request with no credential. */
	AUTH_IGNORED_ON_ROUTE: "one secured route answers a request that carries no credential",
	/** The JWT's signature goes unchecked: a token whose signature was altered still authenticates. */
	TOKEN_NOT_VERIFIED: "a JWT with a bad signature is accepted",
	/** A route the document secures with jwt alone takes an API key as well. */
	ANY_SCHEME_ACCEPTED: "a jwt-only route accepts an API key",
	/** An API key authenticates an operation whose scope it was never granted. */
	SCOPE_NOT_CHECKED: "an API key without the operation's scope is accepted",
	/** A record route the document secures with jwt OR a scoped API key refuses every API key. */
	APIKEY_ALTERNATIVE_BROKEN: "a route documented as jwt or apiKey refuses a valid API key",
	/** The login the document declares `security: []` demands a credential before it signs anyone in. */
	PUBLIC_ROUTE_GUARDED: "a route the document declares public demands a credential",
	/** A logged-out or revoked token, and a revoked API key, keep authenticating. */
	REVOKED_TOKEN_ACCEPTED: "a revoked token or API key still works",
	/** A refresh token already rotated still refreshes, and its family is never revoked. */
	REFRESH_REUSE_ACCEPTED: "a rotated refresh token still refreshes",
	/** Roles are not enforced on writes: a viewer may create, update and delete. */
	ROLE_NOT_CHECKED: "a viewer can write",
	/** An API key is honored under another tenant's project, as if it belonged there. */
	CROSS_TENANT_KEY_ACCEPTED: "an API key works in another tenant",
	/** A table's `verified`, marked `x-privileged`, is set by a member's or a viewer's write. */
	PRIVILEGED_FIELD_WRITABLE: "a non-admin's write sets a field only admin may set",
	/** The register's `staff`, marked `x-privileged`, is granted to whoever signs up asking for it. */
	PRIVILEGED_FIELD_ON_SIGNUP: "a sign-up grants the x-privileged staff flag its body sets",
	/** Behind key-lifecycle, a key's revoke finds it by id across tenants: another tenant's revoke succeeds. */
	KEY_DELETE_CROSS_TENANT: "another tenant can revoke an API key",
	/** With `throttleLogins` on, failed logins never answer 429. */
	LOGIN_NOT_THROTTLED: "login throttling is on but repeated failed logins never answer 429",
} as const

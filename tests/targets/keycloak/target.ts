import { randomBytes } from "node:crypto"
import { answers, type Target } from "../target.ts"

/*
 * Keycloak on a fresh install has only the bootstrap admin in the master realm. Each tenant is a
 * realm of its own (oat-a, oat-b). The principals are confidential master-realm clients whose
 * service accounts hold the roles of that realm's management client (`oat-a-realm`), the way a
 * Keycloak operator delegates one realm: alpha and beta administer their own realm, the viewer
 * only reads oat-a. Their tokens come from the master token endpoint by client credentials. Each
 * realm is seeded with a few users and groups, so its lists have rows to filter.
 */

const REALMS = ["oat-a", "oat-b"] as const
const VIEW_ROLES = ["view-realm", "view-users", "view-clients", "query-users", "query-groups", "query-clients"]

/* What each realm holds before the run, so its lists have rows on both sides of each filter. */
const USERS = [
	{ enabled: true, emailVerified: true, firstName: "Ada", lastName: "Lovelace" },
	{ enabled: true, emailVerified: false, firstName: "Alan", lastName: "Turing" },
	{ enabled: false, emailVerified: true, firstName: "Grace", lastName: "Hopper" },
	{ enabled: false, emailVerified: false, firstName: "Edsger", lastName: "Dijkstra" },
]
const GROUPS = ["engineering", "operations", "support"]

interface Principal {
	clientId: string
	realm: (typeof REALMS)[number]
	/** The roles of the realm's management client it holds; every one but impersonation when absent. */
	roles?: string[]
}

const PRINCIPALS: Record<string, Principal> = {
	ALPHA: { clientId: "oat-alpha", realm: "oat-a" },
	BETA: { clientId: "oat-beta", realm: "oat-b" },
	VIEWER: { clientId: "oat-viewer", realm: "oat-a", roles: VIEW_ROLES },
}

/** The admin API as the bootstrap admin: `call(method, url, body?)` answers the parsed body, if any. */
function adminClient(token: string) {
	return async (method: string, url: string, body?: unknown): Promise<unknown> => {
		const headers: Record<string, string> = { authorization: `Bearer ${token}` }
		if (body !== undefined) headers["content-type"] = "application/json"
		const init: RequestInit = { headers, method }
		if (body !== undefined) init.body = JSON.stringify(body)
		const response = await fetch(url, init)
		const text = await response.text()
		if (!response.ok) throw new Error(`${method} ${url} answered ${response.status}: ${text}`)
		return text === "" ? undefined : JSON.parse(text)
	}
}

const target: Target = {
	baseUrl: "http://127.0.0.1:18080",
	readyWithinMs: 180_000,
	async prepare(baseUrl) {
		await answers(`${baseUrl}/realms/master`, 180_000, (status) => status === 200)
		const grant = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
			body: new URLSearchParams({
				client_id: "admin-cli",
				grant_type: "password",
				password: "admin",
				username: "admin",
			}),
			method: "POST",
		})
		if (!grant.ok) throw new Error(`the bootstrap admin's sign-in answered ${grant.status}: ${await grant.text()}`)
		const { access_token: admin } = (await grant.json()) as { access_token: string }
		const call = adminClient(admin)
		const master = `${baseUrl}/admin/realms/master`

		for (const realm of REALMS) {
			await call("POST", `${baseUrl}/admin/realms`, { enabled: true, realm })
			for (const [index, user] of USERS.entries()) {
				const username = `${realm.replace("-", "")}user${index}`
				await call("POST", `${baseUrl}/admin/realms/${realm}/users`, {
					...user,
					email: `${username}@example.test`,
					username,
				})
			}
			for (const name of GROUPS) await call("POST", `${baseUrl}/admin/realms/${realm}/groups`, { name })
		}

		const env: Record<string, string> = { KEYCLOAK_URL: baseUrl }
		for (const [id, principal] of Object.entries(PRINCIPALS)) {
			const secret = randomBytes(24).toString("hex")
			await call("POST", `${master}/clients`, {
				clientId: principal.clientId,
				directAccessGrantsEnabled: false,
				publicClient: false,
				secret,
				serviceAccountsEnabled: true,
				standardFlowEnabled: false,
			})
			const [client] = (await call("GET", `${master}/clients?clientId=${principal.clientId}`)) as Array<{
				id: string
			}>
			const account = (await call("GET", `${master}/clients/${client!.id}/service-account-user`)) as {
				id: string
			}
			const [management] = (await call("GET", `${master}/clients?clientId=${principal.realm}-realm`)) as Array<{
				id: string
			}>
			const roles = (await call("GET", `${master}/clients/${management!.id}/roles`)) as Array<{ name: string }>
			const granted = roles.filter((role) =>
				principal.roles === undefined ? role.name !== "impersonation" : principal.roles.includes(role.name),
			)
			await call("POST", `${master}/users/${account.id}/role-mappings/clients/${management!.id}`, granted)
			env[`KEYCLOAK_${id}_CLIENT_ID`] = principal.clientId
			env[`KEYCLOAK_${id}_SECRET`] = secret
		}
		return env
	},
}

export default target

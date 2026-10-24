import { answers, type Target } from "../target.ts"

/*
 * Immich on a fresh install: the first sign-up is the admin, who only sets the stack up. The admin
 * creates two ordinary users, the run's principals, each owning its own albums, tags and keys.
 * Their sessions and API keys come from the config's recipes.
 */

const ADMIN = { email: "admin@oat.test", name: "Admin", password: "oat-admin-password" }
const USERS = {
	ALPHA: { email: "alpha@oat.test", name: "Alpha", password: "oat-alpha-password" },
	BETA: { email: "beta@oat.test", name: "Beta", password: "oat-beta-password" },
}

async function post(url: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
	const headers: Record<string, string> = { "content-type": "application/json" }
	if (token !== undefined) headers["authorization"] = `Bearer ${token}`
	const response = await fetch(url, { body: JSON.stringify(body), headers, method: "POST" })
	const text = await response.text()
	if (!response.ok) throw new Error(`POST ${url} answered ${response.status}: ${text}`)
	return JSON.parse(text) as Record<string, unknown>
}

const target: Target = {
	baseUrl: "http://127.0.0.1:12283/api",
	readyWithinMs: 180_000,
	async prepare(baseUrl) {
		await answers(`${baseUrl}/server/ping`, 180_000, (status) => status === 200)
		await post(`${baseUrl}/auth/admin-sign-up`, ADMIN)
		const { accessToken } = await post(`${baseUrl}/auth/login`, { email: ADMIN.email, password: ADMIN.password })
		const env: Record<string, string> = { IMMICH_URL: baseUrl }
		for (const [id, user] of Object.entries(USERS)) {
			await post(`${baseUrl}/admin/users`, { ...user, shouldChangePassword: false }, String(accessToken))
			env[`IMMICH_${id}_EMAIL`] = user.email
			env[`IMMICH_${id}_PASSWORD`] = user.password
		}
		return env
	},
}

export default target

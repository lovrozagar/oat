import { answers, type Target } from "../target.ts"

/* Two ordinary accounts, one per tenant: alpha owns the books, beta reaches for them. */
const USERS = { ALPHA: "oat-alpha", BETA: "oat-beta" } as const

/* The admin VAmPI seeds with /createdb. */
const ADMIN = { password: "pass1", username: "admin" } as const

async function call(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, { ...init, headers: { "content-type": "application/json" } })
	const body = (await response.json()) as { status?: string; message?: string }
	if (!response.ok || body.status === "fail")
		throw new Error(`${url} answered ${response.status}: ${JSON.stringify(body)}`)
	return body
}

const target: Target = {
	baseUrl: "http://127.0.0.1:15002",
	/* VAmPI's own document, as published: its login example carries a sample JWT, so it is not committed. */
	vendored: [
		{
			path: "openapi3.yml",
			sha256: "35200f354f9c9968182fc19458295ed45bb4c368150348c46d5146a7e40a61c9",
			url: "https://raw.githubusercontent.com/erev0s/VAmPI/c41096526d4094b2301bef5e5dd8e5ed4786af4e/openapi_specs/openapi3.yml",
		},
	],
	async prepare(baseUrl) {
		await answers(`${baseUrl}/`, 60_000)
		/* VAmPI starts with no tables; /createdb makes them and seeds its three users. */
		await call(`${baseUrl}/createdb`)
		/* VAmPI seeds an admin (README: admin / pass1), the one account that may delete a user: the run's
		 * teardown hook removes the account its sign-up probe made as it. Signed in once here, so a seed
		 * that changed fails the target before the run. */
		await call(`${baseUrl}/users/v1/login`, {
			body: JSON.stringify({ password: ADMIN.password, username: ADMIN.username }),
			method: "POST",
		})
		const env: Record<string, string> = {
			VAMPI_ADMIN_PASSWORD: ADMIN.password,
			VAMPI_ADMIN_USER: ADMIN.username,
			VAMPI_URL: baseUrl,
		}
		for (const [key, username] of Object.entries(USERS)) {
			const password = `${username}-password`
			await call(`${baseUrl}/users/v1/register`, {
				body: JSON.stringify({ email: `${username}@example.test`, password, username }),
				method: "POST",
			})
			env[`VAMPI_${key}_USER`] = username
			env[`VAMPI_${key}_PASSWORD`] = password
		}
		return env
	},
	readyWithinMs: 60_000,
}

export default target

import { answers, type Target } from "../target.ts"

/*
 * crAPI signs a user up, then emails them a vehicle VIN and pincode they must claim. The run needs
 * two accounts in two tenants, each with a placed order — but the order lifecycle oat drives needs
 * no vehicle, so prepare only creates and logs the accounts in. Each account funds a cohort of
 * orders from its starting $100 of credit.
 */
const ACCOUNTS = {
	ALPHA: { email: "oat-alpha@example.com", name: "Oat Alpha", number: "4169990001" },
	BETA: { email: "oat-beta@example.com", name: "Oat Beta", number: "4169990002" },
} as const
const PASSWORD = "Oat!pass123"

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(url, {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		method: "POST",
	})
	return { body: (await response.json()) as Record<string, unknown>, status: response.status }
}

const target: Target = {
	baseUrl: "http://127.0.0.1:18888",
	/* crAPI's published test signing key, which the identity service mounts (README.md). */
	vendored: [
		{
			path: "keys/jwks.json",
			sha256: "45729121905a42591c12a056d0082298ab9bc4dc995ee61ce8886e47650fa4b4",
			url: "https://raw.githubusercontent.com/OWASP/crAPI/1b338594a6876062d3f97ad4a2929c39c0f4f3f3/deploy/docker/keys/jwks.json",
		},
	],
	async prepare(baseUrl) {
		await answers(`${baseUrl}/`, 300_000)
		const env: Record<string, string> = { CRAPI_URL: baseUrl }
		for (const [key, account] of Object.entries(ACCOUNTS)) {
			/* A repeat run meets accounts already signed up; that answer is fine, the login is the proof. */
			const signup = await post(`${baseUrl}/identity/api/auth/signup`, { ...account, password: PASSWORD })
			if (signup.status >= 500) throw new Error(`signup ${account.email} failed: ${signup.status}`)
			const login = await post(`${baseUrl}/identity/api/auth/login`, { email: account.email, password: PASSWORD })
			if (typeof login.body["token"] !== "string") {
				throw new Error(`login ${account.email} failed: ${login.status} ${JSON.stringify(login.body)}`)
			}
			env[`CRAPI_${key}_EMAIL`] = account.email
			env[`CRAPI_${key}_PASSWORD`] = PASSWORD
		}
		return env
	},
	readyWithinMs: 300_000,
}

export default target

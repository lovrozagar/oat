import { defineConfig, env } from "../../../src/index.ts"

/*
 * VAmPI has no delete-self, and only its admin may delete a user: the account oat's sign-up probe
 * makes is removed by username, as the admin VAmPI seeds (target.ts), found by its email or name.
 */
async function removeUser(address: string): Promise<void> {
	const base = process.env["VAMPI_URL"] as string
	const json = { "content-type": "application/json" }
	const credentials = { password: process.env["VAMPI_ADMIN_PASSWORD"], username: process.env["VAMPI_ADMIN_USER"] }
	const login = await fetch(`${base}/users/v1/login`, {
		body: JSON.stringify(credentials),
		headers: json,
		method: "POST",
	})
	const { auth_token: token } = (await login.json()) as { auth_token: string }
	const listed = (await (await fetch(`${base}/users/v1/_debug`)).json()) as {
		users: Array<{ username: string; email: string }>
	}
	/* Exactly one user by that exact email or username, or nothing is deleted: a misfire stays a leftover. */
	const matches = listed.users.filter((row) => row.username === address || row.email === address)
	if (matches.length !== 1) throw new Error(`_debug lists ${matches.length} users named ${address}; deleting none`)
	const [user] = matches as [{ username: string; email: string }]
	const removed = await fetch(`${base}/users/v1/${encodeURIComponent(user.username)}`, {
		headers: { authorization: `Bearer ${token}` },
		method: "DELETE",
	})
	if (!removed.ok) throw new Error(`DELETE /users/v1/${user.username} as admin answered ${removed.status}`)
}

export default defineConfig({
	spec: "./openapi3.yml",
	baseUrl: env("VAMPI_URL"),
	seed: 42,
	hooks: { teardownPrincipal: removeUser },
	security: {
		bearerAuth: {
			login: {
				steps: [
					{
						operationId: "api_views.users.login_user",
						body: { username: "{principal.username}", password: "{principal.password}" },
					},
				],
				from: "$.auth_token",
			},
		},
	},
	principals: {
		alpha: { tenant: "alpha", username: env("VAMPI_ALPHA_USER"), password: env("VAMPI_ALPHA_PASSWORD") },
		beta: { tenant: "beta", username: env("VAMPI_BETA_USER"), password: env("VAMPI_BETA_PASSWORD") },
	},
	/* /createdb drops and reseeds every table, the principals included. */
	allow: [
		"api_views.main.basic",
		"api_views.users.get_all_users",
		"api_views.users.debug",
		"api_views.users.register_user",
		"api_views.users.login_user",
		"api_views.users.me",
		"api_views.users.get_by_username",
		"api_views.users.delete_user",
		"api_views.users.update_email",
		"api_views.users.update_password",
		"api_views.books.get_all_books",
		"api_views.books.add_new_book",
		"api_views.books.get_by_title",
	],
	overlay: {
		operations: {
			"api_views.books.add_new_book": { "x-entity": { name: "book", action: "create", identity: "book_title" } },
			"api_views.books.get_all_books": {
				"x-entity": { name: "book", action: "list", identity: "book_title", recordPath: "$.Books" },
			},
			/* Mass assignment: register takes `admin`, which only an admin may grant. */
			"api_views.users.register_user": {
				requestBody: {
					content: {
						"application/json": { schema: { properties: { admin: { type: "boolean", "x-privileged": true } } } },
					},
				},
				"x-entity": { name: "user", action: "action" },
			},
			/* Every user with its `admin` flag: how a sign-up's privilege is read back. */
			"api_views.users.debug": { "x-entity": { name: "user", action: "list", identity: "username" } },
			/* A book belongs to the user who added it; only its owner may read its secret (README). */
			"api_views.books.get_by_title": {
				"x-entity": { name: "book", action: "read", identity: "book_title" },
				"x-tenant": "book_title",
			},
		},
	},
})

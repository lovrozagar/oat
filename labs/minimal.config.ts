/**
 * The smallest useful config: a long-lived API key, no login flow.
 *
 * A static recipe sends a fixed value where the document's bearer scheme says, so nothing needs
 * acquiring. `env()` stops the load naming the variable when it is unset, rather than sending an
 * empty token. The second principal is optional — but it is what makes the tenant-isolation checks
 * possible; without one they are skipped rather than silently passed.
 *
 *   oat run --config labs/minimal.config.ts
 *
 * Written as `from "../dist/index.js"` only because this file lives inside the repository —
 * in your own project it is `from "@lovrozagar/oat"`.
 */

import { defineConfig, env } from "../dist/index.js"

export default defineConfig({
	baseUrl: "https://api.example.com",
	principals: {
		alpha: {
			/* Path parameters oat cannot create for itself. */
			scope: { project_id: env("PROJECT_A") },
			tenant: env("PROJECT_A"),
			token: env("API_TOKEN"),
		},
		beta: { scope: { project_id: env("PROJECT_B") }, tenant: env("PROJECT_B"), token: env("API_TOKEN_B") },
	},
	/* The document's bearer scheme; each principal's own token fills it. */
	security: { bearer: { static: "{principal.token}" } },
	spec: "https://api.example.com/openapi.json",
})

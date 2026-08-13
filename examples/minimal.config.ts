/**
 * The smallest useful config: a long-lived API key, no login flow.
 *
 * A principal without an `auth` flow authenticates by static header, so nothing needs acquiring.
 * The second principal is optional — but it is what makes the tenant-isolation checks possible;
 * without one they are skipped rather than silently passed.
 *
 *   oat run --config examples/minimal.config.ts
 *
 * Written as `from "../dist/index.js"` only because this file lives inside the repository —
 * in your own project it is `from "oat"`.
 */

import { defineConfig } from "../dist/index.js"

export default defineConfig({
	baseUrl: "https://api.example.com",
	principals: [
		{
			headers: { authorization: `Bearer ${process.env.API_TOKEN ?? ""}` },
			id: "alpha",
			/* Path parameters oat cannot create for itself. */
			roots: { project_id: process.env.PROJECT_A ?? "" },
		},
		{
			headers: { authorization: `Bearer ${process.env.API_TOKEN_B ?? ""}` },
			id: "beta",
			roots: { project_id: process.env.PROJECT_B ?? "" },
		},
	],
	spec: "https://api.example.com/openapi.json",
})

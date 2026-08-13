/**
 * Points at the demo API that ships with oat, so this runs end to end with no setup.
 *
 *   oat serve                                    # terminal 1 — prints a url
 *   oat run --config examples/local.config.ts --base-url <that url>
 *
 * Real configs import from "oat"; this one uses a relative path because it lives inside the
 * repository.
 */

import { defineConfig } from "../dist/index.js"

/* Overridden by --base-url, which is what `oat serve` prints. */
const API = process.env.OAT_BASE_URL ?? "http://127.0.0.1:8787"

export default defineConfig({
	baseUrl: API,
	principals: [
		{
			auth: {
				credentialFrom: "$.access_token",
				steps: [{ body: { key: "key_alpha" }, operationId: "auth.token" }],
			},
			id: "alpha",
			roots: { project_id: "proj_alpha" },
		},
		/* A second principal in a different tenant — this is what makes the isolation checks
		 * possible. Without one they are skipped rather than silently passed. */
		{
			auth: {
				credentialFrom: "$.access_token",
				steps: [{ body: { key: "key_beta" }, operationId: "auth.token" }],
			},
			id: "beta",
			roots: { project_id: "proj_beta" },
		},
	],
	seed: 42,
	/* Relative to baseUrl — oat also accepts an absolute URL or a filesystem path. */
	spec: "/v1/openapi/spec",
})

/*
 * Square's Connect API in a sandbox account: a manual target that needs the user's secrets (never
 * run by `test:targets`). Written with `oat init`, then filled in.
 *
 * The document's one scheme is OAuth 2 authorization code; a sandbox access token from the
 * developer dashboard stands in for what that flow would issue. The run is scoped to customers,
 * which a sandbox creates and deletes freely.
 *
 *   OAT_SQUARE_TOKEN=<sandbox access token> oat run --config tests/targets/hosted/square/oat.config.ts
 */
import { defineConfig, env } from "../../../../src/index.ts"

export default defineConfig({
	spec: "https://raw.githubusercontent.com/square/connect-api-specification/0689c901bdfe1ff73f47aa28b17ccd6e0c40bf2d/api.json",
	baseUrl: "https://connect.squareupsandbox.com",
	maxRps: 2,
	/* The version this document describes, as its own x-additional-headers names it. */
	globalHeaders: { "Square-Version": "2026-09-16" },
	security: {
		/* Scopes the sandbox token carries; operations needing others are untested. */
		oauth2: { holds: ["CUSTOMERS_READ", "CUSTOMERS_WRITE"], static: env("OAT_SQUARE_TOKEN") },
	},
	principals: {
		alpha: {},
	},
	ops: ["ListCustomers", "CreateCustomer", "RetrieveCustomer", "UpdateCustomer", "DeleteCustomer", "SearchCustomers"],
})

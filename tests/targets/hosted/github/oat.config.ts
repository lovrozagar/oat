/*
 * GitHub's REST API against a throwaway repository: a manual target that needs the user's secrets
 * (never run by `test:targets`). Written with `oat init`, then filled in.
 *
 * GitHub's description declares no security scheme, so the overlay declares the bearer token every
 * call sends. The run is scoped to labels and milestones, which a repository creates and deletes
 * freely; use a repository that holds nothing else.
 *
 *   OAT_GITHUB_TOKEN=<fine-grained token: Issues read+write on that repository> \
 *   OAT_GITHUB_OWNER=<a throwaway org> OAT_GITHUB_REPO=<its throwaway repository> \
 *     oat run --config tests/targets/hosted/github/oat.config.ts
 */
import { defineConfig, env } from "../../../../src/index.ts"

export default defineConfig({
	spec: "https://raw.githubusercontent.com/github/rest-api-description/v2.1.0/descriptions/api.github.com/api.github.com.json",
	baseUrl: "https://api.github.com",
	/* GitHub's secondary rate limits punish bursts of writes. */
	maxRps: 1,
	globalHeaders: { "X-GitHub-Api-Version": "2022-11-28" },
	overlay: {
		security: [{ bearer: [] }],
		securitySchemes: { bearer: { scheme: "bearer", type: "http" } },
	},
	security: { bearer: { static: env("OAT_GITHUB_TOKEN") } },
	principals: {
		alpha: { scope: { owner: env("OAT_GITHUB_OWNER"), repo: env("OAT_GITHUB_REPO") } },
	},
	ops: [
		"issues/list-labels-for-repo",
		"issues/create-label",
		"issues/get-label",
		"issues/update-label",
		"issues/delete-label",
		"issues/list-milestones",
		"issues/create-milestone",
		"issues/get-milestone",
		"issues/update-milestone",
		"issues/delete-milestone",
	],
})

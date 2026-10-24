import { defineConfig, env } from "../../../src/index.ts"

/*
 * Immich v3.3.5 (spec vendored from open-api/immich-openapi-specs.json at that tag). Every operation
 * takes any of three schemes: bearer (the session token), cookie (the same token as
 * immich_access_token) and api_key (x-api-key). oat sends bearer first; the security checks grade
 * cookie and api_key as alternatives and probe each scheme with forged and revoked values.
 *
 * Scope: albums, tags, API keys and the caller's own user and preferences, the resources a user
 * owns that need no upload. `allow` keeps every other operation out of reach, so nothing outside
 * that scope is called, even as support.
 */

const login = {
	steps: [{ operationId: "login", body: { email: "{principal.email}", password: "{principal.password}" } }] as [
		{ operationId: string; body: Record<string, string> },
	],
	from: "$.accessToken",
	revoke: "logout",
}

const albums = ["createAlbum", "getAllAlbums", "getAlbumInfo", "updateAlbumInfo", "deleteAlbum", "getAlbumStatistics"]
const tags = ["createTag", "getAllTags", "getTagById", "updateTag", "deleteTag", "upsertTags"]
const apiKeys = [
	"createApiKey",
	"getApiKeys",
	"getApiKey",
	"getMyApiKey",
	"updateApiKey",
	"deleteApiKey",
	"rotateApiKey",
]
const me = ["getMyUser", "updateMyUser", "getMyPreferences", "updateMyPreferences"]

export default defineConfig({
	spec: "./openapi.json",
	baseUrl: env("IMMICH_URL"),
	security: {
		bearer: { login },
		cookie: { login },
		api_key: {
			mint: {
				with: "bearer",
				operationId: "createApiKey",
				body: { name: "oat", permissions: ["all"] },
				from: "$.secret",
				revoke: "deleteApiKey",
			},
		},
	},
	allow: ["login", "logout", ...albums, ...tags, ...apiKeys, ...me],
	ops: [...albums, ...tags, ...apiKeys, ...me, "logout"],
	overlay: {
		// The server stamps updatedAt on every write; oat treats only snake_case timestamps as such.
		operations: { updateAlbumInfo: { "x-generated": ["updatedAt"] } },
		schemas: {
			// Optional fields that take the id of an existing user, asset or parent tag; oat has none to send.
			CreateAlbumDto: { properties: { albumUsers: null, assetIds: null } },
			UpdateAlbumDto: { properties: { albumThumbnailAssetId: null } },
			TagCreateDto: { properties: { parentId: null } },
			// A write to these locks the principal out of its own login for the rest of the run.
			UserUpdateMeDto: { properties: { email: null, password: null } },
		},
	},
	principals: {
		alpha: { tenant: "alpha", email: env("IMMICH_ALPHA_EMAIL"), password: env("IMMICH_ALPHA_PASSWORD") },
		beta: { tenant: "beta", email: env("IMMICH_BETA_EMAIL"), password: env("IMMICH_BETA_PASSWORD") },
	},
})

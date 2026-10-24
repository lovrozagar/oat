import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { report } from "../../src/report/console/report.ts"
import { readInvite } from "../../src/spec/extensions/invite.ts"
import { describe, expect, it } from "vitest"

function inviteDoc(): OpenApiDocument {
	return {
		info: { title: "inv", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/orgs/{org_id}/members": {
				get: {
					operationId: "member.list",
					parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { properties: { members: { type: "array" } }, type: "object" },
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "member" },
				},
				post: {
					operationId: "org.inviteMember",
					parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
					responses: { "201": { description: "ok" } },
					"x-entity": { action: "create", identity: "id", name: "member" },
					"x-invite": {
						accept: "invite.accept",
						acceptFrom: "link",
						invite: "org.inviteMember",
						revoke: "invite.revoke",
						tokenFrom: "outOfBand",
					},
				},
			},
			"/v1/invites/accept": {
				post: {
					operationId: "invite.accept",
					responses: { "200": { description: "ok" } },
					"x-entity": { action: "action", identity: "id", name: "member" },
				},
			},
			"/v1/invites/revoke": {
				post: {
					operationId: "invite.revoke",
					responses: { "200": { description: "ok" } },
					"x-entity": { action: "action", identity: "id", name: "member" },
				},
			},
		},
	} as OpenApiDocument
}

describe("readInvite acceptFrom", () => {
	it("defaults to token and records link when tagged", () => {
		expect(
			readInvite({
				responses: {},
				"x-invite": { accept: "a", invite: "i", revoke: "r" },
			} as never)?.acceptFrom,
		).toBeUndefined()
		expect(
			readInvite({
				responses: {},
				"x-invite": { accept: "a", acceptFrom: "link", invite: "i", revoke: "r" },
			} as never)?.acceptFrom,
		).toBe("link")
		expect(
			readInvite({
				responses: {},
				"x-invite": { accept: "a", acceptFrom: "token", invite: "i", revoke: "r" },
			} as never)?.acceptFrom,
		).toBeUndefined()
		expect(
			readInvite({
				responses: {},
				"x-invite": { accept: "a", acceptFrom: "nope", invite: "i", revoke: "r" },
			} as never)?.acceptFrom,
		).toBeUndefined()
	})
})

describe("doctor / plan invite accept mode", () => {
	it("prints JSON-token and GET-link", () => {
		const modeled = buildModel(dereference(inviteDoc()).doc)
		const plan = report.plan(modeled, false)
		const doctor = report.doctor(modeled)
		expect(plan).toContain("GET-link")
		expect(plan).toContain("acceptFrom: link")
		expect(doctor.text).toContain("GET-link")
		const asJson = JSON.parse(report.doctor(modeled, { asJson: true }).text) as {
			invites: Array<{ acceptFrom: string }>
		}
		expect(asJson.invites.some((row) => row.acceptFrom === "link")).toBe(true)
		expect(report.plan(modeled, true)).toContain("acceptFrom")
	})
})

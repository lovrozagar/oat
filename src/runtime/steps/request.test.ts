import { describe, expect, it } from "vitest"
import type { AuthStep } from "../../config/types/steps.ts"
import { stepStage } from "./__fixtures__/flows.ts"
import { isOperationStep, isRequestStep, resolveRequest } from "./request.ts"

const answered = () => ({ status: 200 })

describe("resolveRequest: an operation step", () => {
	it("resolves the operation's method and path, filling the path, headers and query from the scope", async () => {
		const { ctx } = stepStage(answered)
		const step = { headers: { "x-org": "{org}" }, operationId: "orgs.get", query: { q: "{org}" } }
		const request = await resolveRequest(ctx, step, { org: "o1" }, 0)
		expect(request).toEqual({
			client: ctx.client,
			headers: { "x-org": "o1" },
			method: "GET",
			path: "/orgs/o1",
			query: { q: "o1" },
		})
	})

	it("encodes a body the way the operation documents it", async () => {
		const { ctx } = stepStage(answered)
		const form = await resolveRequest(
			ctx,
			{ body: { tags: ["a", "b"], user: "{who}" }, operationId: "auth.login" },
			{ who: "al" },
			0,
		)
		expect(form.contentType).toBe("application/x-www-form-urlencoded")
		expect(String(form.body)).toBe("tags=a%2Cb&user=al")
		const json = await resolveRequest(ctx, { body: { user: "{who}" }, operationId: "auth.token" }, { who: "al" }, 0)
		expect(json.body).toEqual({ user: "al" })
		expect(json).not.toHaveProperty("contentType")
	})

	it("sends bytes, non-objects and bodies of undocumented operations as they are", async () => {
		const { ctx } = stepStage(answered)
		const bytes = new Uint8Array([1])
		const typed = await resolveRequest(ctx, { body: bytes, mediaType: "text/csv", operationId: "auth.token" }, {}, 0)
		expect(typed).toMatchObject({ body: bytes, contentType: "text/csv" })
		const untyped = await resolveRequest(ctx, { body: bytes, operationId: "auth.token" }, {}, 0)
		expect(untyped.body).toBe(bytes)
		expect(untyped).not.toHaveProperty("contentType")
		expect((await resolveRequest(ctx, { body: ["{a}"], operationId: "auth.token" }, { a: "x" }, 0)).body).toEqual(["x"])
		expect((await resolveRequest(ctx, { body: null, operationId: "auth.token" }, {}, 0)).body).toBeNull()
		expect((await resolveRequest(ctx, { body: { a: 1 }, operationId: "ping" }, {}, 0)).body).toEqual({ a: 1 })
		const bare = { ...ctx, model: { ...ctx.model, rawOperations: new Map() } }
		expect((await resolveRequest(bare, { body: { a: 1 }, operationId: "auth.token" }, {}, 0)).body).toEqual({ a: 1 })
	})

	it("refuses an operation the document lacks", async () => {
		const { ctx } = stepStage(answered)
		await expect(resolveRequest(ctx, { operationId: "nope" }, {}, 2)).rejects.toThrow(
			'oat: auth step 3 names operation "nope", which is not in the document',
		)
	})
})

describe("resolveRequest: a raw step", () => {
	it("fills its path, body, headers and query, and follows redirects unless told not to", async () => {
		const { ctx } = stepStage(answered)
		const step = {
			body: { u: "{who}" },
			headers: { h: "{who}" },
			method: "POST",
			path: "/r/{who}",
			query: { q: "{who}" },
		}
		expect(await resolveRequest(ctx, step, { who: "al" }, 0)).toEqual({
			body: { u: "al" },
			client: ctx.client,
			headers: { h: "al" },
			method: "POST",
			path: "/r/al",
			query: { q: "al" },
			redirect: "follow",
		})
		const manual = await resolveRequest(ctx, { method: "GET", path: "/r", redirect: "manual" }, {}, 0)
		expect(manual).toEqual({ client: ctx.client, method: "GET", path: "/r", redirect: "manual" })
	})

	it("refuses a placeholder nothing fills rather than send it as written", async () => {
		const { ctx } = stepStage(answered)
		const scope = { "user-id": "u1" }
		const filled = await resolveRequest(ctx, { method: "GET", path: "/users/{user-id}" }, scope, 0)
		expect(filled.path).toBe("/users/u1")
		const sends = [
			{ method: "GET", path: "/realms/{realm-name}/users" },
			{ body: { id: "{realm-name}" }, method: "PUT", path: "/r" },
			{ headers: { h: "{realm-name}" }, method: "GET", path: "/r" },
			{ method: "GET", path: "/r", query: { q: "{realm-name}" } },
		]
		for (const step of sends) {
			await expect(resolveRequest(ctx, step, scope, 1)).rejects.toThrow(
				"oat: step 2's placeholder {realm-name} has no value: no bind, saveAs or earlier step fills it",
			)
		}
		await expect(resolveRequest(ctx, { operationId: "orgs.get" }, {}, 0)).rejects.toThrow(
			"oat: step 1's placeholder {org} has no value",
		)
	})

	it("refuses a step that is neither an operation nor a request", async () => {
		const { ctx } = stepStage(answered)
		const wait: AuthStep = { outOfBand: { address: "a", as: "t", kind: "otp" } }
		await expect(resolveRequest(ctx, wait, {}, 0)).rejects.toThrow(
			"oat: auth step 1 declares neither an operationId nor a method and path",
		)
	})
})

describe("resolveRequest: origins", () => {
	it("sends a step naming an origin through that origin's client and document", async () => {
		const { ctx } = stepStage(answered)
		const sso = ctx.originClients?.get("sso")
		const request = await resolveRequest(ctx, { operationId: "sso.start", origin: "sso" }, {}, 0)
		expect(request).toMatchObject({ client: sso?.client, method: "POST", path: "/start" })
		const primary = await resolveRequest(ctx, { method: "GET", origin: "", path: "/p" }, {}, 0)
		expect(primary.client).toBe(ctx.client)
	})

	it("refuses an origin the config does not declare, naming the ones it does", async () => {
		const { ctx } = stepStage(answered)
		await expect(resolveRequest(ctx, { method: "GET", origin: "app", path: "/" }, {}, 0)).rejects.toThrow(
			'oat: auth step 1 names origin "app", which is not in config.origins (known: sso)',
		)
		const { originClients: _, ...alone } = ctx
		await expect(resolveRequest(alone, { method: "GET", origin: "app", path: "/" }, {}, 0)).rejects.toThrow(
			/^oat: auth step 1 names origin "app", which is not in config\.origins$/,
		)
	})
})

describe("step kinds", () => {
	it("tells an operation step from a raw request step", () => {
		expect(isOperationStep({ operationId: "ping" })).toBe(true)
		expect(isOperationStep({ method: "GET", path: "/" })).toBe(false)
		expect(isRequestStep({ method: "GET", path: "/" })).toBe(true)
		expect(isRequestStep({ outOfBand: { address: "a", as: "t", kind: "otp" } })).toBe(false)
	})
})

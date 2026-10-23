import { describe, expect, it } from "vitest"
import { modelOf } from "../../spec/graph/__fixtures__/operations.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { body, OPEN } from "./__fixtures__/open.ts"
import { unmarkedSignUp } from "./unmarked.ts"

/* An account-making operation the document does not tag: an open POST named as a sign-up, or one taking a password. */

const signsUp = (model: SpecModel, operationId: string): boolean =>
	unmarkedSignUp(model.byOperationId.get(operationId) as never, model)

describe("unmarkedSignUp by name", () => {
	it("is an open POST whose operationId or last path segment ends with register, registration, signup or sign up", () => {
		const model = modelOf({
			"/v1/register": { post: { operationId: "auth.register", ...OPEN } },
			"/accounts/sign-up": { post: { operationId: "accounts.create", ...OPEN } },
			"/auth/admin-sign-up": { post: { operationId: "signUpAdmin", ...OPEN } },
			"/users": { post: { operationId: "users.signUp", ...OPEN } },
			"/registration": { post: { operationId: "makeOne", ...OPEN } },
		})
		for (const id of ["auth.register", "accounts.create", "signUpAdmin", "users.signUp", "makeOne"]) {
			expect([id, signsUp(model, id)]).toEqual([id, true])
		}
	})

	it("is not a device registered, a login, a listing of registrations, or a sign-up that needs a credential", () => {
		const model = modelOf(
			{
				"/v1/devices/register-device": { post: { operationId: "devices.registerDevice", ...OPEN } },
				"/v1/auth/login": { post: { operationId: "auth.login", ...OPEN } },
				"/v1/registrations-list": { post: { operationId: "registrations.list", ...OPEN } },
				"/v1/register": {
					get: { operationId: "register.read", responses: { "200": { description: "ok" } }, security: [] },
					post: { operationId: "auth.register", responses: { "201": { description: "made" } } },
				},
			},
			{ components: { securitySchemes: { jwt: { scheme: "bearer", type: "http" } } }, security: [{ jwt: [] }] },
		)
		for (const id of ["devices.registerDevice", "auth.login", "registrations.list", "register.read", "auth.register"]) {
			expect([id, signsUp(model, id)]).toEqual([id, false])
		}
	})
})

describe("unmarkedSignUp by body", () => {
	it("is an open collection create that takes a password or passphrase", () => {
		const model = modelOf({
			"/users": { post: { operationId: "users.create", ...OPEN, ...body({ email: {}, password: {} }) } },
			"/members": { post: { operationId: "members.create", ...OPEN, ...body({ passphrase: {} }) } },
			"/people": { post: { operationId: "people.add", ...OPEN, ...body({ secret: { format: "password" } }) } },
		})
		for (const id of ["users.create", "members.create", "people.add"])
			expect([id, signsUp(model, id)]).toEqual([id, true])
	})

	it("is not a password reset, forgotten, recovered or changed, though it takes a password", () => {
		const model = modelOf({
			"/password-reset": { post: { operationId: "passwordReset", ...OPEN, ...body({ password: {}, token: {} }) } },
			"/password/forgot": { post: { operationId: "forgot.create", ...OPEN, ...body({ password: {} }) } },
			"/accounts/recover": { post: { operationId: "recoverAccount", ...OPEN, ...body({ password: {} }) } },
			"/me/change-password": { post: { operationId: "changes.create", ...OPEN, ...body({ password: {} }) } },
		})
		for (const id of ["passwordReset", "forgot.create", "recoverAccount", "changes.create"]) {
			expect([id, signsUp(model, id)]).toEqual([id, false])
		}
	})

	it("is not a sign-in, an item write, or a create that takes no password", () => {
		const model = modelOf({
			"/auth/token": { post: { operationId: "token.create", ...OPEN, ...body({ password: {} }) } },
			"/users/{id}": {
				post: {
					operationId: "users.reset",
					parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
					...OPEN,
					...body({ password: {} }),
				},
			},
			"/notes": { post: { operationId: "notes.create", ...OPEN, ...body({ title: {} }) } },
			"/blobs": { post: { operationId: "blobs.create", ...OPEN } },
		})
		for (const id of ["token.create", "users.reset", "notes.create", "blobs.create"]) {
			expect([id, signsUp(model, id)]).toEqual([id, false])
		}
	})
})

import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../../spec/types.ts"
import { type Answer, modelOf, type Sent } from "../../__fixtures__/harness.ts"
import type { Actor } from "../../core/context.ts"
import type { OperationWriteContext } from "../../core/operation-context.ts"
import type { Plan } from "../../core/plan.ts"
import {
	type AccountScript,
	actorOf,
	operationContextFor,
	type SentResponder,
	sender,
} from "./__fixtures__/operation-context.ts"
import { isSignUp, type SignUpProbe, signUpAndJudge, signUpPlan } from "./privileged-signup.ts"

/* A sign-up anyone may send must not make an account holding a property only the highest rank may set. */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })

/** How the sign-up document is put together. */
interface Parts {
	/** The marked property, an `admin` boolean by default. */
	marked?: Record<string, unknown>
	/** The rest of the sign-up's body properties. */
	fields?: Record<string, unknown>
	/** The self read's answer schema; none without. */
	self?: Record<string, unknown>
	/** The self read's `x-entity.recordPath`. */
	selfRecordPath?: string
	/** The listing of users, and the path it sits at; none without. */
	listing?: { path: string; item: Record<string, unknown>; parameters?: unknown[] }
	/** The sign-up's answer schema. */
	answer?: Record<string, unknown>
	/** The sign-up's `x-entity.recordPath`. */
	answerRecordPath?: string
	/** Mark the sign-up `x-fresh-principal`; the default. */
	fresh?: boolean
	/** The sign-up's path. */
	path?: string
	/** The sign-up body's required properties. */
	required?: string[]
	/** Tag the sign-up with `x-entity`; the default. */
	entity?: boolean
}

const EMAIL = { format: "email", type: "string" }

/* `x-entity.recordPath`, when one is given. */
const recordAt = (recordPath: string | undefined) => (recordPath === undefined ? {} : { recordPath })

/* The sign-up: open to all, its body the fields and the marked property. */
function signUpOperation(parts: Parts) {
	const { fields = { email: EMAIL, password: { minLength: 8, type: "string" } } } = parts
	const marked = parts.marked ?? { admin: { type: "boolean", "x-privileged": true } }
	const entity = { action: "create", identity: "email", name: "user", ...recordAt(parts.answerRecordPath) }
	return {
		operationId: "auth.register",
		requestBody: {
			required: true,
			...json({ properties: { ...fields, ...marked }, required: parts.required ?? [], type: "object" }),
		},
		responses: { "201": { description: "made", ...json(parts.answer ?? { type: "object" }) } },
		security: [],
		...(parts.entity === false ? {} : { "x-entity": entity }),
		...(parts.fresh === false ? {} : { "x-fresh-principal": true }),
	}
}

/* The caller's own read and the listing of users, each when the parts ask for it. */
function readPaths(parts: Parts): Record<string, unknown> {
	const paths: Record<string, unknown> = {}
	if (parts.self !== undefined) {
		const entity = { action: "read", identity: "self", name: "me", ...recordAt(parts.selfRecordPath) }
		paths["/me"] = {
			get: {
				operationId: "me.read",
				responses: { "200": { description: "ok", ...json(parts.self) } },
				"x-entity": entity,
			},
		}
	}
	if (parts.listing !== undefined) {
		const { item, parameters, path } = parts.listing
		const rows = json({ properties: { users: { items: item, type: "array" } }, type: "object" })
		paths[path] = {
			get: {
				operationId: "users.list",
				...(parameters === undefined ? {} : { parameters }),
				responses: { "200": { description: "ok", ...rows } },
				"x-entity": { action: "list", identity: "email", name: "user" },
			},
		}
	}
	return paths
}

function signUpDoc(parts: Parts = {}): OpenApiDocument {
	return {
		components: { securitySchemes: { jwt: { scheme: "bearer", type: "http" } } },
		info: { title: "sign-up", version: "1" },
		openapi: "3.1.0",
		paths: { [parts.path ?? "/register"]: { post: signUpOperation(parts) }, ...readPaths(parts) },
		security: [{ jwt: [] }],
	} as unknown as OpenApiDocument
}

const ADMIN_ROW = { properties: { admin: { type: "boolean" }, email: { type: "string" } }, type: "object" }
const LISTING = { item: ADMIN_ROW, path: "/users" }

const owner = actorOf("alpha", { rank: 2, scope: { org_id: "org_a" }, tenant: "org_a" })
const member = actorOf("alpha_member", { rank: 1, scope: { org_id: "org_a" }, tenant: "org_a" })
const TEAM: [Actor, ...Actor[]] = [member, owner]

interface Staging {
	respond?: SentResponder
	accounts?: AccountScript
}

function staged(parts: Parts, staging: Staging = {}) {
	return operationContextFor(modelOf(signUpDoc(parts)), "auth.register", {
		principals: TEAM,
		...(staging.accounts === undefined ? {} : { accounts: staging.accounts }),
		...(staging.respond === undefined ? {} : { respond: staging.respond }),
	})
}

function planned(ctx: OperationWriteContext): SignUpProbe {
	const plan = signUpPlan(ctx)
	if (!plan.ok) throw new Error(`expected a plan, stood down: ${plan.needs}`)
	return plan.value
}

const needs = (plan: Plan<SignUpProbe>): string | undefined => (plan.ok ? undefined : plan.needs)

/* The sign-up answers 201 with `answer`; the listing shows each registered email with `admin` as `shown`. */
function backend({ shown, answer = {}, status = 201 }: { shown?: unknown; answer?: unknown; status?: number }) {
	let email: unknown
	return (sent: Sent) => {
		if (sent.method === "POST") {
			email = (sent.options.body as { email?: unknown }).email
			return { body: answer, status }
		}
		if (sent.path === "/me") return { body: { admin: shown, email }, status: 200 }
		return {
			body: {
				users: [
					{ admin: false, email: "someone@else.test" },
					{ admin: shown, email },
				],
			},
			status: 200,
		}
	}
}

const signedInAs: AccountScript = () => ({ principal: "account-1" })

/* The sign-up answers 201 and names nothing; the self read answers `me`, the listing `users`. */
const reading =
	(me: Answer, users: unknown[]): SentResponder =>
	(sent) =>
		sent.method === "POST" ? { body: {}, status: 201 } : sent.path === "/me" ? me : { body: { users }, status: 200 }

describe("isSignUp", () => {
	it("is the operation marked x-fresh-principal, or a sign-up the document leaves unmarked", () => {
		expect(isSignUp(staged({}).ctx)).toBe(true)
		expect(isSignUp(staged({ fresh: false }).ctx)).toBe(true)
		expect(isSignUp(staged({ fresh: false, path: "/users" }).ctx)).toBe(true)
		const listing = operationContextFor(modelOf(signUpDoc({ listing: LISTING })), "users.list")
		expect(isSignUp(listing.ctx)).toBe(false)
	})
})

describe("signUpPlan: the value that grants the privilege", () => {
	it("sets a boolean to true, a const to itself, and a one-member enum to its member", () => {
		const marked = {
			admin: { type: "boolean", "x-privileged": true },
			role: { enum: ["owner"], type: "string", "x-privileged": true },
			tier: { const: "staff", "x-privileged": true },
		}
		const probe = planned(
			staged({ listing: { item: { properties: { ...marked, email: EMAIL } }, path: "/users" }, marked }).ctx,
		)
		expect(probe.values).toEqual([
			["admin", true],
			["role", "owner"],
			["tier", "staff"],
		])
		expect(probe.body).toMatchObject({ admin: true, role: "owner", tier: "staff" })
		expect(typeof probe.body["email"]).toBe("string")
	})

	it("stands down, naming the field, for one whose privileged value it cannot tell", () => {
		const marked = { role: { enum: ["owner", "viewer"], type: "string", "x-privileged": true } }
		expect(needs(signUpPlan(staged({ listing: LISTING, marked }).ctx))).toBe(
			"role: no value oat can tell is privileged (no const, no one-member enum, not a boolean)",
		)
		/* A marker oat reads through two allOf levels, where the schema lookup reads one. */
		const nested = {
			meta: { allOf: [{ allOf: [{ properties: { owner: { type: "boolean", "x-privileged": true } } }] }] },
		}
		expect(needs(signUpPlan(staged({ listing: LISTING, marked: nested }).ctx))).toBe(
			"meta.owner: no value oat can tell is privileged (no const, no one-member enum, not a boolean)",
		)
	})
})

describe("signUpPlan: the body", () => {
	it("sets a nested marked property inside the object the body holds", () => {
		const marked = {
			meta: { properties: { admin: { type: "boolean", "x-privileged": true } }, required: [], type: "object" },
		}
		const self = {
			properties: { meta: { properties: { admin: { type: "boolean" } }, type: "object" } },
			type: "object",
		}
		const fields = { email: EMAIL, meta: marked.meta }
		const probe = planned(staged({ fields, marked: {}, self }).ctx)
		expect(probe.body["meta"]).toEqual({ admin: true })
	})

	it("stands down when the body holds no object for a nested property, or no valid body can be drawn", () => {
		const marked = { meta: { properties: { admin: { type: "boolean", "x-privileged": true } }, type: "string" } }
		expect(needs(signUpPlan(staged({ marked, self: { type: "object" } }).ctx))).toBe(
			"a sign-up body that holds the object meta.admin sits in",
		)
		const fields = { code: { maxLength: 2, minLength: 5, type: "string" } }
		expect(needs(signUpPlan(staged({ fields, listing: LISTING, required: ["code"] }).ctx))).toMatch(
			/^a valid sign-up body for auth\.register: /,
		)
	})
})

describe("signUpPlan: the reads that show the account", () => {
	it("tries the account's own read, then the listing, then the sign-up's answer, each when it declares the field", () => {
		const all = planned(staged({ answer: ADMIN_ROW, listing: LISTING, self: ADMIN_ROW }).ctx)
		expect(all.reads.map((read) => read.kind)).toEqual(["self", "listing", "answer"])
		const listing = all.reads[1]
		expect(listing).toMatchObject({ as: { id: "alpha" }, kind: "listing", path: "/users" })
		expect(listing?.kind === "listing" ? listing.identity : undefined).toEqual({ email: all.body["email"] })
		const wrapped = { properties: { data: ADMIN_ROW }, type: "object" }
		const enveloped = planned(
			staged({ answer: wrapped, answerRecordPath: "$.data", self: wrapped, selfRecordPath: "$.data" }).ctx,
		)
		expect(enveloped.reads.map((read) => read.kind)).toEqual(["self", "answer"])
	})

	it("fills the listing's path from the strongest principal's scope, and skips one it cannot fill", () => {
		const org = { in: "path", name: "org_id", required: true, schema: { type: "string" } }
		const scoped = planned(staged({ listing: { ...LISTING, parameters: [org], path: "/orgs/{org_id}/users" } }).ctx)
		expect(scoped.reads).toMatchObject([{ kind: "listing", path: "/orgs/org_a/users" }])
		const team = { in: "path", name: "team_id", required: true, schema: { type: "string" } }
		const unfilled = staged({ listing: { ...LISTING, parameters: [team], path: "/teams/{team_id}/users" } })
		expect(needs(signUpPlan(unfilled.ctx))).toMatch(/^a read that shows admin of the account auth\.register makes/)
	})

	it("reads no listing for a sign-up no entity owns", () => {
		const stage = staged({ entity: false, listing: LISTING, path: "/", self: ADMIN_ROW })
		expect(stage.ctx.operation.entity).toBeNull()
		expect(planned(stage.ctx).reads.map((read) => read.kind)).toEqual(["self"])
	})

	it("stands down before sending anything when no read declares the field or names the account", () => {
		const stage = staged({
			answer: { properties: { rows: { items: ADMIN_ROW, type: "array" } }, type: "object" },
			answerRecordPath: "$.rows[*]",
			listing: { item: { properties: { email: EMAIL }, type: "object" }, path: "/users" },
			self: { properties: { email: EMAIL }, type: "object" },
		})
		expect(needs(signUpPlan(stage.ctx))).toBe(
			"a read that shows admin of the account auth.register makes: the account's own read (x-entity identity " +
				"self), a listing of the entity it makes, or its own answer",
		)
		const unnamed = staged({ fields: { nickname_text: { type: "string" } }, listing: LISTING })
		expect(signUpPlan(unnamed.ctx).ok).toBe(false)
		expect(stage.sent).toEqual([])
	})
})

describe("signUpAndJudge: the sign-up", () => {
	it("is sent anonymously through the check's client, with the privileged value in its body", async () => {
		const stage = staged({ listing: LISTING }, { respond: backend({ shown: false }) })
		const probe = planned(stage.ctx)
		expect(await signUpAndJudge(stage.ctx, probe)).toEqual({ kind: "asserted" })
		expect(stage.sent.map((sent) => [sent.method, sent.path, sender(sent), sent.options.operationId])).toEqual([
			["POST", "/register", "anonymous", "auth.register"],
			["GET", "/users", "alpha", "users.list"],
		])
		expect(stage.sent[0]?.options.body).toEqual(probe.body)
	})

	it("passes when the sign-up is refused, and leaves a server error unresolved", async () => {
		const refused = staged({ listing: LISTING }, { respond: backend({ status: 403 }) })
		expect(await signUpAndJudge(refused.ctx, planned(refused.ctx))).toEqual({ kind: "asserted" })
		expect(refused.sent).toHaveLength(1)
		const crashed = staged({ listing: LISTING }, { respond: backend({ status: 500 }) })
		expect(await signUpAndJudge(crashed.ctx, planned(crashed.ctx))).toEqual({
			kind: "unresolved",
			reason: "a sign-up that set admin drew 500, a server error",
		})
	})
})

describe("signUpAndJudge: the verdict", () => {
	it("is a security finding naming the field and the operation when the account's own read shows it took", async () => {
		const stage = staged({ self: ADMIN_ROW }, { accounts: signedInAs, respond: backend({ shown: true }) })
		const outcome = await signUpAndJudge(stage.ctx, planned(stage.ctx))
		expect(outcome).toMatchObject({ kind: "finding" })
		const [finding] = stage.findings.findings
		expect(finding).toMatchObject({
			check: "auth.privileged-field-ignored",
			entity: "auth.register",
			summary: "auth.register grants admin, marked x-privileged, to whoever signs up",
			verdict: "SECURITY",
		})
		expect(finding?.detail).toBe(
			"An anonymous sign-up by auth.register set admin to true, marked x-privileged; auth.register answered " +
				"201 and the account's own me.read shows the account holding it. Anyone who signs up gets a privilege " +
				"only the highest rank may grant.",
		)
		expect(stage.calls.signIn).toEqual([{ read: "me.read", seq: expect.any(Number) }])
		expect(stage.sent.map((sent) => [sent.path, sender(sent)])).toEqual([
			["/register", "anonymous"],
			["/me", "account-1"],
		])
	})

	it("reads the listing as the strongest principal, and finds the account's row by its name", async () => {
		const took = staged({ listing: LISTING }, { respond: backend({ shown: true }) })
		await signUpAndJudge(took.ctx, planned(took.ctx))
		expect(took.findings.findings[0]?.detail).toContain("users.list as alpha shows the account holding it")
		const kept = staged({ listing: LISTING }, { respond: backend({ shown: false }) })
		expect(await signUpAndJudge(kept.ctx, planned(kept.ctx))).toEqual({ kind: "asserted" })
	})

	it("reads the sign-up's own answer, out of its record path", async () => {
		const wrapped = { properties: { data: ADMIN_ROW }, type: "object" }
		const parts = { answer: wrapped, answerRecordPath: "$.data" }
		const took = staged(parts, { respond: backend({ answer: { data: { admin: true } } }) })
		await signUpAndJudge(took.ctx, planned(took.ctx))
		expect(took.findings.findings[0]?.detail).toContain("auth.register's answer shows the account holding it")
		expect(took.sent).toHaveLength(1)
	})
})

describe("signUpAndJudge: a read that shows nothing", () => {
	it("goes on to the next read, and stands down naming why each showed nothing", async () => {
		const parts = { answer: ADMIN_ROW, listing: LISTING, self: ADMIN_ROW }
		const unsigned = staged(parts, { respond: backend({ answer: {}, shown: undefined }) })
		expect(await signUpAndJudge(unsigned.ctx, planned(unsigned.ctx))).toEqual({
			kind: "stood-down",
			reason:
				"no read showed admin of the account auth.register made: me.read: no account sign-in in this test; " +
				"users.list as alpha did not show admin; auth.register's answer did not show admin",
		})
		const empty = staged(parts, { accounts: signedInAs, respond: reading({ status: 401 }, []) })
		expect(await signUpAndJudge(empty.ctx, planned(empty.ctx))).toEqual({
			kind: "stood-down",
			reason:
				"no read showed admin of the account auth.register made: me.read answered 401; users.list as alpha " +
				"did not list the account; auth.register's answer did not show admin",
		})
	})

	it("shows nothing from an answer that holds no record", async () => {
		const stage = staged({ answer: ADMIN_ROW }, { respond: backend({ answer: [] }) })
		expect(await signUpAndJudge(stage.ctx, planned(stage.ctx))).toEqual({
			kind: "stood-down",
			reason: "no read showed admin of the account auth.register made: auth.register's answer did not show admin",
		})
	})

	it("takes the first read that shows the field, though a later one would say otherwise", async () => {
		const parts = { listing: LISTING, self: ADMIN_ROW }
		const respond = reading({ body: { admin: false }, status: 200 }, [{ admin: true, email: "x" }])
		const stage = staged(parts, { accounts: signedInAs, respond })
		expect(await signUpAndJudge(stage.ctx, planned(stage.ctx))).toEqual({ kind: "asserted" })
		expect(stage.sent.map((sent) => sent.path)).toEqual(["/register", "/me"])
	})
})

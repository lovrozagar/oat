import type { IncomingMessage, ServerResponse } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import type { Exchange } from "../../src/runtime/exchange.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import {
	dispatch,
	type Handler,
	inviteSpec,
	inviteSpecWith,
	listen,
	readJson,
	type Route,
	send,
} from "../support/invite-accept-fixtures.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

/** Serves `routes` (anything else is 404, a throw is 500) and closes the server after the test. */
async function serve(routes: readonly Route[]): Promise<{ url: string }> {
	const server = await listen((req, res) => {
		dispatch(routes, req, res).catch(() => {
			if (!res.headersSent) send(res, 500)
		})
	})
	closers.push(server.close)
	return server
}

const OWNER_LIST = { members: [{ email: "owner@x.test", id: "m1" }] }

/** The spec, the member list and the invite every world answers the same way. */
function baseRoutes(spec: OpenApiDocument, list: unknown, invited: unknown): Route[] {
	return [
		["GET", "/v1/openapi/spec", (_req, res) => send(res, 200, spec)],
		["GET", "/v1/orgs/org_1/members", (_req, res) => send(res, 200, list)],
		["POST", "/v1/orgs/org_1/members", (_req, res) => send(res, 201, invited)],
	]
}

const okRoute = (method: string, path: string, body?: unknown): Route => [
	method,
	path,
	(_req, res) => send(res, 200, body),
]

const principals = [
	{ headers: { authorization: "Bearer a" }, id: "alpha", roots: { org_id: "org_1" } },
	{
		headers: { authorization: "Bearer b" },
		id: "beta",
		inviteAs: "beta@x.test",
		roots: { org_id: "org_2" },
	},
]

type RunOptions = Parameters<typeof run>[0]

function runMember(url: string, extra: Partial<RunOptions> = {}): ReturnType<typeof run> {
	return run({ baseUrl: url, only: ["member"], principals, seed: 1, spec: `${url}/v1/openapi/spec`, ...extra })
}

const OOB = { attempts: 2, initialMs: 1, maxMs: 1 }

function sent(transcript: readonly Exchange[], method: string, path: string): Exchange | undefined {
	return transcript.find((e) => e.method === method && new URL(e.url).pathname === path)
}

/** A member read: the owner always sees m1, the grantee only while `granted()` holds. */
function memberRead(granted: () => boolean, grantee: string, denied: number): Route {
	return [
		"GET",
		"/v1/orgs/org_1/members/m1",
		(req, res) => {
			const auth = req.headers.authorization ?? ""
			if (auth === grantee && granted()) return send(res, 200, { email: "beta@x.test", id: "m1" })
			if (auth === "Bearer a") return send(res, 200, { email: "owner@x.test", id: "m1" })
			return send(res, denied)
		},
	]
}

/** A member read only the owner sees, with a terse body. */
const ownerOnlyRead: Route = [
	"GET",
	"/v1/orgs/org_1/members/m1",
	(req, res) => (req.headers.authorization === "Bearer a" ? send(res, 200, { email: "o", id: "m1" }) : send(res, 404)),
]

async function acceptJsonToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const type = req.headers["content-type"] ?? ""
	const body = await readJson(req)
	if (!type.includes("application/json")) return send(res, 415, { error: "unsupported_media_type" })
	if (body === null || typeof body !== "object" || (body as { token?: unknown }).token !== "tok-from-invite") {
		return send(res, 400, { error: "missing_token" })
	}
	return send(res, 200, { ok: true })
}

async function acceptEmptyBody(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	if (Buffer.concat(chunks).length > 0) return send(res, 400, { error: "unexpected_body" })
	return send(res, 200, { ok: true })
}

async function revokeJsonGrant(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const type = req.headers["content-type"] ?? ""
	const body = await readJson(req)
	if (!type.includes("application/json")) return send(res, 415)
	if ((body as { grant_id?: unknown })?.grant_id !== "g1") return send(res, 400)
	return send(res, 200, { ok: true })
}

/** Accepts only the expected token; `then` answers the 200 once it matches. */
function acceptToken(expected: string, then: (res: ServerResponse) => void, wrong?: unknown): Handler {
	return async (req, res) => {
		const body = await readJson(req)
		if ((body as { token?: unknown })?.token !== expected) return send(res, 400, wrong)
		return then(res)
	}
}

const INVITED = { grant_id: "g1", token: "tok-from-invite" }

async function sendsJsonTokenBody(): Promise<void> {
	const server = await serve([
		...baseRoutes(inviteSpec("body"), { members: [] }, INVITED),
		["POST", "/v1/invites/accept", acceptJsonToken],
		okRoute("DELETE", "/v1/orgs/org_1/grants/g1", { ok: true }),
	])

	const result = await runMember(server.url)
	const accept = sent(result.client.transcript, "POST", "/v1/invites/accept")
	expect(accept).toBeDefined()
	expect(accept?.status).toBe(200)
	expect(accept?.requestHeaders["content-type"]).toMatch(/application\/json/)
	expect(accept?.requestBody).toEqual({ token: "tok-from-invite" })
	expect(result.checksRun).toContain("auth.invite-grants-then-revokes")
}

async function keepsPathOnlyAccept(): Promise<void> {
	const server = await serve([
		...baseRoutes(inviteSpec("path"), { members: [] }, INVITED),
		["POST", "/v1/invites/tok-from-invite", acceptEmptyBody],
		okRoute("DELETE", "/v1/orgs/org_1/grants/g1", { ok: true }),
	])

	const result = await runMember(server.url)
	const accept = sent(result.client.transcript, "POST", "/v1/invites/tok-from-invite")
	expect(accept).toBeDefined()
	expect(accept?.status).toBe(200)
	expect(accept?.requestBody).toBeUndefined()
	expect(result.checksRun).toContain("auth.invite-grants-then-revokes")
}

async function sendsJsonRevokeBody(): Promise<void> {
	const server = await serve([
		...baseRoutes(inviteSpec("body", "body"), { members: [] }, INVITED),
		["POST", "/v1/invites/accept", acceptToken("tok-from-invite", (res) => send(res, 200, { ok: true }))],
		["POST", "/v1/invites/revoke", revokeJsonGrant],
	])

	const result = await runMember(server.url)
	const revoke = sent(result.client.transcript, "POST", "/v1/invites/revoke")
	expect(revoke).toBeDefined()
	expect(revoke?.status).toBe(200)
	expect(revoke?.requestHeaders["content-type"]).toMatch(/application\/json/)
	expect(revoke?.requestBody).toEqual({ grant_id: "g1" })
	expect(new URL(revoke?.url ?? "http://x").pathname).toBe("/v1/invites/revoke")
}

async function acceptsMailedToken(): Promise<void> {
	const spec = inviteSpecWith({ tokenFrom: "outOfBand", tokenKind: "org-invite" })
	const kinds: string[] = []
	const server = await serve([
		...baseRoutes(spec, { members: [] }, { grant_id: "g1", token: "tok-from-json-ignored" }),
		[
			"POST",
			"/v1/invites/accept",
			acceptToken("tok-from-mail", (res) => send(res, 200, { ok: true }), { error: "wrong" }),
		],
		okRoute("DELETE", "/v1/orgs/org_1/grants/g1", { ok: true }),
	])

	const result = await runMember(server.url, {
		hooks: {
			resolveOutOfBand: async ({ address, kind }) => {
				kinds.push(kind)
				expect(address).toBe("beta@x.test")
				return "tok-from-mail"
			},
		},
		outOfBand: OOB,
	})
	const accept = sent(result.client.transcript, "POST", "/v1/invites/accept")
	expect(accept?.requestBody).toEqual({ token: "tok-from-mail" })
	expect(kinds).toContain("org-invite")
	expect(result.checksRun).toContain("auth.invite-grants-then-revokes")
}

async function readsGrantWithAcceptToken(): Promise<void> {
	let granted = false
	const server = await serve([
		...baseRoutes(inviteSpec("body"), OWNER_LIST, INVITED),
		[
			"POST",
			"/v1/invites/accept",
			acceptToken("tok-from-invite", (res) => {
				granted = true
				send(res, 200, { access_token: "fresh", id: "g1" })
			}),
		],
		[
			"DELETE",
			"/v1/orgs/org_1/grants/g1",
			(_req, res) => {
				granted = false
				send(res, 200, { ok: true })
			},
		],
		memberRead(() => granted, "Bearer fresh", 403),
	])

	const result = await runMember(server.url)
	const acceptAt = result.client.transcript.findIndex(
		(exchange) => exchange.method === "POST" && new URL(exchange.url).pathname === "/v1/invites/accept",
	)
	const grantRead = sent(result.client.transcript.slice(acceptAt + 1), "GET", "/v1/orgs/org_1/members/m1")
	expect(acceptAt).toBeGreaterThanOrEqual(0)
	expect(grantRead?.requestHeaders.authorization).toBe("Bearer fresh")
	expect(grantRead?.status).toBe(200)
	expect(result.findings.filter((finding) => finding.check === "auth.invite-grants-then-revokes")).toEqual([])
}

/** A /consume link that grants and redirects to /app with a session cookie. */
function consumeLink(grant: () => void): Route {
	return [
		"GET",
		"/consume",
		(_req, res, url) => {
			if (url.searchParams.get("token") !== "mailed-link") return send(res, 404)
			grant()
			res.writeHead(303, { location: "/app", "set-cookie": "session=from-consume; Path=/" })
			res.end()
		},
	]
}

async function getsMailedLink(): Promise<void> {
	const spec = inviteSpecWith({ acceptFrom: "link", tokenFrom: "outOfBand", tokenKind: "org-invite" })
	let granted = false
	const oob: Array<{ kind: string; scope: Record<string, string>; headers: Record<string, string> }> = []
	const server = await serve([
		...baseRoutes(spec, OWNER_LIST, { grant_id: "g1", token: "ignored-json" }),
		okRoute("POST", "/v1/invites/accept", { ok: "json-token-accept-must-not-grant" }),
		consumeLink(() => {
			granted = true
		}),
		okRoute("GET", "/app", { ok: true }),
		[
			"DELETE",
			"/v1/orgs/org_1/grants/g1",
			(_req, res) => {
				granted = false
				send(res, 200, { ok: true })
			},
		],
		memberRead(() => granted, "Bearer b", 404),
	])

	const result = await runMember(server.url, {
		hooks: {
			resolveOutOfBand: async (request) => {
				oob.push({ headers: request.headers, kind: request.kind, scope: request.scope })
				return `${server.url}/consume?token=mailed-link`
			},
		},
		outOfBand: OOB,
	})
	const getAccept = sent(result.client.transcript, "GET", "/consume")
	const postAccept = sent(result.client.transcript, "POST", "/v1/invites/accept")
	expect(getAccept).toBeDefined()
	expect(getAccept?.status).toBe(200)
	expect(getAccept?.redirects?.[0]?.status).toBe(303)
	expect(postAccept).toBeUndefined()
	expect(oob[0]?.kind).toBe("org-invite")
	expect(oob[0]?.headers.authorization).toBe("Bearer b")
	expect(result.checksRun).toContain("auth.invite-grants-then-revokes")
	expect(result.findings.filter((f) => f.check === "auth.invite-grants-then-revokes")).toEqual([])
}

async function failsOnMissingLink(): Promise<void> {
	const spec = inviteSpecWith({ acceptFrom: "link", tokenFrom: "outOfBand" })
	const server = await serve([
		...baseRoutes(spec, OWNER_LIST, { grant_id: "g1", token: "tok" }),
		okRoute("POST", "/v1/invites/accept", { ok: true }),
		["GET", "/missing-consume", (_req, res) => send(res, 404)],
		ownerOnlyRead,
	])

	const result = await runMember(server.url, {
		hooks: { resolveOutOfBand: async () => `${server.url}/missing-consume?token=x` },
		outOfBand: OOB,
	})
	expect(
		result.inconclusive.some(
			(row) => row.check === "auth.invite-grants-then-revokes" && /accept returned 404/.test(row.reason),
		),
	).toBe(true)
	expect(sent(result.client.transcript, "POST", "/v1/invites/accept") !== undefined).toBe(false)
}

async function failsOnPostAgainstLinkWorld(): Promise<void> {
	const spec = inviteSpecWith({ tokenFrom: "outOfBand" })
	let granted = false
	const server = await serve([
		...baseRoutes(spec, OWNER_LIST, { grant_id: "g1", token: "tok" }),
		okRoute("POST", "/v1/invites/accept", { ok: true }),
		[
			"GET",
			"/consume",
			(_req, res) => {
				granted = true
				send(res, 200, { ok: true })
			},
		],
		memberRead(() => granted, "Bearer b", 404),
		okRoute("DELETE", "/v1/orgs/org_1/grants/g1"),
	])

	const result = await runMember(server.url, {
		hooks: { resolveOutOfBand: async () => `${server.url}/consume?token=mailed` },
		outOfBand: OOB,
	})
	expect(
		result.findings.some(
			(f) =>
				f.check === "auth.invite-grants-then-revokes" &&
				f.verdict === "BACKEND_BUG" &&
				/does not grant/.test(f.summary),
		),
	).toBe(true)
	expect(sent(result.client.transcript, "POST", "/v1/invites/accept") !== undefined).toBe(true)
	expect(sent(result.client.transcript, "GET", "/consume") !== undefined).toBe(false)
}

async function rejectsNonUrlLink(): Promise<void> {
	const spec = inviteSpecWith({ acceptFrom: "link", tokenFrom: "outOfBand" })
	const server = await serve([...baseRoutes(spec, OWNER_LIST, { grant_id: "g1", token: "tok" }), ownerOnlyRead])

	const result = await runMember(server.url, {
		hooks: { resolveOutOfBand: async () => "not-a-url" },
		outOfBand: OOB,
	})
	expect(
		result.inconclusive.some(
			(row) => row.check === "auth.invite-grants-then-revokes" && /absolute http\(s\) URL/.test(row.reason),
		),
	).toBe(true)
}

describe("invite accept request: token transport", () => {
	it("sends the documented JSON { token } body with application/json", sendsJsonTokenBody)
	it("keeps a path-only accept on the path and does not invent a body", keepsPathOnlyAccept)
	it("sends the documented JSON revoke body when revoke declares one", sendsJsonRevokeBody)
	it("accepts with the mailed token when tokenFrom is outOfBand", acceptsMailedToken)
	it("reads the grant with the access token the accept response returns", readsGrantWithAcceptToken)
})

describe("invite accept request: mailed link", () => {
	it("GETs the mailed URL when acceptFrom is link and does not POST accept JSON", getsMailedLink)
	it("fails when acceptFrom is link and the GET 404s even if POST-token would work", failsOnMissingLink)
	it("fails when the suite POSTs accept JSON against a world that only grants on GET-link", failsOnPostAgainstLinkWorld)
	it("rejects a non-URL out-of-band value when acceptFrom is link", rejectsNonUrlLink)
})

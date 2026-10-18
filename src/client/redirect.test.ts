import { describe, expect, it } from "vitest"
import { MAX_REDIRECTS } from "../runtime/cookies/redirect.ts"
import { credentialHeaderNames } from "../security/strip.ts"
import { type Answer, json, transport } from "./__fixtures__/transport.ts"
import type { FenceAsk } from "./fence.ts"
import { type FirstHop, type Following, sendFollowing } from "./redirect.ts"

const API = "http://api.test"

const redirect = (status: number, location: string | null, headers: Record<string, string> = {}): Response =>
	new Response(null, { headers: location === null ? headers : { ...headers, location }, status })

function setup(
	answer: Answer,
	more: Partial<Following> = {},
): { following: Following; asked: string[]; sent: ReturnType<typeof transport>["sent"] } {
	const wire = transport(answer)
	const asked: string[] = []
	const fence: FenceAsk = async (url, method, body) => {
		asked.push(`${method} ${url} ${JSON.stringify(body) ?? "-"}`)
	}
	const following: Following = {
		body: undefined,
		callerCookie: undefined,
		credentialNames: credentialHeaderNames(),
		fence,
		follow: true,
		send: wire.fetch,
		...more,
	}
	return { asked, following, sent: wire.sent }
}

const first = (more: Partial<FirstHop> = {}): FirstHop => ({
	body: undefined,
	headers: {},
	method: "GET",
	redirect: "manual",
	url: new URL(`${API}/a`),
	...more,
})

describe("sendFollowing", () => {
	it("sends once and keeps the first answer when not following", async () => {
		const { following, sent } = setup(() => redirect(302, "/b"), { follow: false })
		const landed = await sendFollowing(first({ body: "x", method: "POST", redirect: undefined }), following)
		expect(landed.response.status).toBe(302)
		expect(landed.hops).toEqual([])
		expect(landed.landing.toString()).toBe(`${API}/a`)
		expect(sent).toMatchObject([{ body: "x", method: "POST", redirect: undefined }])
	})

	it("follows a redirect with the jar's cookies and the caller's, recording each hop", async () => {
		const { following, sent, asked } = setup(
			(request) =>
				request.url.endsWith("/a") ? redirect(302, "/b", { "set-cookie": "sid=1; Path=/" }) : json({ at: "b" }),
			{ callerCookie: "pref=dark" },
		)
		const landed = await sendFollowing(first({ headers: { cookie: "pref=dark" } }), following)
		expect(landed.parsed).toEqual({ at: "b" })
		expect(landed.landing.toString()).toBe(`${API}/b`)
		expect(landed.hops).toEqual([
			{ responseHeaders: { location: "/b", "set-cookie": "sid=1; Path=/" }, status: 302, url: `${API}/a` },
		])
		expect(landed.jar.snapshot()).toEqual({ sid: "1" })
		expect(sent.map((request) => [request.url, request.headers.cookie, request.redirect])).toEqual([
			[`${API}/a`, "pref=dark", "manual"],
			[`${API}/b`, "pref=dark; sid=1", "manual"],
		])
		expect(asked).toEqual([`GET ${API}/b -`])
	})

	it("drops the body and its headers when a redirect turns a POST into a GET", async () => {
		const { following, sent, asked } = setup(
			(request) => (request.url.endsWith("/a") ? redirect(303, "/b") : json({})),
			{
				body: { n: 1 },
			},
		)
		const headers = { "content-length": "7", "content-type": "application/json" }
		await sendFollowing(first({ body: '{"n":1}', headers, method: "POST" }), following)
		expect(sent[1]).toMatchObject({ body: undefined, headers: {}, method: "GET" })
		expect(asked).toEqual([`GET ${API}/b -`])
	})

	it("resends the body and method on a 307, and asks the fence with the body", async () => {
		const { following, sent, asked } = setup(
			(request) => (request.url.endsWith("/a") ? redirect(307, "/b") : json({})),
			{
				body: { n: 1 },
			},
		)
		await sendFollowing(first({ body: '{"n":1}', method: "PUT" }), following)
		expect(sent[1]).toMatchObject({ body: '{"n":1}', method: "PUT" })
		expect(asked).toEqual([`PUT ${API}/b {"n":1}`])
	})
})

describe("sendFollowing across origins and limits", () => {
	it("gives another origin no credential and none of the caller's cookies", async () => {
		const { following, sent } = setup(
			(request) => (request.url.startsWith(API) ? redirect(302, "http://cdn.test/f") : json({})),
			{ callerCookie: "pref=dark", credentialNames: credentialHeaderNames(["x-key"]) },
		)
		const headers = { authorization: "Bearer t", cookie: "pref=dark", "x-key": "k", "x-other": "o" }
		const landed = await sendFollowing(first({ headers }), following)
		expect(sent[1]?.headers).toEqual({ "x-other": "o" })
		expect(landed.landing.toString()).toBe("http://cdn.test/f")
	})

	it("stops at a redirect without a location, and after the most hops it follows", async () => {
		const nowhere = setup(() => redirect(302, null))
		expect((await sendFollowing(first(), nowhere.following)).response.status).toBe(302)
		expect(nowhere.sent).toHaveLength(1)
		const loop = setup(() => redirect(302, "/a"))
		const landed = await sendFollowing(first(), loop.following)
		expect(landed.hops).toHaveLength(MAX_REDIRECTS)
		expect(loop.sent).toHaveLength(MAX_REDIRECTS + 1)
	})
})

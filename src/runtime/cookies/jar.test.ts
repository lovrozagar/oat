import { describe, expect, it } from "vitest"
import { applyJarToHeaders, CookieJar } from "./jar.ts"

describe("CookieJar", () => {
	it("scopes cookies to the host that set them", () => {
		const jar = new CookieJar()
		expect(jar.size).toBe(0)
		jar.absorb(new URL("https://app.example.com/verify"), [
			"session=abc; Path=/; HttpOnly",
			"HttpOnly",
			"empty=",
			"refresh=r1",
		])
		expect(jar.size).toBe(2)
		expect(jar.cookieHeader(new URL("https://app.example.com/app"))).toBe("session=abc; refresh=r1")
		expect(jar.cookieHeader(new URL("https://other.example.com/"))).toBeUndefined()
		expect(jar.snapshot()).toEqual({ refresh: "r1", session: "abc" })
		jar.absorb(new URL("https://app.example.com/"), ["session=new"])
		expect(jar.snapshot().session).toBe("new")
	})

	it("forgets a cookie the server deletes", () => {
		const jar = new CookieJar()
		const at = new URL("https://app.example.com/")
		jar.absorb(at, ["a=1", "b=2", "c=3", "d=4", "e=5"])
		jar.absorb(at, [
			"a=; Path=/",
			"b=x; Max-Age=0",
			"c=y; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
			"d=kept; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
			"e=kept; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
		])
		expect(jar.cookieHeader(at)).toBe("d=kept; e=kept")
	})
})

describe("CookieJar scoping", () => {
	it("sends a cookie only under its Path, only over https when Secure", () => {
		const jar = new CookieJar()
		jar.absorb(new URL("https://app.example.com/login"), [
			"scoped=1; Path=/api",
			"safe=2; Secure; Path=/",
			"odd=3; Path=x",
		])
		expect(jar.cookieHeader(new URL("https://app.example.com/api/x"))).toBe("scoped=1; safe=2; odd=3")
		expect(jar.cookieHeader(new URL("https://app.example.com/api"))).toBe("scoped=1; safe=2; odd=3")
		expect(jar.cookieHeader(new URL("https://app.example.com/apix"))).toBe("safe=2; odd=3")
		expect(jar.cookieHeader(new URL("http://app.example.com/api/x"))).toBe("scoped=1; odd=3")
	})

	it("widens to subdomains only through Domain, and only to a domain the host belongs to", () => {
		const jar = new CookieJar()
		jar.absorb(new URL("https://app.example.com/"), [
			"wide=1; Domain=.Example.com",
			"foreign=2; Domain=evil.test",
			"blank=3; Domain=",
		])
		expect(jar.cookieHeader(new URL("https://api.example.com/"))).toBe("wide=1")
		expect(jar.cookieHeader(new URL("https://app.example.com/"))).toBe("wide=1; blank=3")
		expect(jar.size).toBe(2)
	})

	it("scopes a cookie set without Path to the directory of the request", () => {
		const jar = new CookieJar()
		jar.absorb(new URL("https://app.example.com/account/settings/save"), ["pref=dark"])
		jar.absorb(new URL("https://app.example.com/top"), ["root=1"])
		jar.absorb(new URL("urn:app"), ["opaque=1"])
		expect(jar.cookieHeader(new URL("https://app.example.com/account/settings/view"))).toBe("pref=dark; root=1")
		expect(jar.cookieHeader(new URL("https://app.example.com/account/other"))).toBe("root=1")
		/* An opaque URL's path is no directory; its cookie is sent under "/", which an empty path reads as. */
		expect(jar.cookieHeader(new URL("urn:app"))).toBeUndefined()
		expect(jar.cookieHeader(new URL("urn:"))).toBe("opaque=1")
	})
})

describe("applyJarToHeaders", () => {
	it("rebuilds the Cookie header per hop: the caller's cookie, then the jar's", () => {
		const jar = new CookieJar()
		jar.absorb(new URL("https://app.example.com/"), ["session=new"])
		const headers: Record<string, string> = { authorization: "Bearer x", cookie: "pre=1" }
		applyJarToHeaders(headers, { callerCookie: "pre=1", jar, url: new URL("https://app.example.com/") })
		expect(headers.cookie).toBe("pre=1; session=new")
		/* Rebuilt per hop, never appended to: a second hop does not repeat the first. */
		applyJarToHeaders(headers, { callerCookie: "pre=1", jar, url: new URL("https://app.example.com/") })
		expect(headers.cookie).toBe("pre=1; session=new")
		const empty: Record<string, string> = {}
		applyJarToHeaders(empty, { jar, url: new URL("https://other.example.com/") })
		expect(empty.cookie).toBeUndefined()
		applyJarToHeaders(empty, { callerCookie: "", jar, url: new URL("https://other.example.com/") })
		expect(empty.cookie).toBeUndefined()
		applyJarToHeaders(empty, { jar, url: new URL("https://app.example.com/") })
		expect(empty.cookie).toBe("session=new")
	})
})

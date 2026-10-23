import { describe, expect, it } from "vitest"
import type { Inconclusive } from "../../runtime/finding.ts"
import { BASE, exchange, finding, operation, reportOf, scopeOf } from "./__fixtures__/report.ts"
import { renderJunit } from "./junit.ts"

/*
 * The run as JUnit XML, the common denominator CI tools read: a suite per entity, a case per
 * (operation, check), and an outcome that agrees with the exit code. Every test reads the file
 * back through a strict parser, so a test that passes also proves the file well-formed.
 */

interface Element {
	name: string
	attrs: Record<string, string>
	children: Element[]
	text: string
}

const ENTITIES: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' }

/* Throws, naming what is not well-formed: the parser fails the test that reads a bad file. */
function wellFormed(holds: boolean, why: string): void {
	if (!holds) throw new Error(`not well-formed: ${why}`)
}

function decoded(raw: string): string {
	wellFormed(!/[<>]|&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(raw), `unescaped markup in ${JSON.stringify(raw)}`)
	return raw.replace(/&(#\d+|\w+);/g, (_, ref: string) =>
		ref.startsWith("#") ? String.fromCodePoint(Number(ref.slice(1))) : (ENTITIES[ref] as string),
	)
}

function attributes(attrText: string): Record<string, string> {
	const attrs: Record<string, string> = {}
	for (const [, key, value] of attrText.matchAll(/([\w:-]+)="([^"]*)"/g)) {
		wellFormed(!((key as string) in attrs), `attribute ${key} twice`)
		attrs[key as string] = decoded(value as string)
	}
	return attrs
}

/** A strict reader for the XML oat writes: one declaration, elements, attributes, escaped text. */
function parseXml(xml: string): Element {
	wellFormed(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n') && xml.endsWith("\n"), "declaration")
	const root: Element = { attrs: {}, children: [], name: "#document", text: "" }
	const stack: Element[] = [root]
	const tokens = /<(\/?)([\w.:-]+)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/gy
	const body = xml.slice(xml.indexOf("\n") + 1)
	let at = 0
	for (const match of body.matchAll(tokens)) {
		at += match[0].length
		const [, closing, name, attrText, selfClosing, text] = match
		const top = stack.at(-1) as Element
		if (text !== undefined) top.text += decoded(text)
		else if (closing === "/") {
			wellFormed(top.name === name, `</${name}> closes <${top.name}>`)
			stack.pop()
		} else {
			const element: Element = { attrs: attributes(attrText as string), children: [], name: name as string, text: "" }
			top.children.push(element)
			if (selfClosing !== "/") stack.push(element)
		}
	}
	wellFormed(at === body.length, `unreadable at ${at}: ${body.slice(at, at + 40)}`)
	wellFormed(stack.length === 1 && root.children.length === 1 && root.text.trim() === "", "one root element")
	return root.children[0] as Element
}

function suites(xml: string): Element[] {
	const root = parseXml(xml)
	expect(root.name).toBe("testsuites")
	return root.children
}

function suite(xml: string, name: string): Element {
	return suites(xml).find((s) => s.attrs.name === name) as Element
}

/** Each case as `classname name: outcome message`. */
function cases(element: Element): string[] {
	return element.children.map((c) => {
		const result = c.children[0]
		const said = result === undefined ? "passed" : `${result.name} ${result.attrs.message ?? ""}`.trim()
		return `${c.attrs.classname} ${c.attrs.name}: ${said}`
	})
}

/* What the run records for a check that could not conclude, operations included. */
const unresolved = (entries: Inconclusive[]): Inconclusive[] => entries

const known = (reason: string) => finding({ check: "c", known: { reason }, operations: ["row.list"], summary: reason })

const clean = () =>
	reportOf({
		scope: scopeOf({
			operations: [
				operation({
					checks: { failed: [], gaps: [], inconclusive: [], passed: ["b.check", "a.check"], suppressed: [] },
				}),
				operation({
					checks: { failed: [], gaps: [], inconclusive: [], passed: ["a.check"], suppressed: [] },
					entity: "tag",
					operationId: "tag.get",
				}),
			],
		}),
	})

describe("renderJunit", () => {
	it("a clean run is one passing case per (operation, check)", () => {
		const xml = renderJunit(clean())
		const root = parseXml(xml)
		expect(root.attrs).toEqual({ errors: "0", failures: "0", name: "oat", tests: "3", time: "1.500" })
		expect(root.children.map((s) => s.attrs.name)).toEqual(["row", "tag"])
		expect(cases(suite(xml, "row"))).toEqual(["row.list a.check: passed", "row.list b.check: passed"])
		expect(suite(xml, "row").attrs).toEqual({
			errors: "0",
			failures: "0",
			name: "row",
			skipped: "0",
			tests: "2",
			timestamp: "1970-01-01T00:00:00Z",
		})
		expect(xml).not.toContain("oat.run")
	})

	it("a failing root cause is a failure with its verdict, summary and evidence", () => {
		const evidence = Array.from({ length: 7 }, (_, i) =>
			exchange({ method: "PATCH", status: 500 + i, url: `${BASE}/v1/rows/${i}` }),
		)
		const xml = renderJunit(
			reportOf({
				findings: [
					finding({ check: "c", detail: "first detail", evidence, operations: ["row.list"], summary: "broke" }),
					finding({ check: "c", detail: "second", operations: ["row.list"], summary: "also", verdict: "SECURITY" }),
				],
				scope: scopeOf({
					operations: [
						operation({
							checks: { failed: ["c"], gaps: [], inconclusive: [], passed: [], suppressed: [] },
							status: "failed",
						}),
					],
				}),
			}),
		)
		const failure = (suite(xml, "row").children[0] as Element).children[0] as Element
		expect(failure.name).toBe("failure")
		expect(failure.attrs).toEqual({ message: "broke", type: "BACKEND_BUG" })
		expect(failure.text).toBe(
			[
				"first detail",
				...[0, 1, 2, 3, 4].map((i) => `PATCH ${BASE}/v1/rows/${i} → ${500 + i}`),
				"… 2 more exchanges in oat-report.json",
				"",
				"second",
			].join("\n"),
		)
		expect(suite(xml, "row").attrs.failures).toBe("1")
		expect(suite(xml, "oat.run")).toBeUndefined()
	})
})

describe("renderJunit, a case per (operation, check)", () => {
	it("a known finding is skipped, not failed", () => {
		const xml = renderJunit(
			reportOf({
				findings: [known("tracked in #12"), known("tracked in #12"), known("vendor bug")],
				scope: scopeOf({
					operations: [
						operation({
							checks: { failed: ["c"], gaps: [], inconclusive: [], passed: [], suppressed: [] },
							status: "failed",
						}),
					],
				}),
			}),
		)
		expect(cases(suite(xml, "row"))).toEqual([
			"row.list c: skipped known (baseline): tracked in #12; known (baseline): vendor bug",
		])
		expect(parseXml(xml).attrs.failures).toBe("0")
	})

	it("gaps, inconclusive and suppressed are skipped with their reason", () => {
		const xml = renderJunit(
			reportOf({
				checksSuppressed: [{ because: "auth.required", check: "s", entity: "row" }],
				findings: [
					finding({ check: "g", operations: ["row.list"], summary: "needs a second tenant", verdict: "COVERAGE_GAP" }),
				],
				inconclusive: unresolved([
					{ check: "i", entity: "row", operations: ["row.other"], reason: "not this one" },
					{ check: "i", entity: "row", operations: ["row.list"], reason: "listing was empty" },
				]),
				scope: scopeOf({
					operations: [
						operation({ checks: { failed: [], gaps: ["g"], inconclusive: ["i"], passed: ["s"], suppressed: ["s"] } }),
					],
				}),
			}),
		)
		expect(cases(suite(xml, "row"))).toEqual([
			"row.list g: skipped coverage gap: needs a second tenant",
			"row.list i: skipped inconclusive: listing was empty",
			"row.list s: skipped blocked: waiting on auth.required",
		])
		expect(suite(xml, "row").attrs).toMatchObject({ skipped: "3", tests: "3" })
	})
})

describe("renderJunit, a missing record", () => {
	it("says what it can when the record behind a case is missing", () => {
		const xml = renderJunit(
			reportOf({
				scope: scopeOf({
					operations: [
						operation({ checks: { failed: ["f"], gaps: ["g"], inconclusive: ["i"], passed: [], suppressed: ["s"] } }),
					],
				}),
			}),
		)
		expect(cases(suite(xml, "row"))).toEqual([
			"row.list f: failure no finding names this check",
			"row.list g: skipped coverage gap",
			"row.list i: skipped inconclusive",
			"row.list s: skipped blocked: waiting on an earlier failure",
		])
	})
})

describe("renderJunit, cases outside an operation", () => {
	it("stand-downs are skipped cases in their entity's suite", () => {
		const skip = { check: "tenant.cross-read-refused", entity: "tag", needs: "a second tenant" }
		const xml = renderJunit(reportOf({ checksSkipped: [skip, skip], scope: scopeOf({ operations: [] }) }))
		expect(cases(suite(xml, "tag"))).toEqual(["tag tenant.cross-read-refused: skipped stood down: a second tenant"])
	})

	it("an ungraded operation is one skipped case", () => {
		const xml = renderJunit(
			reportOf({
				scope: scopeOf({
					operations: [
						operation({ entity: null, operationId: "ping", reason: "no check applies", status: "untested" }),
						operation({ operationId: "row.blocked", reason: null, status: "blocked" }),
					],
				}),
			}),
		)
		expect(cases(suite(xml, "operations"))).toEqual(["ping graded: skipped no check applies"])
		expect(cases(suite(xml, "row"))).toEqual(["row.blocked graded: skipped blocked"])
	})

	it("a failed run outcome is an error in oat.run", () => {
		const xml = renderJunit(
			reportOf({
				network: { attempts: 3, incomplete: true, kind: "dns", url: BASE, waitedMs: 0 },
				scope: scopeOf({ operations: [operation({ checks: { ...operation().checks, passed: ["a"] } })] }),
			}),
		)
		const outcome = suite(xml, "oat.run")
		expect(cases(outcome)).toEqual(["run outcome: error the network went away before the run finished"])
		expect((outcome.children[0] as Element).children[0]?.attrs.type).toBe("failed")
		expect(parseXml(xml).attrs).toMatchObject({ errors: "1", tests: "2" })
		expect(outcome.attrs).toMatchObject({ errors: "1", failures: "0", tests: "1" })
	})
})

describe("renderJunit, the oat.run suite", () => {
	it("puts run-level findings, and root causes no case holds, in oat.run by check", () => {
		const xml = renderJunit(
			reportOf({
				findings: [
					finding({ check: "teardown.removes", summary: "left a row" }),
					finding({ check: "teardown.removes", summary: "left another", verdict: "SPEC_BUG" }),
					finding({ check: "pacing", summary: "no room to pace", verdict: "COVERAGE_GAP" }),
					finding({ check: "network", summary: "stalled", verdict: "BLOCKED" }),
					finding({ check: "support.create", operations: ["row.create"], summary: "500 on create" }),
					finding({ check: "old", known: { reason: "#4" }, summary: "old" }),
					finding({ check: "gap.on.op", operations: ["row.list"], verdict: "COVERAGE_GAP" }),
				],
				scope: scopeOf({ operations: [] }),
			}),
		)
		expect(cases(suite(xml, "oat.run"))).toEqual([
			"run network: skipped blocked: stalled",
			"run old: skipped known (baseline): #4",
			"run outcome: error no operation was graded, so nothing was proved",
			"run pacing: skipped coverage gap: no room to pace",
			"run support.create: failure 500 on create",
			"run teardown.removes: failure left a row",
		])
		expect(suite(xml, "oat.run").attrs).toMatchObject({ errors: "1", failures: "2", skipped: "3", tests: "6" })
	})
})

describe("renderJunit, the file", () => {
	it("counts on every suite equal its cases", () => {
		const xml = renderJunit(
			reportOf({
				checksSkipped: [{ check: "x", entity: "row", needs: "n" }],
				findings: [finding({ check: "c", operations: ["row.list"] }), finding({ check: "run.c" })],
				network: { attempts: 3, incomplete: true, kind: "dns", url: BASE, waitedMs: 0 },
				scope: scopeOf({
					operations: [
						operation({
							checks: { failed: ["c"], gaps: [], inconclusive: [], passed: ["c", "p"], suppressed: [] },
							status: "failed",
						}),
					],
				}),
			}),
		)
		const root = parseXml(xml)
		let total = 0
		for (const s of root.children) {
			const outcomes = s.children.map((c) => c.children[0]?.name)
			expect(s.attrs).toMatchObject({
				errors: String(outcomes.filter((o) => o === "error").length),
				failures: String(outcomes.filter((o) => o === "failure").length),
				skipped: String(outcomes.filter((o) => o === "skipped").length),
				tests: String(s.children.length),
			})
			total += s.children.length
		}
		expect(root.attrs).toMatchObject({ errors: "1", failures: "2", tests: String(total) })
		expect(cases(suite(xml, "row"))).toEqual([
			"row x: skipped stood down: n",
			"row.list c: failure s",
			"row.list p: passed",
		])
	})
})

describe("renderJunit, escaping", () => {
	it("escapes markup and drops XML-invalid control characters", () => {
		const detail = "a <b> & \"c\" 'd' ]]> e\u0000f\u0007g\u000bh\u001fi\u{fffe}j\ud800k\udc00l 😀\ttab\r\nend"
		const xml = renderJunit(
			reportOf({
				findings: [finding({ check: "c", detail, operations: ["row.list"], summary: 'line one\nsays <"&">\u0001' })],
				scope: scopeOf({
					operations: [
						operation({
							checks: { failed: ["c"], gaps: [], inconclusive: [], passed: [], suppressed: [] },
							status: "failed",
						}),
					],
				}),
			}),
		)
		expect(xml).not.toContain("]]>")
		expect(xml).not.toContain("CDATA")
		expect([...xml].filter((c) => c < " " && !"\t\n\r".includes(c))).toEqual([])
		expect([...xml].filter((c) => c === "\u{fffe}" || c === "\u{ffff}")).toEqual([])
		expect(xml).toContain('message="line one&#10;says &lt;&quot;&amp;&quot;&gt;"')
		const failure = (suite(xml, "row").children[0] as Element).children[0] as Element
		expect(failure.text).toBe("a <b> & \"c\" 'd' ]]> efghijkl 😀\ttab\r\nend")
		expect(failure.attrs.message).toBe('line one\nsays <"&">')
	})
})

describe("renderJunit, redaction", () => {
	it("redacts a secret the run was issued, wherever it turns up", () => {
		const input = reportOf({
			findings: [
				finding({
					check: "c",
					detail: "echoed sk-live-123456 back",
					evidence: [exchange({ url: `${BASE}/v1/rows?key=sk-live-123456` })],
					operations: ["row.list"],
					summary: "leaks sk-live-123456",
				}),
			],
			scope: scopeOf({
				operations: [
					operation({
						checks: { failed: ["c"], gaps: [], inconclusive: [], passed: [], suppressed: [] },
						status: "failed",
					}),
				],
			}),
		})
		input.client.redactor.registerSecret("sk-live-123456")
		const xml = renderJunit(input)
		expect(xml).not.toContain("sk-live-123456")
		const failure = (suite(xml, "row").children[0] as Element).children[0] as Element
		expect(failure.attrs.message).toBe("leaks <redacted>")
		expect(failure.text).toContain("echoed <redacted> back")
	})
})

describe("renderJunit, secondary origins", () => {
	it("secondary-origin operations get origin-prefixed suite and class names", () => {
		const xml = renderJunit(
			reportOf({
				checksSkipped: [{ check: "x", entity: "billing:invoice", needs: "n" }],
				checksSuppressed: [{ because: "b.cause", check: "s", entity: "billing:invoice" }],
				findings: [
					finding({ check: "c", entity: "invoice", operations: ["invoice.get"], summary: "primary" }),
					finding({ check: "c", entity: "invoice", operations: ["invoice.get"], origin: "billing", summary: "theirs" }),
				],
				inconclusive: unresolved([
					{ check: "i", entity: "invoice", operations: ["invoice.get"], reason: "primary's" },
					{ check: "i", entity: "billing:invoice", reason: "billing's" },
				]),
				scope: scopeOf({
					operations: [
						operation({
							checks: { failed: ["c"], gaps: [], inconclusive: ["i"], passed: [], suppressed: ["s"] },
							entity: "invoice",
							operationId: "invoice.get",
							origin: "billing",
							status: "failed",
						}),
					],
				}),
			}),
		)
		expect(suites(xml).map((s) => s.attrs.name)).toEqual(["billing:invoice", "oat.run"])
		expect(cases(suite(xml, "billing:invoice"))).toEqual([
			"billing:invoice x: skipped stood down: n",
			"billing:invoice.get c: failure theirs",
			"billing:invoice.get i: skipped inconclusive: billing's",
			"billing:invoice.get s: skipped blocked: waiting on b.cause",
		])
		expect(cases(suite(xml, "oat.run"))).toEqual(["run c: failure primary"])
	})

	it("writes an empty suite list for a run with nothing to report", () => {
		const xml = renderJunit(reportOf())
		expect(suites(xml)).toEqual([])
		expect(parseXml(xml).attrs).toMatchObject({ errors: "0", failures: "0", tests: "0" })
	})
})

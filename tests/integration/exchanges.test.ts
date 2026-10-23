import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isSecretHeaderName } from "../../src/security/credential-names.ts"
import { Redactor } from "../../src/security/redact.ts"
import { isBinaryMediaType, primaryMediaType } from "../../src/runtime/exchanges/media.ts"
import { createExchangeJournal } from "../../src/runtime/exchanges/journal.ts"
import { exchangeFileStem, resolveSaveExchanges, sanitizeExchangeId } from "../../src/runtime/exchanges/files.ts"
import type { ReportInput } from "../../src/report/render/input.ts"
import { renderMarkdown } from "../../src/report/render/markdown.ts"
import { exchange, scratch } from "../support/exchanges-fixtures.ts"

describe("resolveSaveExchanges", () => {
	it("lets the CLI win, then config, then off only for cheap", () => {
		expect(resolveSaveExchanges({ flag: false, config: true, profile: "full" })).toBe(false)
		expect(resolveSaveExchanges({ flag: true, config: false, profile: "cheap" })).toBe(true)
		expect(resolveSaveExchanges({ config: false, profile: "full" })).toBe(false)
		expect(resolveSaveExchanges({ config: true, profile: "cheap" })).toBe(true)
		expect(resolveSaveExchanges({ profile: "cheap" })).toBe(false)
		expect(resolveSaveExchanges({ profile: "full" })).toBe(true)
		expect(resolveSaveExchanges({})).toBe(true)
	})
})

describe("redaction helpers", () => {
	it("redacts listed headers, x-*-key / x-*-secret, and JSON token fields", () => {
		expect(isSecretHeaderName("Authorization")).toBe(true)
		expect(isSecretHeaderName("cookie")).toBe(true)
		expect(isSecretHeaderName("Set-Cookie")).toBe(true)
		expect(isSecretHeaderName("Proxy-Authorization")).toBe(true)
		expect(isSecretHeaderName("x-ia-tester-key")).toBe(true)
		expect(isSecretHeaderName("x-api-key")).toBe(true)
		expect(isSecretHeaderName("X-Client-Secret")).toBe(true)
		expect(isSecretHeaderName("content-type")).toBe(false)
		expect(new Redactor().headers({ Authorization: "Bearer secret", Accept: "application/json" })).toEqual({
			Accept: "application/json",
			Authorization: "Bearer <redacted>",
		})
		expect(
			new Redactor().json({
				access_token: "aaa.bbb.ccc",
				nested: { refresh_token: "r", keep: 1 },
				items: [{ password: "p", id_token: "i", token: "t", secret: "s", api_key: "k" }],
			}),
		).toEqual({
			access_token: "<redacted>",
			items: [
				{
					api_key: "<redacted>",
					id_token: "<redacted>",
					password: "<redacted>",
					secret: "<redacted>",
					token: "<redacted>",
				},
			],
			nested: { keep: 1, refresh_token: "<redacted>" },
		})
		expect(new Redactor().json("plain")).toBe("plain")
	})
})

describe("file stems", () => {
	it("sanitizes ids and never reuses a taken name", () => {
		expect(sanitizeExchangeId("  abc/def:*?  ")).toBe("abc_def")
		expect(sanitizeExchangeId("___")).toBe("id")
		expect(sanitizeExchangeId("x".repeat(200)).length).toBe(180)
		expect(exchangeFileStem("", 3, new Set())).toBe("seq-3")
		expect(exchangeFileStem("req-1", 1, new Set())).toBe("req-1")
		expect(exchangeFileStem("req-1", 8, new Set(["req-1"]))).toBe("req-1-8")
		expect(exchangeFileStem("req-1", 8, new Set(["req-1", "req-1-8"]))).toBe("req-1-8-2")
		expect(exchangeFileStem("req-1", 8, new Set(["req-1", "req-1-8", "req-1-8-2"]))).toBe("req-1-8-3")
	})
})

describe("isBinaryMediaType", () => {
	it("classifies downloads that must not be inlined as base64", () => {
		expect(isBinaryMediaType("image/jpeg")).toBe(true)
		expect(isBinaryMediaType("audio/mpeg")).toBe(true)
		expect(isBinaryMediaType("video/mp4")).toBe(true)
		expect(isBinaryMediaType("application/pdf")).toBe(true)
		expect(isBinaryMediaType("application/octet-stream")).toBe(true)
		expect(isBinaryMediaType("application/zip")).toBe(true)
		expect(isBinaryMediaType("application/vnd.ms-excel")).toBe(true)
		expect(isBinaryMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true)
		expect(isBinaryMediaType("application/vnd.oasis.opendocument.spreadsheet")).toBe(true)
		expect(isBinaryMediaType("application/json")).toBe(false)
		expect(isBinaryMediaType("text/plain; charset=utf-8")).toBe(false)
		expect(isBinaryMediaType("; application/pdf")).toBe(true)
		expect(primaryMediaType("application/json; charset=utf-8", "x")).toBe("application/json")
		expect(primaryMediaType(";", "text/plain")).toBe("text/plain")
		expect(primaryMediaType("", "text/plain")).toBe("text/plain")
	})
})
async function flushesNothingBuffered(): Promise<void> {
	const dir = await scratch()
	const journal = createExchangeJournal(dir, new Redactor())
	await journal.flush()
	expect(journal.count).toBe(0)
}

async function persistsRedirectChain(): Promise<void> {
	const dir = await scratch()
	const journal = createExchangeJournal(dir, new Redactor())
	await journal.record(
		exchange({
			finalUrl: "http://app.test/app",
			method: "GET",
			redirects: [
				{
					responseHeaders: { location: "/app", "set-cookie": "session=secret; Path=/" },
					status: 303,
					url: "http://app.test/verify?t=1",
				},
			],
			requestId: "consume-1",
			seq: 7,
			status: 200,
			url: "http://app.test/verify?t=1",
		}),
	)
	await journal.flush()
	const file = JSON.parse(await readFile(join(dir, "exchanges/consume-1.json"), "utf8")) as {
		finalUrl: string
		redirects: Array<{ responseHeaders: Record<string, string>; status: number }>
	}
	expect(file.finalUrl).toBe("http://app.test/app")
	expect(file.redirects).toHaveLength(1)
	expect(file.redirects[0]?.status).toBe(303)
	expect(file.redirects[0]?.responseHeaders["set-cookie"]).toBe("<redacted>")
	await journal.flush()
	const line = JSON.parse((await readFile(join(dir, "exchanges.jsonl"), "utf8")).trim()) as {
		finalUrl: string
		redirects: number
	}
	expect(line.finalUrl).toBe("http://app.test/app")
	expect(line.redirects).toBe(1)
}

async function writesJoinableJson(): Promise<void> {
	const dir = await scratch()
	const journal = createExchangeJournal(dir, new Redactor())
	expect(journal.dir).toBe(dir)
	await journal.record(
		exchange({
			fixture: "invoice.pdf",
			method: "POST",
			operationId: "thing.create",
			requestBody: { name: "n", access_token: "eyJhbGciOiJ" },
			requestHeaders: { authorization: "Bearer super-secret", "content-type": "application/json" },
			requestId: "req-json",
			responseBody: { id: "1", name: "n" },
			responseHeaders: { "content-type": "application/json", "x-request-id": "req-json" },
			seq: 1,
			status: 201,
			url: "http://x.test/v1/things",
		}),
		{ check: "effects.declared-effect-occurs", entity: "thing", phase: "test" },
	)
	await journal.flush()
	await journal.record(
		exchange({
			method: "GET",
			operationId: "thing.read",
			requestId: "req-get",
			responseBody: { id: "1" },
			responseHeaders: { "content-type": "application/json" },
			seq: 2,
			url: "http://x.test/v1/things/1",
		}),
	)
	await journal.flush()
	expect(journal.count).toBe(2)
	await journal.flush()
	const jsonl = (await readFile(join(dir, "exchanges.jsonl"), "utf8")).trim().split("\n")
	const first = JSON.parse(jsonl[0] ?? "{}") as Record<string, unknown>
	expect(first["requestId"]).toBe("req-json")
	expect(first["file"]).toBe("exchanges/req-json.json")
	expect(first["check"]).toBe("effects.declared-effect-occurs")
	expect(first["entity"]).toBe("thing")
	expect(first["phase"]).toBe("test")
	expect(first["fixture"]).toBe("invoice.pdf")
	expect(first["operationId"]).toBe("thing.create")
	const file = JSON.parse(await readFile(join(dir, "exchanges/req-json.json"), "utf8")) as {
		requestHeaders: Record<string, string>
		requestBody: Record<string, unknown>
		status: number
	}
	expect(file.status).toBe(201)
	expect(file.requestHeaders["authorization"]).toBe("Bearer <redacted>")
	expect(file.requestBody["access_token"]).toBe("<redacted>")
	expect(file.requestBody["name"]).toBe("n")
	const disk = await readFile(join(dir, "exchanges/req-json.json"), "utf8")
	expect(disk).not.toMatch(/Bearer super-secret/)
	expect(disk).not.toContain("eyJhbGciOiJ")
	expect(existsSync(join(dir, "exchanges/req-get.json"))).toBe(true)
}

async function contentAddressesFixture(): Promise<void> {
	const dir = await scratch()
	const journal = createExchangeJournal(dir, new Redactor())
	const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03])
	const once = async (seq: number, requestId: string): Promise<void> => {
		const form = new FormData()
		form.append("title", "scan")
		form.append("password", "nope")
		form.append("file", new File([bytes], "photo.jpg", { type: "image/jpeg" }))
		await journal.record(
			exchange({
				method: "POST",
				requestBody: form,
				requestId,
				seq,
				url: "http://x.test/v1/upload",
			}),
		)
		await journal.flush()
	}
	await once(1, "up-1")
	await once(2, "up-2")
	const blobs = await readdir(join(dir, "blobs"))
	expect(blobs).toHaveLength(1)
	const one = JSON.parse(await readFile(join(dir, "exchanges/up-1.json"), "utf8")) as {
		requestBody: { parts: Array<Record<string, unknown>> }
	}
	const two = JSON.parse(await readFile(join(dir, "exchanges/up-2.json"), "utf8")) as {
		requestBody: { parts: Array<Record<string, unknown>> }
	}
	expect(one.requestBody.parts[2]).toMatchObject({
		bytes: 6,
		field: "file",
		filename: "photo.jpg",
		mediaType: "image/jpeg",
		sha256: blobs[0],
	})
	expect(one.requestBody.parts[2]?.["sha256"]).toBe(two.requestBody.parts[2]?.["sha256"])
	expect(one.requestBody.parts[1]).toEqual({ field: "password", value: "<redacted>" })
	expect(JSON.stringify(one)).not.toContain("ÿ")
	const stored = await readFile(join(dir, "blobs", blobs[0] ?? ""))
	expect([...stored]).toEqual([...bytes])
}

async function namesMissingOrDuplicateIds(): Promise<void> {
	const dir = await scratch()
	const journal = createExchangeJournal(dir, new Redactor())
	await journal.record(exchange({ requestId: "", seq: 4, url: "http://x.test/a" }))
	await journal.flush()
	await journal.record(exchange({ requestId: "same", seq: 5, url: "http://x.test/b" }))
	await journal.flush()
	await journal.record(exchange({ requestId: "same", seq: 6, url: "http://x.test/c" }))
	await journal.flush()
	expect(existsSync(join(dir, "exchanges/seq-4.json"))).toBe(true)
	expect(existsSync(join(dir, "exchanges/same.json"))).toBe(true)
	expect(existsSync(join(dir, "exchanges/same-6.json"))).toBe(true)
	const first = JSON.parse(await readFile(join(dir, "exchanges/same.json"), "utf8")) as { url: string }
	const second = JSON.parse(await readFile(join(dir, "exchanges/same-6.json"), "utf8")) as { url: string }
	expect(first.url).toBe("http://x.test/b")
	expect(second.url).toBe("http://x.test/c")
	await journal.flush()
	const lines = (await readFile(join(dir, "exchanges.jsonl"), "utf8")).trim().split("\n")
	expect(JSON.parse(lines[2] ?? "{}")).toMatchObject({ file: "exchanges/same-6.json", requestId: "same" })
}

async function keepsExistingStem(): Promise<void> {
	const dir = await scratch()
	await mkdir(join(dir, "exchanges"), { recursive: true })
	await writeFile(join(dir, "exchanges/pre.json"), '{"keep":true}\n')
	const journal = createExchangeJournal(dir, new Redactor())
	await journal.record(exchange({ requestId: "pre", seq: 9 }))
	await journal.flush()
	expect(JSON.parse(await readFile(join(dir, "exchanges/pre.json"), "utf8"))).toEqual({ keep: true })
	expect(existsSync(join(dir, "exchanges/pre-9.json"))).toBe(true)
	await writeFile(join(dir, "exchanges/dup.json"), "{}\n")
	await writeFile(join(dir, "exchanges/dup-3.json"), "{}\n")
	await journal.record(exchange({ requestId: "dup", seq: 3 }))
	await journal.flush()
	expect(existsSync(join(dir, "exchanges/dup-3-2.json"))).toBe(true)
}

async function passesCompactedBodies(): Promise<void> {
	const dir = await scratch()
	const journal = createExchangeJournal(dir, new Redactor())
	const ref = { bytes: 3, mediaType: "text/plain", sha256: "abc" }
	await journal.record(
		exchange({
			method: "POST",
			requestBody: ref,
			requestId: "ref-1",
			responseBody: ref,
			responseHeaders: { "content-type": "text/plain" },
			seq: 1,
		}),
	)
	await journal.flush()
	const snap = { parts: [{ field: "title", value: "scan" }] }
	await journal.record(exchange({ method: "POST", requestBody: snap, requestId: "snap-1", seq: 2 }))
	await journal.flush()
	const file = JSON.parse(await readFile(join(dir, "exchanges/ref-1.json"), "utf8")) as {
		requestBody: unknown
		responseBody: unknown
	}
	expect(file.requestBody).toEqual(ref)
	expect(file.responseBody).toEqual(ref)
	const snapFile = JSON.parse(await readFile(join(dir, "exchanges/snap-1.json"), "utf8")) as {
		requestBody: unknown
	}
	expect(snapFile.requestBody).toEqual(snap)
}

describe("exchange journal", () => {
	it("writes nothing on a flush with nothing buffered", flushesNothingBuffered)
	it("persists a followed redirect chain with redacted Set-Cookie", persistsRedirectChain)
	it("writes a JSON POST/GET that jsonl can join by requestId", writesJoinableJson)
	it("content-addresses the same multipart fixture across two POSTs", contentAddressesFixture)
	it("names a missing request id seq-<n>.json and does not overwrite a duplicate id", namesMissingOrDuplicateIds)
	it("does not clobber a stem that already exists on disk", keepsExistingStem)
	it("passes through already-compacted body refs and form snapshots", passesCompactedBodies)
})

describe("report line", () => {
	it("names the exchanges directory and count", () => {
		const md = renderMarkdown({
			baseUrl: "http://x.test",
			checksRun: ["list.read-after-write"],
			client: { transcript: [] },
			durationMs: 1,
			entitiesTested: ["widget"],
			exchanges: { count: 1841 },
			findings: [],
			model: { entities: new Map(), operations: [] },
			startedAt: new Date("2026-08-18T00:00:00.000Z"),
		} as unknown as ReportInput)
		expect(md).toContain("**Exchanges**: 1841 → [exchanges/](./exchanges/)")
	})
})

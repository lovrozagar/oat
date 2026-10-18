import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../../src/client/client.ts"
import { INLINE_BODY_LIMIT } from "../../src/runtime/exchanges/media.ts"
import { createExchangeJournal } from "../../src/runtime/exchanges/journal.ts"
import { Redactor } from "../../src/security/redact.ts"
import { isNetworkError } from "../../src/errors/network.ts"
import { run } from "../../src/runtime/run/index.ts"
import { holdsLiveBody } from "../../src/runtime/transcript/live.ts"
import { isBodyRef, isFormSnapshot } from "../../src/runtime/exchange.ts"
import { releaseTranscriptBodies } from "../../src/runtime/transcript/release.ts"
import { sha256Hex } from "../../src/runtime/exchanges/bytes.ts"
import {
	drainThenCreate,
	type Listening,
	listen,
	scratch,
	serveHungList,
	serveUploads,
} from "../support/transcript-fixtures.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

/* Registers a started server for teardown. */
async function track(started: Promise<Listening>): Promise<Listening> {
	const server = await started
	closers.push(server.close)
	return server
}

type Recorded = { requestBody: { parts: Array<Record<string, unknown>> } }

async function snapshotsRecordedForm() {
	const dir = await scratch()
	const journal = createExchangeJournal(dir, new Redactor())
	const bytes = new Uint8Array(64).fill(7)
	const server = await track(
		listen((_req, res) => {
			res.writeHead(201, { "content-type": "application/json" })
			res.end(JSON.stringify({ id: "1" }))
		}),
	)
	const client = new Client({
		baseUrl: server.url,
		maxInFlight: 1,
		onExchange: (exchange) => journal.record(exchange),
		redactor: new Redactor(),
	})
	const form = new FormData()
	form.append("note", "hi")
	form.append("file", new File([bytes], "blob.bin", { type: "application/octet-stream" }))
	const exchange = await client.request("POST", "/upload", {
		body: form,
		fixture: "blob.bin",
		operationId: "upload.once",
	})
	/* The transcript keeps a compact copy; the caller keeps the real body. */
	const stored = client.transcript.at(-1)
	expect(holdsLiveBody(stored?.requestBody)).toBe(false)
	expect(isFormSnapshot(stored?.requestBody)).toBe(true)
	expect(exchange.requestBody).toBe(form)
	expect(exchange.responseBody).toEqual({ id: "1" })
	await journal.flush()
	expect(exchange.fixture).toBe("blob.bin")
	const name = `${exchange.requestId || `seq-${exchange.seq}`}.json`
	const file = JSON.parse(await readFile(join(dir, "exchanges", name), "utf8")) as Recorded
	const listing = await readdir(join(dir, "exchanges"))
	const recorded = JSON.parse(await readFile(join(dir, "exchanges", listing[0] ?? ""), "utf8")) as Recorded
	expect(recorded.requestBody.parts[1]).toMatchObject({
		bytes: 64,
		field: "file",
		filename: "blob.bin",
		sha256: sha256Hex(bytes),
	})
	expect(existsSync(join(dir, "blobs", sha256Hex(bytes)))).toBe(true)
	expect(file.requestBody.parts[1]?.sha256).toBe(sha256Hex(bytes))
}

async function compactsTimedOutAttempt() {
	const server = await track(
		listen((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.write('event: progress\ndata: {"n":1}\n\n')
		}),
	)
	const form = new FormData()
	form.append("file", new File([new Uint8Array(32).fill(1)], "hang.bin"))
	const client = new Client({
		baseUrl: server.url,
		maxInFlight: 1,
		network: {
			requestTimeoutMs: 80,
			retries: 0,
		},
		redactor: new Redactor(),
	})
	await expect(client.request("POST", "/stream", { body: form })).rejects.toSatisfy(
		(error: unknown) => isNetworkError(error) && error.kind === "timeout",
	)
	expect(client.transcript).toHaveLength(1)
	expect(holdsLiveBody(client.transcript[0]?.requestBody)).toBe(false)
	expect(client.transcript[0]?.responseBody).toMatchObject({ error: "network", kind: "timeout" })
	expect(typeof client.transcript[0]?.responseBody).not.toBe("string")
}

function titledForm(): FormData {
	const form = new FormData()
	form.append("title", "t")
	return form
}

async function keepsMetadataAfterRelease() {
	const exchange = {
		at: 1,
		durationMs: 1,
		method: "POST",
		requestBody: titledForm(),
		requestBytes: 10,
		requestHeaders: { authorization: "Bearer x" },
		requestId: "r1",
		responseBody: "z".repeat(INLINE_BODY_LIMIT + 2),
		responseBytes: 10,
		responseHeaders: { "content-type": "text/plain" },
		seq: 1,
		status: 200,
		url: "http://x.test/v1/x",
		fixture: "a.bin",
		operationId: "upload.once",
	}
	await releaseTranscriptBodies(exchange, new Redactor())
	expect(exchange.method).toBe("POST")
	expect(exchange.url).toBe("http://x.test/v1/x")
	expect(exchange.status).toBe(200)
	expect(exchange.requestId).toBe("r1")
	expect(exchange.operationId).toBe("upload.once")
	expect(exchange.fixture).toBe("a.bin")
	expect(isFormSnapshot(exchange.requestBody)).toBe(true)
	expect(isBodyRef(exchange.responseBody)).toBe(true)
}

describe("Client transcript lifecycle", () => {
	it("replaces live FormData with a snapshot after the journal records it", snapshotsRecordedForm)
	it("compacts a failed attempt so a timeout cannot leave a live FormData on the transcript", compactsTimedOutAttempt)
	it("keeps citeable metadata after release", keepsMetadataAfterRelease)
})

const FAN_OUT = 8

const PART_SIZE = 512 * 1024

/* Posts one distinct part per upload, keeping only a weak hold on each file and its digest. */
async function postParts(client: Client): Promise<{ digests: string[]; files: WeakRef<File>[] }> {
	const files: WeakRef<File>[] = []
	const digests: string[] = []
	for (let i = 0; i < FAN_OUT; i++) {
		const bytes = new Uint8Array(PART_SIZE)
		bytes.fill(i + 1)
		bytes[0] = i
		digests.push(createHash("sha256").update(bytes).digest("hex"))
		const file = new File([bytes], `part-${i}.bin`, { type: "application/octet-stream" })
		files.push(new WeakRef(file))
		const form = new FormData()
		form.append("file", file)
		await client.request("POST", "/uploads", {
			body: form,
			fixture: `part-${i}.bin`,
			operationId: "upload.once",
		})
	}
	return { digests, files }
}

/* The files the transcript let go are collectable: at most one survives two collections. */
async function expectPartsCollected(files: WeakRef<File>[]): Promise<void> {
	const gc = globalThis.gc
	expect(gc).toBeTypeOf("function")
	gc?.()
	await new Promise<void>((resolve) => {
		setImmediate(resolve)
	})
	gc?.()
	expect(files.filter((ref) => ref.deref() !== undefined).length).toBeLessThanOrEqual(1)
}

async function journalsUniqueParts() {
	const server = await track(listen((req, res) => drainThenCreate(req, res, () => ({ id: "1" }))))
	const exchangeDir = await scratch()
	const journal = createExchangeJournal(exchangeDir, new Redactor())
	const client = new Client({
		baseUrl: server.url,
		maxInFlight: 2,
		onExchange: (exchange) => journal.record(exchange),
		redactor: new Redactor(),
	})
	await client.request("GET", "/warmup")
	const { digests, files } = await postParts(client)
	const product = FAN_OUT * PART_SIZE
	const posts = client.transcript.filter((e) => e.method === "POST")
	expect(posts).toHaveLength(FAN_OUT)
	expect(posts.every((e) => !holdsLiveBody(e.requestBody))).toBe(true)
	expect(posts.every((e) => isFormSnapshot(e.requestBody))).toBe(true)
	expect(posts.every((e) => e.fixture?.startsWith("part-") === true)).toBe(true)
	const retained = Buffer.byteLength(JSON.stringify(posts.map((e) => ({ req: e.requestBody, res: e.responseBody }))))
	expect(retained).toBeLessThan(64 * 1024)
	expect(retained).toBeLessThan(product / 16)
	const blobs = await readdir(join(exchangeDir, "blobs"))
	expect(blobs).toHaveLength(FAN_OUT)
	for (const digest of digests) {
		expect(blobs).toContain(digest)
		expect(existsSync(join(exchangeDir, "blobs", digest))).toBe(true)
	}
	expect(journal.count).toBe(FAN_OUT + 1)
	await expectPartsCollected(files)
}

async function runLeavesDescriptors() {
	const dir = await scratch()
	await writeFile(join(dir, "one.bin"), new Uint8Array(32).fill(1))
	await writeFile(join(dir, "two.bin"), new Uint8Array(32).fill(2))
	const server = await track(serveUploads())
	const result = await run({
		baseUrl: server.url,
		cohortSize: 1,
		configDir: dir,
		network: { retries: 0, waitMs: 0 },
		only: ["upload"],
		principals: [{ headers: {}, id: "alpha" }],
		seed: 1,
		spec: `${server.url}/openapi.json`,
		uploads: { each: { "upload.once": ["./*.bin"] }, eachMax: 2 },
	})
	const posts = result.client.transcript.filter((e) => e.method === "POST" && new URL(e.url).pathname === "/uploads")
	expect(posts.length).toBeGreaterThanOrEqual(2)
	expect(posts.every((e) => isFormSnapshot(e.requestBody))).toBe(true)
	expect(posts.every((e) => !holdsLiveBody(e.requestBody))).toBe(true)
	expect(posts.some((e) => e.fixture === "one.bin" || e.fixture === "two.bin")).toBe(true)
}

describe("uploads.each fan-out does not scale RSS with fixtureBytes × N", () => {
	it("journals unique parts and keeps transcript descriptors", { timeout: 30_000 }, journalsUniqueParts)
	it("run() with uploads.each leaves descriptors, not live FormData", runLeavesDescriptors)
})

async function noGiantPartialBuffer() {
	const server = await track(serveHungList())
	const result = await run({
		baseUrl: server.url,
		cohortSize: 1,
		network: { requestTimeoutMs: 120, retries: 0, waitMs: 0 },
		only: ["item"],
		principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
		seed: 1,
		spec: `${server.url}/openapi.json`,
	})
	/* The host answered the create: the hung list is that operation failing, not an outage. */
	expect(result.network?.incomplete ?? false).toBe(false)
	expect(
		result.findings.some((f) => f.check === "response.no-server-error" && f.operations?.includes("item.list") === true),
	).toBe(true)
	for (const exchange of result.client.transcript) {
		expect(holdsLiveBody(exchange.requestBody)).toBe(false)
		expect(holdsLiveBody(exchange.responseBody)).toBe(false)
	}
	const oversizedText = result.client.transcript
		.map((exchange) => exchange.responseBody)
		.filter((body) => typeof body === "string" && body.length > INLINE_BODY_LIMIT)
	expect(oversizedText).toEqual([])
}

describe("run() times out a hung stream on a host that still answers", () => {
	it("does not leave a giant partial buffer on the transcript", noGiantPartialBuffer)
})

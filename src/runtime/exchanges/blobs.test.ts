import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { REDACTED, Redactor } from "../../security/redact.ts"
import { createBlobStore } from "./blobs.ts"
import { sha256Hex, utf8Encode } from "./bytes.ts"
import { INLINE_BODY_LIMIT } from "./media.ts"

let dir = ""

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "oat-blobs-"))
	mkdirSync(join(dir, "blobs"))
})

afterEach(() => {
	rmSync(dir, { force: true, recursive: true })
})

describe("BlobStore.put", () => {
	it("writes bytes once, under their hash", async () => {
		const store = createBlobStore(dir, new Redactor())
		const bytes = utf8Encode("payload")
		const sha256 = sha256Hex(bytes)
		expect(await store.put(bytes)).toEqual({ bytes: 7, sha256 })
		const path = join(dir, "blobs", sha256)
		expect(readFileSync(path, "utf8")).toBe("payload")
		const written = statSync(path).mtimeMs
		writeFileSync(path, "changed")
		await store.put(bytes)
		expect([readFileSync(path, "utf8"), statSync(path).mtimeMs >= written]).toEqual(["changed", true])
	})

	it("leaves a blob an earlier journal wrote where it is", async () => {
		const bytes = utf8Encode("kept")
		writeFileSync(join(dir, "blobs", sha256Hex(bytes)), "from before")
		await createBlobStore(dir, new Redactor()).put(bytes)
		expect(readFileSync(join(dir, "blobs", sha256Hex(bytes)), "utf8")).toBe("from before")
	})
})

describe("BlobStore.spillText / persistJson", () => {
	it("keeps text inline up to the limit, and by reference past it", async () => {
		const store = createBlobStore(dir, new Redactor())
		expect(await store.spillText("short", "text/plain")).toBe("short")
		const long = "x".repeat(INLINE_BODY_LIMIT + 1)
		expect(await store.spillText(long, "text/csv")).toEqual({
			bytes: INLINE_BODY_LIMIT + 1,
			mediaType: "text/csv",
			sha256: sha256Hex(utf8Encode(long)),
		})
	})

	it("keeps JSON redacted, inline up to the limit, and by reference past it", async () => {
		const redactor = new Redactor()
		const store = createBlobStore(dir, redactor)
		expect(store.redactor).toBe(redactor)
		expect(await store.persistJson({ name: "n", password: "p" }, "application/json")).toEqual({
			name: "n",
			password: REDACTED,
		})
		const big = { rows: "y".repeat(INLINE_BODY_LIMIT) }
		const stored = (await store.persistJson(big, "application/vnd.x+json")) as Record<string, unknown>
		expect([stored.mediaType, stored.bytes, stored.sha256]).toEqual([
			"application/vnd.x+json",
			INLINE_BODY_LIMIT + 11,
			sha256Hex(utf8Encode(JSON.stringify(big))),
		])
	})
})

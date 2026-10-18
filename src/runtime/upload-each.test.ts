import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { forEachInvocation, resolveEachInvocations } from "./upload-each.ts"
import { type UploadContext, uploadMemory } from "./upload.ts"

/* A folder holding `names`, each a one-byte file. */
function folder(names: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "oat-each-"))
	for (const name of names) writeFileSync(join(root, name), "x")
	return root
}

function each(root: string | undefined, patterns: string[], more: Partial<UploadContext> = {}) {
	const warnings: string[] = []
	const context: UploadContext = {
		seed: 1,
		uploads: { each: { "doc.create": patterns } },
		warn: (message) => warnings.push(message),
		...(root === undefined ? {} : { configDir: root }),
		...more,
	}
	return { context, warnings }
}

describe("resolveEachInvocations", () => {
	it("is null for an operation `each` does not name", async () => {
		expect(await resolveEachInvocations("doc.create", { seed: 1 })).toBeNull()
		expect(await resolveEachInvocations("doc.other", each(undefined, ["*.pdf"]).context)).toBeNull()
	})

	it("is one sorted slot per distinct readable file", async () => {
		const root = folder(["b.pdf", "a.pdf"])
		const { context } = each(root, ["b.pdf", "*.pdf"])
		expect(await resolveEachInvocations("doc.create", context)).toEqual([
			{ filename: "a.pdf", index: 0, path: join(root, "a.pdf"), total: 2 },
			{ filename: "b.pdf", index: 1, path: join(root, "b.pdf"), total: 2 },
		])
	})

	it("reads absolute patterns without a config folder", async () => {
		const root = folder(["a.pdf"])
		const slots = await resolveEachInvocations("doc.create", each(undefined, [join(root, "a.pdf")]).context)
		expect(slots?.map((slot) => slot.path)).toEqual([join(root, "a.pdf")])
	})

	it("warns, once per run for a missing path, and is empty when nothing is usable", async () => {
		const root = folder(["locked.pdf"])
		chmodSync(join(root, "locked.pdf"), 0)
		const { context, warnings } = each(root, ["gone.pdf", "gone.pdf", "locked.pdf"], { memory: uploadMemory() })
		expect(await resolveEachInvocations("doc.create", context)).toEqual([])
		expect(warnings).toEqual([
			"uploads.each path not found: gone.pdf",
			`uploads.each could not read ${join(root, "locked.pdf")}`,
			"uploads.each matched 0 files for doc.create",
		])
	})

	it("caps at eachMax with a warning, and ignores a cap that cannot apply", async () => {
		const root = folder(["a.pdf", "b.pdf", "c.pdf"])
		const capped = each(root, ["*.pdf"])
		capped.context.uploads = { each: { "doc.create": ["*.pdf"] }, eachMax: 2 }
		expect((await resolveEachInvocations("doc.create", capped.context))?.map((slot) => slot.filename)).toEqual([
			"a.pdf",
			"b.pdf",
		])
		expect(capped.warnings).toEqual(["uploads.each capped doc.create at 2 of 3"])
		for (const eachMax of [-1, 3]) {
			const loose = each(root, ["*.pdf"])
			loose.context.uploads = { each: { "doc.create": ["*.pdf"] }, eachMax }
			expect(await resolveEachInvocations("doc.create", loose.context)).toHaveLength(3)
			expect(loose.warnings).toEqual([])
		}
	})
})

describe("forEachInvocation", () => {
	it("runs once per slot, each with the slot as its fixture", async () => {
		const root = folder(["a.pdf", "b.pdf"])
		const { context } = each(root, ["*.pdf"])
		const seen = await forEachInvocation("doc.create", context, async (next, slot) => [
			next.fixture?.filename,
			slot?.index,
		])
		expect(seen).toEqual([
			["a.pdf", 0],
			["b.pdf", 1],
		])
	})

	it("runs once, without a slot, when the operation has none", async () => {
		const { context } = each(folder([]), ["*.pdf"])
		const calls = await forEachInvocation("doc.create", context, async (next, slot) => [next === context, slot])
		expect(calls).toEqual([[true, undefined]])
		expect(await forEachInvocation("doc.other", context, async (_next, slot) => slot)).toEqual([undefined])
	})
})

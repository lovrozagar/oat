#!/usr/bin/env bun
/*
 * `bun scripts/changelog-has.ts <version>`: exits 0 when CHANGELOG.md has a `## <version>` heading,
 * else 1 naming what is missing. The release runs it before anything is published, so a version
 * goes out only with the changelog that says what is in it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Whether `changelog` has a line that is exactly `## <version>`. */
export function hasHeading(changelog: string, version: string): boolean {
	return changelog.split("\n").some((line) => line.trimEnd() === `## ${version}`)
}

if (import.meta.main) {
	const version = (process.argv[2] ?? "").replace(/^v/, "")
	const changelog = readFileSync(join(import.meta.dirname, "..", "CHANGELOG.md"), "utf8")
	if (version === "" || !hasHeading(changelog, version)) {
		console.error(`CHANGELOG.md has no "## ${version}" heading: add one before tagging v${version}`)
		process.exit(1)
	}
}

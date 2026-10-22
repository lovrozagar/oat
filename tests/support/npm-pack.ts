/** What `npm pack --dry-run --json` says it would ship. */
export interface PackedManifest {
	files: Array<{ path: string }>
}

/**
 * The manifests in `npm pack --json` output. npm 10 runs `prepare` despite `--ignore-scripts`, so a
 * hook's banner can precede the JSON: it starts at the first line that opens an array or an object.
 * npm 10 prints an array of manifests, npm 12 an object keyed by package name.
 */
export function packedManifests(stdout: string): PackedManifest[] {
	const lines = stdout.split("\n")
	const start = lines.findIndex((line) => line.startsWith("[") || line.startsWith("{"))
	try {
		if (start < 0) throw new Error("no JSON in the output")
		return Object.values(JSON.parse(lines.slice(start).join("\n")) as object) as PackedManifest[]
	} catch (error) {
		throw new Error(`npm pack printed no manifest JSON (${(error as Error).message}): ${stdout.slice(0, 200)}`, {
			cause: error,
		})
	}
}

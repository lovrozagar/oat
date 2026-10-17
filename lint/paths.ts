/** The linted file as a `/`-separated path with one leading slash, whatever the platform gave. */
export function repoPath(filename: string): string {
	return `/${filename.replaceAll("\\", "/").replace(/^\/+/, "")}`
}

/** Test code and its fixtures: none of it ships, so the product rules leave it alone. */
export function isTestCode(file: string): boolean {
	return /\.(test|typetest)\.ts$/.test(file) || file.includes("/tests/") || file.includes("/__fixtures__/")
}

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export function loadDotEnv(): Record<string, string> {
	const env: Record<string, string> = {}
	try {
		for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
			const trimmed = line.trim()
			if (trimmed === "" || trimmed.startsWith("#")) continue
			const eq = trimmed.indexOf("=")
			if (eq === -1) continue
			const key = trimmed.slice(0, eq)
			const value = trimmed.slice(eq + 1)
			env[key] = value
			if (process.env[key] === undefined) process.env[key] = value
		}
	} catch {
		/* provision writes .env; serve fails later if keys are missing */
	}
	return env
}

export function d1EnvKey(worldId: string): string {
	return `CLOUDFLARE_D1_${worldId.toUpperCase().replaceAll("-", "_")}`
}

export function requireD1(worldId: string): {
	accountId: string
	apiToken: string
	databaseId: string
} {
	const env = loadDotEnv()
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID
	const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN
	const key = d1EnvKey(worldId)
	const databaseId = process.env[key] ?? env[key]
	if (!accountId || !apiToken || !databaseId) {
		throw new Error(
			`labs/${worldId} needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, ${key}. Run: node labs/provision.mjs ${worldId}`,
		)
	}
	return { accountId, apiToken, databaseId }
}

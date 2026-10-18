import { readTargetVersion, TARGET_VERSION_READ, type TargetVersion } from "../target-version.ts"
import type { Planned, RunPrincipals } from "./context.ts"

/** Which build this run tested, read once before anything is created. Never part of the verdict. */
export async function readVersion(ctx: Planned & { principals: RunPrincipals }): Promise<TargetVersion | undefined> {
	const { options, model, client, principals } = ctx
	if (options.targetVersion === undefined) return undefined
	const { alpha } = principals
	return readTargetVersion({
		client: client.view({ check: TARGET_VERSION_READ, purpose: "probe" }),
		headers: alpha.headers,
		model,
		roots: { ...options.roots, ...alpha.roots },
		spec: options.targetVersion,
	})
}

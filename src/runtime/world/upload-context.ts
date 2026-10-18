import type { UploadContext } from "../upload.ts"
import type { WorldOptions } from "./types.ts"

/** The uploads a create sends: the run's, or a seed-only context when it configured none. */
export function uploadContext(options: WorldOptions): UploadContext {
	return (
		options.uploads ?? {
			seed: options.seed,
		}
	)
}

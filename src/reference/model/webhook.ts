import { TIMESTAMPS } from "./timestamps.ts"
import type { EntityDef } from "./types.ts"

/**
 * A project's webhook: registered, read back, changed and removed by its id, and never listed.
 * Present so an entity with no list operation has something to exercise: its cohort is the
 * records its creates return, and its teardown reads each one back to show it gone.
 */
export const WEBHOOK: EntityDef = {
	collectionPath: "/v1/projects/{project_id}/webhooks",
	defaultLimit: 20,
	defaultOrder: "created_at.desc",
	fields: [
		{ generated: true, immutable: true, name: "id", required: true, type: "string" },
		{ generated: true, immutable: true, name: "project_id", required: true, type: "string" },
		{ maxLength: 128, name: "name", required: true, type: "string" },
		{ maxLength: 512, name: "url", required: true, type: "string" },
		{ maxLength: 256, name: "description", nullable: true, type: "string" },
		{ enum: ["active", "paused"], name: "status", type: "string" },
		...TIMESTAMPS,
	],
	identity: "id",
	itemParam: "webhook_id",
	itemPath: "/v1/projects/{project_id}/webhooks/{webhook_id}",
	maxLimit: 100,
	name: "webhook",
	parents: ["project_id"],
	plural: "webhooks",
	unlisted: true,
}

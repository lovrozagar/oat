import { TIMESTAMPS } from "./timestamps.ts"
import type { EntityDef } from "./types.ts"

/**
 * An asynchronous job. Present so the async lifecycle — receipt, poll, terminal state — has
 * something to exercise; extraction, export and batch APIs are all shaped this way.
 */
export const JOB: EntityDef = {
	collectionPath: "/v1/projects/{project_id}/jobs",
	defaultLimit: 20,
	defaultOrder: "created_at.desc",
	fields: [
		{ generated: true, immutable: true, name: "id", required: true, sortable: true, filterable: true, type: "string" },
		{ generated: true, immutable: true, name: "project_id", required: true, filterable: true, type: "string" },
		{
			filterable: true,
			maxLength: 128,
			name: "name",
			required: true,
			searchable: true,
			sortable: true,
			type: "string",
		},
		/* A second freely-writable string, purely so the concurrency check has two independent
		 * fields to race on. With only `name` writable it could never establish that two patches
		 * to *different* fields both survive, and it stood down on every run. */
		{
			filterable: true,
			maxLength: 256,
			name: "note",
			nullable: true,
			searchable: true,
			sortable: true,
			type: "string",
		},
		/*
		 * A low-cardinality field the *client* sets.
		 *
		 * Every other field on this entity is either unique per record or server-generated, which
		 * left no value shared by some records but not all — so any property asserted over a
		 * proper subset (a filter that matches several rows and excludes others) had nothing to
		 * work with and stood down. Real collections always have a repeated dimension; a fixture
		 * without one silently narrows what can be tested.
		 */
		{
			enum: ["export", "import", "sync"],
			filterable: true,
			name: "kind",
			sortable: true,
			type: "string",
		},
		{
			enum: ["pending", "running", "complete", "failed"],
			filterable: true,
			generated: true,
			name: "status",
			sortable: true,
			type: "string",
		},
		{ filterable: true, generated: true, name: "progress", sortable: true, type: "integer" },
		...TIMESTAMPS,
	],
	identity: "id",
	itemParam: "job_id",
	itemPath: "/v1/projects/{project_id}/jobs/{job_id}",
	maxLimit: 100,
	name: "job",
	parents: ["project_id"],
	plural: "jobs",
}

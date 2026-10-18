/**
 * Correct API shapes the reference backend can be served in.
 *
 * Every dialect in `dialect/presets.ts` is an API oat was written against. A shape is the opposite: a
 * choice a correct backend is entitled to make that oat was *not* written against — pages without
 * a more-pages flag, UUID identifiers, a mount under a path prefix, PUT instead of PATCH. Each is
 * a server option rather than a proxy, so the backend stays correct by construction and the only
 * thing that can produce a finding is an assumption oat made.
 *
 * The conformance suite runs the clean baseline behind each shape and requires zero findings.
 * Shapes oat does not handle yet are listed in `conformance/expected-failures.ts`, which may only shrink.
 */

import type { QueryConventions } from "../query/conventions.ts"

export interface ReferenceShape {
	/** Pagination model, layered over the dialect. */
	pagination?: "page-total" | "cursor-only" | "offset-total"
	/** A page-size ceiling the server applies without documenting it. */
	clampLimit?: number
	/** Records already in the collection before oat arrives, per tenant. */
	prepopulate?: number
	/** Identifier format, with malformed path identifiers rejected as 400. */
	ids?: "uuid" | "integer"
	conventions?: Partial<QueryConventions>
	/** Every route is served under this prefix; the base URL includes it. */
	basePath?: string
	/** The update operation's method. PUT replaces the writable fields wholesale. */
	updateMethod?: "PATCH" | "PUT"
	/** A `writeOnly` secret accepted on create and never returned. */
	writeOnlyField?: boolean
	/** Create accepts `application/x-www-form-urlencoded` only. */
	formCreate?: boolean
	/** Required date-time, a bounded number, a `const`, and one component schema used twice. */
	richSchema?: boolean
	/** Each record carries a large generated field, so one page exceeds 256 KiB. */
	largeRecords?: boolean
	/** Responses documented as `2XX` and `default` rather than exact codes. */
	rangeStatuses?: boolean
	/** `components` before `paths`, path-level `parameters`, and a recursive schema. */
	specLayout?: boolean
	/** The table's identity is an integer the client chooses on create, within these bounds. */
	clientIds?: { min: number; max: number }
	/** The table's create answers `{ success: true }` instead of the record it made. */
	ackCreate?: boolean
	/** Each record's identity is a field of this name (`ID`) instead of `id`. */
	identityField?: string
	/**
	 * Single records travel wrapped: a create answers `{ success, id, message, data }`, a read
	 * `{ data, fields }`, an update or a delete `{ success, id, message }` with no record at all,
	 * and a listing carries a `fields` sidecar beside its rows. The document says where the
	 * record is (`x-entity.recordPath`) and where a create's id is (`createdIdFrom`).
	 */
	recordEnvelope?: boolean
	/** Each record carries a read-only related record with an id of its own: `Status: { ID, Name }`. */
	relatedRecord?: boolean
	/**
	 * Sort keys are `name_ascending` / `name_descending`, several only as the sort parameter
	 * repeated (`?sort=A_descending&sort=B_ascending`), declared as a template with `join: "repeat"`.
	 */
	repeatedSort?: boolean
	/** Route parameters are documented as bare strings, whatever the identity is: some frameworks emit them so. */
	bareIdParams?: boolean
	/**
	 * A table is named in paths by a slug the server derives from its name, unique only within its
	 * project: two tenants can each hold `quarterly-report-0`. Rows keep the table's internal id.
	 */
	tableKey?: "slug"
}

export interface NamedShape {
	name: string
	/** What a correct backend is doing differently here, in the reader's terms. */
	why: string
	shape: ReferenceShape
	/**
	 * Checks that cannot apply to this shape at all, and why. Every other check the default
	 * baseline runs must also run here: a check that quietly stops applying is how an unfamiliar
	 * API ends up "clean".
	 */
	cannotRun?: Readonly<Record<string, string>>
	/** Defects with nowhere to happen in this shape: a page-number API cannot drift a cursor. */
	cannotExhibit?: readonly string[]
	/** Defects only this shape can show, run in its recall pass on top of the common ones. */
	exhibits?: readonly string[]
}

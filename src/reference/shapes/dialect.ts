import type { Dialect } from "../dialect/types.ts"
import type { ReferenceShape } from "./types.ts"

/** The dialect as this shape serves it: its pagination model and sort spelling replace the dialect's own. */
export function shapedDialect(dialect: Dialect, shape: ReferenceShape): Dialect {
	const paged = pagedDialect(dialect, shape)
	if (shape.repeatedSort !== true) return paged
	return {
		...paged,
		params: { ...paged.params, order: "sort" },
		sortGrammar: "template",
		sortTemplate: { asc: "ascending", desc: "descending", join: "repeat", term: "{field}_{direction}" },
	}
}

function pagedDialect(dialect: Dialect, shape: ReferenceShape): Dialect {
	if (shape.pagination === undefined) return dialect
	if (shape.pagination === "page-total") return pageTotal(dialect)
	if (shape.pagination === "offset-total") return offsetTotal(dialect)
	return cursorOnly(dialect)
}

/* Page numbers and a total: no cursor, no offset, no more-pages flag. */
function pageTotal(dialect: Dialect): Dialect {
	const params = { ...dialect.params }
	const envelope = dialect.envelope === null ? null : { ...dialect.envelope }
	delete params.cursor
	delete params.offset
	params.page = params.page ?? "page"
	if (envelope !== null) {
		delete envelope.hasMore
		delete envelope.nextCursor
		envelope.page = envelope.page ?? "page"
		envelope.total = envelope.total ?? "total"
	}
	return { ...dialect, envelope, params }
}

/* Rows skipped and taken. The rows and how many there are in all: nothing says whether more pages follow. */
function offsetTotal(dialect: Dialect): Dialect {
	const params = { ...dialect.params }
	delete params.cursor
	delete params.page
	params.offset = "skip"
	params.limit = "take"
	return { ...dialect, envelope: { collection: "data", total: "totalCount" }, params }
}

/* A forward cursor and nothing else to page by. */
function cursorOnly(dialect: Dialect): Dialect {
	const params = { ...dialect.params }
	const envelope = dialect.envelope === null ? null : { ...dialect.envelope }
	delete params.page
	delete params.offset
	params.cursor = params.cursor ?? "cursor"
	if (envelope !== null) {
		delete envelope.hasMore
		delete envelope.page
		delete envelope.total
		envelope.nextCursor = envelope.nextCursor ?? "next_cursor"
	}
	return { ...dialect, envelope, params }
}

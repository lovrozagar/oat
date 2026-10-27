# oat — Origins and uploads

[← back to the overview](../../README.md)

## Secondary origins

One run, one primary `baseUrl`. A CDN (or any second host) keeps its own OpenAPI.

```ts
export default defineConfig({
	spec: "https://api.example.com/openapi.json",
	baseUrl: "https://api.example.com",
	security: {
		jwt: { login: { steps: [{ operationId: "auth.login", body: { email: "{principal.email}" } }], from: "$.token" } },
	},
	principals: { alpha: { email: "alpha@example.test", tenant: "acme" } },
	origins: [
		{
			id: "cdn",
			baseUrl: "https://cdn.example.com",
			spec: "https://cdn.example.com/openapi.json",
			security: { bearer: "jwt" },
		},
	],
})
```

Each origin's document is read once, at load, and the config is checked against it too. An origin scheme sends a recipe's credential only where `origins[].security` maps it (`{ <origin scheme>: <recipe> }`); an unmapped scheme sends nothing, and an origin scheme that shares a name with a primary recipe must be mapped. A recipe is usually a primary scheme's. It may instead name a scheme only an origin declares, mapped there: oat checks it against that origin scheme, acquires it once for the run, and sends it in that scheme's place with the recipe's own `format` and `placements`. When two origins map the same such recipe, the first in `origins` names its scheme. The same principals run the matrix against that document. Login steps may set `origin: "cdn"` to send one hop to a named origin.

Do not merge CDN routes into the API gateway document.

## Uploads

Multipart and binary parts are filled in this order:

1. `hooks.resolveUpload` — a non-null `UploadFile` wins. `{ fields }` that includes a file part replaces the whole request. `{ fields }` that omits the file part overlays scalars and keeps the each / pool / dummy bytes.
2. `uploads.each` fixture for this invocation, when that operation is listed.
3. `uploads.pool` — first file whose extension / sniffed type matches the part's `contentMediaType`. Same `seed` + field + index → same pick. Ops not in `each` stay pick-one.
4. A tiny dummy with sniffable magic (`%PDF-1.1`, 1×1 PNG, empty zip, …). Unknown types become 16 octet-stream bytes, not a skip.

`uploads.each` is a matrix, not a source. `operationId → globs` means that operation is invoked once per matched file (after `eachMax`). Same seed does **not** collapse `each`. A hook that ignores `request.fixture` and always returns the same file will send that file N times.

Each invocation is still a citeable hop (method, URL, status, fixture name, content-addressed body). Live `FormData` / `Blob` payloads are **not** kept on `Client.transcript` for the rest of the run — they are replaced with `{ sha256, bytes, mediaType }` (and multipart `{ parts }`) after the hop is journaled, or immediately when the journal is off. Fan-out therefore multiplies requests, not retained fixture bytes.

```ts
export default defineConfig({
	spec: "openapi.json",
	baseUrl: "https://api.example.com",
	principals: [/* … */],
	uploads: {
		pool: ["./fixtures/**/*"],
		each: {
			"extract.once": ["./fixtures/**/*"],
			"extract.stream": ["./fixtures/**/*"],
		},
		eachMax: 24,
	},
	hooks: {
		resolveUpload: async ({ operationId, field, fixture }) => {
			if (operationId === "extract.once" && field === "file") {
				return { fields: { columns: "vendor,date,amount" } }
			}
			return null
		},
	},
})
```

| case                            | outcome                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `each` omitted                  | pick-one (today)                                            |
| glob matches 0 files            | warn once, no extra invocations, fall through to pool/dummy |
| one path in the list is missing | drop that slot, warn once, never `BACKEND_BUG`              |
| `eachMax` < match count         | first `eachMax` after sort, warn that it capped             |
| fixture unreadable              | drop that slot, warn once, not `BACKEND_BUG`                |

A missing pool path warns once and falls through. An empty pool match uses a dummy. The run does not fail. JSON configs may set `pool`, `each`, and `eachMax`. `resolveUpload` is TypeScript.

`--profile cheap` (or any profile that excludes the op) still drops the whole family. `each` does not punch through a profile.

Findings from an `each` invocation carry `fixture: "invoice.pdf"` and render as `extract.once · invoice.pdf`. One 5xx is one finding on that file.

oat does not OCR. It sends bytes and checks HTTP / JSON. A 200 with empty extract rows is not automatically a backend defect. A 4xx because the dummy is “not a real invoice” is not automatically a backend defect if the dummy matched the declared `contentMediaType`.

Prefer `multipart/form-data` when the operation documents it, even if JSON is also listed. Text form fields still use the string generator (`format` / `pattern` / `maxLength`). A part that is either text or file is sent as a file when the schema is binary.

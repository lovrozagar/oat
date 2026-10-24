import { defineConfig, env } from "../../../src/index.ts"

/*
 * crAPI is huge; the run is scoped to the shop-order lifecycle, which alone carries three of its
 * documented vulnerabilities (see expected.json): the order read is unauthenticated (challenge 14),
 * it returns any user's order and card data (challenge 4 / BOLA), and crAPI accepts a JWT whose
 * signature was altered (challenge 15). Two principals in different tenants make the cross-tenant
 * read run; the login recipe mints each a real token so the signature-flip probe has one to derive.
 */
export default defineConfig({
	spec: "./crapi-openapi-spec.json",
	baseUrl: env("CRAPI_URL"),
	seed: 42,
	cohortSize: 4,
	/*
	 * create_order answers an acknowledgement ({ id, message, credit }) that echoes none of the
	 * submitted fields; oat seeds and judges the record it reads back by that id instead.
	 */
	ops: ["create_order", "get_orders", "get_order_byID"],
	security: {
		bearerAuth: {
			login: {
				steps: [
					{
						operationId: "login",
						body: { email: "{principal.email}", password: "{principal.password}" },
					},
				],
				from: "$.token",
			},
		},
	},
	principals: {
		alpha: { tenant: "alpha", email: env("CRAPI_ALPHA_EMAIL"), password: env("CRAPI_ALPHA_PASSWORD") },
		beta: { tenant: "beta", email: env("CRAPI_BETA_EMAIL"), password: env("CRAPI_BETA_PASSWORD") },
	},
	overlay: {
		operations: {
			create_order: {
				"x-entity": { name: "order", action: "create", identity: "id", createdIdFrom: "$.id" },
				requestBody: {
					content: {
						/* An unconstrained product_id 500s the handler; keep the cohort on the two seeded products. */
						"application/json": {
							schema: { properties: { product_id: { enum: [1, 2] }, quantity: { enum: [1] } } },
						},
					},
				},
			},
			get_orders: {
				"x-entity": { name: "order", action: "list", identity: "id", recordPath: "$.orders" },
			},
			get_order_byID: {
				/* An order is private to the user who placed it; order_id is the owner-scoped selector. */
				"x-entity": { name: "order", action: "read", identity: "id", recordPath: "$.order" },
				"x-tenant": "order_id",
				/*
				 * The document says the read answers { orders: Order }; crAPI answers { order: Order, payment }
				 * (see README.md). The record's schema is read where the server puts it.
				 */
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									required: ["order"],
									properties: { orders: null, order: { $ref: "#/components/schemas/Order" } },
								},
							},
						},
					},
				},
			},
		},
	},
})

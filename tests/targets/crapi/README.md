# crAPI

OWASP crAPI, scoped to the shop-order lifecycle: `create_order`, `get_orders` and
`get_order_byID`. The images are pinned by digest in `compose.yml`; `target.ts` signs up the two
principals, and `expected.json` lists every finding a run reports, each with why it is deserved.

## The signing key

The identity service signs tokens with crAPI's own published test key, which `compose.yml` mounts
from `keys/jwks.json`. It is an RSA private key, so it is not committed: secret scanners refuse it
whatever its origin. `target.ts` fetches it before the stack starts from OWASP/crAPI at
1b338594a6876062d3f97ad4a2929c39c0f4f3f3 (`deploy/docker/keys/jwks.json`) and keeps it only when its
sha256 is the pinned one; `.gitignore` keeps it out of git.

## Spec notes

- **The item read answers `{ order }`, not `{ orders }`.** `crapi-openapi-spec.json` documents
  `GET /workshop/api/shop/orders/{order_id}` (`get_order_byID`) as answering
  `{ orders: Order }`, with `orders` required. crAPI answers `{ order: Order, payment: … }`. The
  overlay in `oat.config.ts` corrects the 200 schema so the record is read where the server puts
  it. Without that overlay, `schema.read-response-matches-document` reports the mismatch on the
  pinned images (2026-10-24):

  ```
  SPEC_BUG schema.read-response-matches-document on get_order_byID: get_order_byID returned 200
  with a body that fails the declared schema: (root) must have required property 'orders'.
  ```

  The overlay stays so the rest of the order lifecycle is graded against the record where crAPI
  puts it.

- **`create_order` takes `product_id`, and the order answers `product`.** The request schema
  (`ProductQuantity`) carries `product_id`; `Order` declares `product`, an object, and no
  `product_id`. `create.persists-submitted-fields` judges only the submitted fields the record's
  schema declares, so `product_id` is not read as dropped.
- **An unknown product crashes the create.** Any `product_id` other than the seeded 1 and 2 answers
  500 with Django's HTML error page. The overlay narrows `product_id` to `[1, 2]` so the cohort is
  valid; the out-of-enum probe still finds the crash (`validation.enum-enforced` in
  `expected.json`).
- **No order delete.** The document has no route that removes an order, so the orders a run places
  stay behind and the run reports a `world.teardown` coverage gap.

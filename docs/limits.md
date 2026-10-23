# Limits

What oat cannot do yet, what you see when you hit it, and what to do instead. Each one is a gap oat reports, never a finding it invents.

## A filter parameter under a name oat does not know

oat finds a list's filter parameter by its name alone: `filter`, `where`, `query` or `conditions`, in any case or spelling (`filterBy` is not one of them), with an optional bracketed suffix (`filter[status]`). A parameter under any other name, such as Typesense's `filter_by`, is not used as the filter parameter. No config key or `x-query` field names it today, and an overlay cannot rename it: oat would then send the name the overlay gave it, not the one the server reads.

What you see: the filter checks for that list do not apply. Each one stands down, and the reason names the query parameter it would have sent, which the list operation does not declare. oat sends nothing to the parameter it could not name, so the list gets no false filter findings either.

What to do instead:

- Name the fields as one query parameter each when the API takes them that way (`?status=active`): declare the parameters on the operation, and the per-field filter checks run on them.
- Test the custom filter with a scenario. A step can send `?filter_by=...` as written and assert on the answer.

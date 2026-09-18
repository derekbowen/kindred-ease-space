# Correction to the header of `20260918000000_entitlement_grants.sql`

**The migration file itself is deliberately not edited.** It is applied to production
and its text is the ledger's stored statement; editing it would break the
content-hash reconciliation that proves the two match
(`c90c47dafe2dde72bfec5b70e7ee928b`, normalized). This note carries the correction
instead.

## What the header gets wrong

The header says, under "THE DIVERGENCE FIX":

> `publish_tenant_pages()` summed `base + addon + bonus` and never consulted
> `subscription_status`, while the application's `decideCapacity()` returned 0 pages
> for the same workspace. Today every customer workspace is an EXPIRED TRIAL, so the
> app reported "0 pages" while this function would have published 25.

That describes the **monorepo branch**, not production. It was written from the branch
tree and never checked against what was actually deployed.

At the time the migration was applied, production served `0fadfa9`. In that tree
`src/lib/billing-capacity.ts` **does not exist** — there is no `decideCapacity`
anywhere in `src/`. The deployed entitlement read was `entitlements.functions.ts`:

```js
const limit = base + addon + bonus;   // never consults subscription_status
```

which is exactly what the old `publish_tenant_pages()` did. **The two layers in
production agreed.** Both were status-blind, and both would have granted an expired
trial 25 pages.

## What the migration therefore actually did

Not "reconciled two layers that disagreed" — it made the **database stricter than the
deployed application**, ahead of the application half shipping:

| Workspace | deployed UI reported | publish gate after this migration |
| --- | --- | --- |
| 5 × customer (all expired trials) | 25 pages, 25 remaining | limit 0, publish denied |
| `pool-rental-near-me` (internal, active) | 1,000,000 | 1,000,000 — unchanged |

Impact at the time was nil: `tenant_pages` was empty across the entire database, so
there was nothing to publish and nothing went dark. The dashboard overstated capacity
for those five workspaces until the application half was deployed.

## What is still correct in the header

Everything else. The rule it states —

```
paidPages  = stripe_publish ? base + addon + bonus : 0
grantPages = sum(page_limit) over grants active now
effective  = paidPages + grantPages        -- additive, never greater-of
publish    = stripe_publish OR grantPages > 0
serve      = stripe_serve   OR grantPages > 0
```

— is the rule both layers now implement, and `tests/entitlement-grants.test.ts`
asserts they agree. The privilege reasoning, the append-only design, the read-time
expiry argument and the rollback caveat all stand unchanged.

## Why this was not caught earlier

The claim was carried forward across several reports without being checked against a
live deployment. The check that settles it is one request:

```
curl -s https://founders.click/api/public/version
```

and then reading the tree at the SHA it returns — not the branch under development.

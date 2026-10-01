# Proving the Stripe webhook in test mode against a deployed endpoint

The webhook source serves two deployments (see `supabase/functions/stripe-webhook/index.ts`,
`stripeEnvFor`): `stripe-webhook` (live) and `stripe-webhook-test` (test mode). Each ignores
the other mode's events. Which one a request is for is decided by the function-name segment of
the request path (`/functions/v1/<name>`), never by how the path ends: a sub-path request to
the live function such as `…/stripe-webhook/stripe-webhook-test` stays live, so the live
deployment cannot be steered onto the test signing secret. This is the procedure that produces
the evidence the release requires: one signed test-mode event reaches the deployed test
endpoint, is recorded exactly once, updates entitlement, and an identical replay is ignored.

## Inputs the operator provides (never paste values into chat, tickets or commits)
1. Supabase project secrets (Dashboard → Edge Functions → Secrets):
   - `STRIPE_SECRET_KEY_TEST` — a Stripe **test-mode** secret key (`sk_test_…`)
   - `STRIPE_WEBHOOK_SECRET_TEST` — the signing secret of the test-mode endpoint created in step 3
2. Deploy the test function: same source as `stripe-webhook`, name `stripe-webhook-test`,
   `verify_jwt=false` (Stripe signs, it does not carry a JWT).
   For checkout, deploy `create-checkout` again under the name `create-checkout-test`
   (`verify_jwt=true`): the files of `supabase/functions/create-checkout/` plus the
   `_shared/` files it imports, uploaded under the new name (Supabase dashboard, the
   management API, or the Supabase MCP `deploy_edge_function`). Always deploy the `-test`
   functions from the SAME commit as the live ones, and delete them when the proof is done.
   `create-checkout-test` refuses (503 `test_mode_misconfigured`) unless
   `STRIPE_SECRET_KEY_TEST` is a test-mode key (`sk_test_…` or `rk_test_…`).
3. Stripe Dashboard (test mode) → Developers → Webhooks → Add endpoint:
   `https://xbxhzinnfhosoztqaaao.supabase.co/functions/v1/stripe-webhook-test`
   Events: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`.
   Copy its signing secret into `STRIPE_WEBHOOK_SECRET_TEST`.
4. A throwaway workspace `<WS>`, created for this proof and for nothing else: sign up a fresh
   account (or create a new workspace) and publish nothing in it, so there are no live pages
   for a test event to suspend or reactivate — except the one page the lifecycle proof
   below publishes on its own test hostname, on purpose. **Never use the pool-rental-near-me workspace**,
   or any other workspace a customer, a live site or a sitemap depends on.
5. Supabase project secret (Dashboard → Edge Functions → Secrets):
   - `STRIPE_TEST_WORKSPACE_IDS` — the id of `<WS>`. Comma-separated UUIDs if a second
     throwaway workspace is ever needed; anything that is not a UUID is ignored. The test
     deployment writes for a workspace only when its id is in this list. Unset or empty, it
     refuses every test-mode event that would write. Remove the id again when the proof is done.

## The proof
Use the throwaway workspace id `<WS>` from input 4, listed in `STRIPE_TEST_WORKSPACE_IDS`
(input 5).

1. In Stripe test mode create a customer and a subscription on the Starter price with
   metadata `workspace_id=<WS>`, `plan_tier=starter` (Stripe CLI:
   `stripe subscriptions create --customer cus_… --items[0][price]=price_… --metadata[workspace_id]=<WS> --metadata[plan_tier]=starter`).
   Stripe sends `customer.subscription.created` to the test endpoint.
2. Verify exactly one recorded event and the entitlement:
   ```sql
   select stripe_event_id, event_type, processing_status, error
     from public.stripe_webhook_events
    where event_type = 'customer.subscription.created' order by received_at desc limit 5;
   select plan, subscription_status, page_limit_base from public.workspaces where id = '<WS>';
   -- expect: one row per event id, processing_status = processed, error null;
   --         plan = starter, subscription_status = active|trialing, page_limit_base = 100
   ```
3. Replay the identical event from the Stripe dashboard (Webhooks → the endpoint → the event →
   "Resend"). Expect HTTP 200 with `{"received":true,"duplicate":true}` in the delivery log and
   still exactly one row for that event id:
   ```sql
   select count(*) from public.stripe_webhook_events where stripe_event_id = '<EVENT_ID>';  -- 1
   ```
4. Negative: send any event with a wrong signature (curl with a bogus `stripe-signature`) →
   400 and no new row.
5. Negative: repeat step 1 with `workspace_id` set to a second throwaway workspace that is NOT
   in `STRIPE_TEST_WORKSPACE_IDS` (never a customer's id — the point is that nothing happens,
   and a mistake here must not be able to matter). Expect HTTP 200 with
   `{"received":true,"ignored":"workspace_not_allowlisted"}` in the delivery log, one event row
   marked as failed, and no change to that workspace:
   ```sql
   select stripe_event_id, processing_status, error from public.stripe_webhook_events
    where stripe_event_id = '<EVENT_ID>';
   -- expect: processing_status = error,
   --         error = 'test mode: workspace is not in STRIPE_TEST_WORKSPACE_IDS; no changes made'
   select plan, subscription_status, page_limit_base from public.workspaces where id = '<OTHER_WS>';
   -- expect: unchanged
   ```
   Cancel that subscription afterwards; its `customer.subscription.deleted` is refused the
   same way.
6. Clean up: cancel the test subscription (sends `customer.subscription.deleted`; `<WS>` has no
   published pages, so nothing flips to `billing_suspended`), delete the test customer, and
   remove `<WS>` from `STRIPE_TEST_WORKSPACE_IDS` (leave the secret empty).

## Checkout in test mode (`create-checkout-test`)

`create-checkout` is deployed the same way: `create-checkout` (live, `STRIPE_SECRET_KEY`)
and `create-checkout-test` (`STRIPE_SECRET_KEY_TEST`), picked by the function-name segment
of the path (`checkoutModeFor`), `verify_jwt=true` for both. The test deployment writes
`stripe_customers` like the live one, and a test customer id in a real workspace's row would
break that workspace's live billing, so it serves only workspaces in
`STRIPE_TEST_WORKSPACE_IDS` and answers every other one `403 test_mode_workspace_refused`
before any read, write or Stripe call. The live deployment never reads the allowlist
(`tests/checkout-test-mode.test.ts`). The app's Billing page always calls the live function;
the proof calls `create-checkout-test` directly with the test account's session token and the
same body the page sends (`{"workspace_id": "<WS>", "mode": "subscription", "tier": "starter"}`).
The Billing Portal (`customer-portal`) has no test deployment: cancellation in the proof is
made through the Stripe test API, which sends the same events a portal cancellation sends.

## Full lifecycle with public serving (MVP acceptance)

The acceptance check is about what the public sees, not only the database labels. It needs
one published page in the allowlisted workspace, on an active domain of its own
(a dedicated test hostname, e.g. `billing-proof.<your domain>`, added in Settings → Domains
and removed afterwards). Run it with a Stripe **test clock** so the paid period can end:

1. Fixture: in Stripe test mode create a test clock and a customer on it (`cus_…`, created with
   `test_clock`). Point the throwaway workspace — and only it — at that customer, so
   `create-checkout-test` reuses it. The allowlist cannot fence a manual write, so the SQL
   guards itself:
   ```sql
   -- <WS> must be the throwaway workspace and the ONLY id in STRIPE_TEST_WORKSPACE_IDS.
   select id, name from public.workspaces where id = '<WS>';            -- exactly 1 row
   insert into public.stripe_customers (workspace_id, stripe_customer_id, email)
   select id, '<cus_test_clock_customer>', '<test account email>'
     from public.workspaces where id = '<WS>'
   on conflict (workspace_id) do update set stripe_customer_id = excluded.stripe_customer_id
   returning workspace_id;                                             -- exactly 1 row: <WS>
   ```
   During the proof, never open the app's Billing page for `<WS>`: the live `create-checkout`
   would find the test customer missing in live mode, create a LIVE customer and overwrite
   this row (and open a live checkout page).
2. Checkout: call `create-checkout-test`; open the returned URL and pay with Stripe's test card
   `4242 4242 4242 4242` (any future expiry, any CVC). No real card is ever used.
3. Delivery: `checkout.session.completed`, `customer.subscription.created`, `invoice.paid`
   each recorded once in `stripe_webhook_events` (`processing_status = processed`).
   Replay one (Dashboard → Resend): `{"received":true,"duplicate":true}`, still one row.
4. Paid access: `workspaces.plan = starter`, `subscription_status = active`; publish one page;
   `https://<test host>/a/<slug>` answers 200 and `https://<test host>/a/sitemap.xml` lists it.
5. Cancellation: set `cancel_at_period_end`; the page keeps serving until the period ends.
6. Paid-period expiration: advance the test clock past `current_period_end`; Stripe sends
   `customer.subscription.deleted`. Expect `subscription_status = canceled`, the page withheld
   (`/a/<slug>` → 404) and gone from `/a/sitemap.xml` (allow the 60 s page / 300 s sitemap
   cache).
7. Reactivation: a new `create-checkout-test` session paid with the test card. Expect
   `subscription_status = active`, the page restored within plan capacity, `/a/<slug>` 200 and
   back in `/a/sitemap.xml`.
8. Clean up: cancel the subscription, delete the test clock (removes its customers),
   unpublish the page, remove the test hostname in Settings → Domains and its DNS records,
   remove the fixture row (`delete from public.stripe_customers where workspace_id = '<WS>'
   returning workspace_id;` → exactly 1 row), empty `STRIPE_TEST_WORKSPACE_IDS`, and delete the
   `create-checkout-test` and `stripe-webhook-test` deployments.

Before entering card details, confirm the page is a test-mode session (URL contains
`cs_test_`, and Stripe shows the TEST MODE badge).

## What the test deployment refuses
The test deployment shares the database and the service role with the live one, and every
handler takes its workspace id from Stripe metadata — which anyone with test-dashboard access,
or a leaked test key, can write. So it acts only for workspaces listed in the
`STRIPE_TEST_WORKSPACE_IDS` function secret. The allowlist is configuration, not a database
flag: nothing written to the shared database can widen it. (It replaced
`workspaces.is_internal`, which the test deployment no longer reads.)

- A workspace id that is not listed (or any id at all while the secret is unset or empty):
  HTTP 200 `{"received":true,"ignored":"workspace_not_allowlisted"}`, the event recorded in
  `stripe_webhook_events` with `processing_status = error` and
  `error = 'test mode: workspace is not in STRIPE_TEST_WORKSPACE_IDS; no changes made'`.
- An event that resolves to no workspace at all where live mode would still write — a
  `charge.refunded` or `charge.dispute.created` that cannot be attributed (live mode records an
  unattributed audit row for a human), a `customer.subscription.deleted` without
  `workspace_id` metadata (live mode still marks the subscription row canceled by its id):
  HTTP 200 `{"received":true,"ignored":"workspace_unresolved"}`, the event row marked
  `processing_status = error`, `error = 'test mode: the event resolves to no workspace; no changes made'`.

Either way Stripe must not retry an event that can never succeed, and nothing else is written:
no plan, capacity, page status, subscription row, audit row or credit grant. The check runs
after signature verification and the `livemode` guard, and before the first write of every
handler. The live deployment never reads the allowlist and is unchanged.

To list refusals:
```sql
select stripe_event_id, event_type, error, received_at from public.stripe_webhook_events
 where error like 'test mode:%' order by received_at desc;
```

## Why not point test keys at the live function
The live deployment must keep exactly one signing secret. A shared function reading both would
make a test-mode key a way into live processing. The `livemode` guard in the handler enforces
the split even if an endpoint is misconfigured, the mode is read from the function name so no
request path can change it, and the workspace allowlist (`STRIPE_TEST_WORKSPACE_IDS`) keeps the
test deployment from touching any customer even with valid test-mode signatures.

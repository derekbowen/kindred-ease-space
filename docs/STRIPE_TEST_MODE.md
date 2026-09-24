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
3. Stripe Dashboard (test mode) → Developers → Webhooks → Add endpoint:
   `https://xbxhzinnfhosoztqaaao.supabase.co/functions/v1/stripe-webhook-test`
   Events: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`.
   Copy its signing secret into `STRIPE_WEBHOOK_SECRET_TEST`.
4. An internal workspace `<WS>`. The test deployment writes for a workspace only when
   `public.workspaces.is_internal = true` for it (an internal/test tenant, never a customer).
   An operator sets the flag in SQL:
   ```sql
   UPDATE public.workspaces SET is_internal = true WHERE id = '<WS>';
   ```

## The proof
Use the internal workspace id `<WS>` from input 4.

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
5. Negative: repeat step 1 with `workspace_id` set to any workspace that is NOT internal.
   Expect HTTP 200 with `{"received":true,"ignored":"workspace_not_internal"}` in the delivery
   log, one event row marked as failed, and no change to that workspace:
   ```sql
   select stripe_event_id, processing_status, error from public.stripe_webhook_events
    where stripe_event_id = '<EVENT_ID>';
   -- expect: processing_status = error,
   --         error = 'test mode: workspace is not internal; no changes made'
   select plan, subscription_status, page_limit_base from public.workspaces where id = '<OTHER_WS>';
   -- expect: unchanged
   ```
   Cancel that subscription afterwards; its `customer.subscription.deleted` is refused the
   same way.
6. Clean up: cancel the test subscription (sends `customer.subscription.deleted`; expect the
   workspace's published pages to flip to `billing_suspended`), then delete the test customer.

## What the test deployment refuses
The test deployment shares the database and the service role with the live one, and every
handler takes its workspace id from Stripe metadata — which anyone with test-dashboard access,
or a leaked test key, can write. So it acts only for workspaces flagged `is_internal = true`.
For any other workspace id it answers HTTP 200 `{"received":true,"ignored":"workspace_not_internal"}`
(Stripe must not retry an event that can never succeed), records the event in
`stripe_webhook_events` with `processing_status = error` and
`error = 'test mode: workspace is not internal; no changes made'`, and writes nothing else:
no plan, capacity, page status, subscription row, audit row or credit grant. The check runs
after signature verification and the `livemode` guard, and before the first write of every
handler. The live deployment never reads the flag.

To list refusals:
```sql
select stripe_event_id, event_type, received_at from public.stripe_webhook_events
 where error = 'test mode: workspace is not internal; no changes made' order by received_at desc;
```

## Why not point test keys at the live function
The live deployment must keep exactly one signing secret. A shared function reading both would
make a test-mode key a way into live processing. The `livemode` guard in the handler enforces
the split even if an endpoint is misconfigured, the mode is read from the function name so no
request path can change it, and the internal-workspace guard keeps the test deployment from
touching any customer even with valid test-mode signatures.

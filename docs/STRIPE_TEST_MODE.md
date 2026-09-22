# Proving the Stripe webhook in test mode against a deployed endpoint

The webhook source serves two deployments (see `supabase/functions/stripe-webhook/index.ts`,
`stripeEnvFor`): `stripe-webhook` (live) and `stripe-webhook-test` (test mode). Each ignores
the other mode's events. This is the procedure that produces the evidence the release
requires: one signed test-mode event reaches the deployed test endpoint, is recorded exactly
once, updates entitlement, and an identical replay is ignored.

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

## The proof
Use an isolated test workspace id `<WS>` (a beta/test tenant, never a customer).

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
5. Clean up: cancel the test subscription (sends `customer.subscription.deleted`; expect the
   workspace's published pages to flip to `billing_suspended`), then delete the test customer.

## Why not point test keys at the live function
The live deployment must keep exactly one signing secret. A shared function reading both would
make a test-mode key a way into live processing. The `livemode` guard in the handler enforces
the split even if an endpoint is misconfigured.

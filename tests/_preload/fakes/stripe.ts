/**
 * Stripe SDK stand-in for offline edge-function tests. Signature verification
 * is the REAL implementation from the stripe npm package (that is the thing
 * under test); every API call that would hit api.stripe.com is a stub the test
 * programs through globalThis.__stripeStubs.
 */
import RealStripe from "stripe";

type Stubs = Record<string, (...args: unknown[]) => unknown>;
const g = globalThis as unknown as { __stripeStubs: Stubs; __stripeCalls: string[] };
g.__stripeStubs ??= {};
g.__stripeCalls ??= [];

function stub(name: string) {
  return async (...args: unknown[]) => {
    g.__stripeCalls.push(name);
    const fn = g.__stripeStubs[name];
    if (!fn) throw new Error(`stripe stub not programmed: ${name}`);
    return fn(...args);
  };
}

class Stripe extends RealStripe {
  constructor(key: string, opts?: RealStripe.StripeConfig) {
    super(key, opts);
    // Everything network-bound is replaced; webhooks.constructEventAsync is
    // inherited untouched from the real SDK.
    (this as unknown as { subscriptions: unknown }).subscriptions = {
      retrieve: stub("subscriptions.retrieve"),
    };
    (this as unknown as { invoices: unknown }).invoices = { retrieve: stub("invoices.retrieve") };
    (this as unknown as { charges: unknown }).charges = { retrieve: stub("charges.retrieve") };
    (this as unknown as { prices: unknown }).prices = { retrieve: stub("prices.retrieve") };
    (this as unknown as { checkout: unknown }).checkout = {
      sessions: { listLineItems: stub("checkout.sessions.listLineItems") },
    };
  }
}
export default Stripe;

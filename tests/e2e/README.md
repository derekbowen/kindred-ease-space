# E2E Smoke

End-to-end smoke that walks the critical onboarding path and verifies billing.

```
landing /  →  /signup (form submit)  →  /app (dashboard provisioned)  →  /app/billing
```

## Run

```bash
# Against local dev (default http://localhost:8080)
python3 tests/e2e/smoke.py

# Against a deployed env
python3 tests/e2e/smoke.py https://kindred-ease-space.lovable.app
```

Screenshots land in `/tmp/browser/smoke/`. Exit code 0 on success.

## Email confirmation

If Supabase email confirmation is enabled, the signup branch stops at the
"check your email" screen and the test exits OK without exercising
dashboard/billing. To cover the full path, set a pre-confirmed account:

```bash
export SUPABASE_TEST_EMAIL=smoke-tester@yourdomain.com
export SUPABASE_TEST_PASSWORD='...'
python3 tests/e2e/smoke.py
```

The test then signs in via `/login` and continues to `/app` and `/app/billing`.

## What it asserts

- Landing renders the founders.click brand.
- `/signup` shows the form and accepts a submit.
- Post-signup lands on `/app` (or shows the confirmation screen).
- Dashboard renders "Welcome back" within 20s (workspace auto-provision).
- `/app/billing` renders without 404 or root error boundary.
- Console errors are surfaced (non-fatal; reported as warnings).

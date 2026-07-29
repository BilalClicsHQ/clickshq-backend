// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight check for the Polar billing setup. Polar computes all money, so the
// only things that can be wrong are credentials and product configuration — this
// verifies both against the LIVE Polar API before a deploy.
//
//   npx tsx --env-file=.env scripts/verify-polar-setup.ts              # POLAR_SERVER
//   npx tsx --env-file=.env scripts/verify-polar-setup.ts --production # force prod
//   npx tsx --env-file=.env scripts/verify-polar-setup.ts --sandbox    # force sandbox
//
// READ-ONLY AND FREE. It only performs GETs (read a product, list one product to
// test the token) and inspects env — it never creates a checkout, subscription or
// order, and never charges anyone. Checking production therefore costs nothing;
// use --production so you don't have to edit .env and risk leaving the app
// pointed at the live environment.
//
// Exits non-zero if anything would break billing in the environment checked.
// ─────────────────────────────────────────────────────────────────────────────
const forced = process.argv.includes("--production") ? "production"
  : process.argv.includes("--sandbox") ? "sandbox"
  : null;
const SERVER = forced ?? (process.env.POLAR_SERVER === "production" ? "production" : "sandbox");
const SANDBOX = SERVER === "sandbox";
const API = SANDBOX ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";

// Same env-resolution rules as server/services/polarService.ts.
const token = SANDBOX
  ? process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN
  : process.env.POLAR_ACCESS_TOKEN;
const webhookSecret = SANDBOX
  ? process.env.POLAR_SANDBOX_WEBHOOK_SECRET || process.env.POLAR_WEBHOOK_SECRET
  : process.env.POLAR_WEBHOOK_SECRET;
const products = {
  monthly: (SANDBOX ? process.env.POLAR_SANDBOX_PRODUCT_TEAMS_MONTHLY : "") || process.env.POLAR_PRODUCT_TEAMS_MONTHLY,
  yearly: (SANDBOX ? process.env.POLAR_SANDBOX_PRODUCT_TEAMS_YEARLY : "") || process.env.POLAR_PRODUCT_TEAMS_YEARLY,
};

// Must match the per-seat prices the pricing UI advertises
// (clickshq-frontend/src/components/ui/BillingSubscription.tsx).
const EXPECTED_CENTS = { monthly: 1200, yearly: 10000 };

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`✗ ${msg}`); };
const pass = (msg: string) => console.log(`✓ ${msg}`);

console.log(`\nPolar setup check — POLAR_SERVER=${SERVER} (${API})\n${"─".repeat(64)}`);

// ── Credentials ───────────────────────────────────────────────────────────────
if (!token) {
  fail(`no access token (set ${SANDBOX ? "POLAR_SANDBOX_ACCESS_TOKEN" : "POLAR_ACCESS_TOKEN"})`);
} else {
  const res = await fetch(`${API}/v1/products/?limit=1`, { headers: { Authorization: `Bearer ${token.trim()}` } });
  if (res.ok) {
    pass("access token accepted by Polar");
  } else {
    const body = await res.text();
    fail(`access token rejected — HTTP ${res.status} ${body.slice(0, 140)}`);
    console.log(`\n  Fix: create a new Organization Access Token at ` +
      `${SANDBOX ? "https://sandbox.polar.sh" : "https://polar.sh"} → Settings → Developers,\n` +
      `  then set ${SANDBOX ? "POLAR_SANDBOX_ACCESS_TOKEN" : "POLAR_ACCESS_TOKEN"} in .env.`);
  }
}

if (!webhookSecret) {
  fail(`no webhook secret (set ${SANDBOX ? "POLAR_SANDBOX_WEBHOOK_SECRET" : "POLAR_WEBHOOK_SECRET"}) — ` +
    `subscription state will never sync; every delivery is rejected with 503`);
} else {
  pass("webhook signing secret present");
}

// ── Products ──────────────────────────────────────────────────────────────────
// Seat changes can only prorate on a RECURRING product with a deterministic price:
// `seat_based` (per-seat tiers — what the Teams plans use) or `fixed`. A
// pay-what-you-want (`custom`) price has no per-seat amount to prorate against, so
// seat and plan changes would silently produce wrong amounts. This is the check
// that matters most.
for (const [interval, id] of Object.entries(products) as ["monthly" | "yearly", string | undefined][]) {
  const varName = SANDBOX ? `POLAR_SANDBOX_PRODUCT_TEAMS_${interval.toUpperCase()}` : `POLAR_PRODUCT_TEAMS_${interval.toUpperCase()}`;
  if (!id) { fail(`${interval}: not configured (${varName})`); continue; }
  if (!token) continue;

  const res = await fetch(`${API}/v1/products/${id}`, { headers: { Authorization: `Bearer ${token.trim()}` } });
  if (!res.ok) { fail(`${interval}: product ${id} unreadable — HTTP ${res.status}`); continue; }

  const p: any = await res.json();
  const wantInterval = interval === "monthly" ? "month" : "year";
  const prices: any[] = (p.prices ?? []).filter((pr: any) => !pr.is_archived);
  const priceKinds = prices.map((pr) => pr.amount_type);
  // seat_based exposes price_per_seat; fixed exposes price_amount. Either prorates.
  const priced = prices.find((pr) => pr.amount_type === "seat_based" || pr.amount_type === "fixed");
  const perSeat = priced?.price_per_seat ?? priced?.price_amount ?? null;

  if (p.is_archived) fail(`${interval}: product "${p.name}" is ARCHIVED`);
  if (!p.is_recurring) fail(`${interval}: "${p.name}" is one-time, not a subscription product`);
  else if (p.recurring_interval !== wantInterval) {
    fail(`${interval}: "${p.name}" renews per ${p.recurring_interval}, expected ${wantInterval}`);
  }

  if (!priced || perSeat == null) {
    fail(`${interval}: "${p.name}" has no seat_based or fixed price (found: ${priceKinds.join(", ") || "none"}). ` +
      `A pay-what-you-want price cannot prorate seat or plan changes.`);
  } else {
    const want = EXPECTED_CENTS[interval];
    if (perSeat !== want) {
      fail(`${interval}: "${p.name}" costs $${(perSeat / 100).toFixed(2)} ${priced.price_currency ?? ""} per seat, ` +
        `but the pricing page advertises $${(want / 100).toFixed(0)} — customers would be charged a different amount than shown`);
    } else {
      pass(`${interval}: "${p.name}" — recurring/${p.recurring_interval}, ${priced.amount_type} $${(perSeat / 100).toFixed(2)}/seat`);
    }
    // Volume tiers beyond the first would make the advertised flat per-seat price wrong.
    const tiers = priced.seat_tiers?.tiers ?? [];
    if (tiers.length > 1) {
      fail(`${interval}: "${p.name}" has ${tiers.length} volume tiers, but the pricing page shows one flat per-seat price`);
    }
  }
}

// ── Organization readiness ────────────────────────────────────────────────────
// Polar only releases real payments once the org has submitted its details and
// has a payout account. An org still in "created" cannot take money, so checkout
// would fail for real customers no matter how correct the code is.
if (token) {
  const res = await fetch(`${API}/v1/organizations/?limit=1`, { headers: { Authorization: `Bearer ${token.trim()}` } });
  const org: any = res.ok ? (await res.json()).items?.[0] : null;
  if (!org) fail("could not read the organization");
  else {
    console.log(`  organization: ${org.name} (${org.slug})`);
    if (!org.feature_settings?.seat_based_pricing_enabled) {
      fail("seat-based pricing is NOT enabled on this organization — seat products cannot be sold");
    } else pass("seat-based pricing enabled");

    if (SERVER === "production") {
      if (!org.details_submitted_at) fail(`organization status is "${org.status}" with no details submitted — Polar will not accept real payments until onboarding is completed`);
      else if (!org.payout_account_id) fail("organization has no payout account — revenue cannot be paid out");
      else pass(`organization onboarded (status ${org.status})`);
    }
  }
}

// ── Webhook endpoint registration ─────────────────────────────────────────────
// A wrong path here fails silently: Polar keeps delivering, our server 404s, and
// subscription state never syncs.
if (token) {
  const res = await fetch(`${API}/v1/webhooks/endpoints/?limit=20`, { headers: { Authorization: `Bearer ${token.trim()}` } });
  const endpoints: any[] = res.ok ? (await res.json()).items ?? [] : [];
  if (!endpoints.length) {
    fail("no webhook endpoint registered — subscription changes will never reach this app");
  } else {
    for (const e of endpoints) {
      const url: string = e.url ?? "";
      const decoded = decodeURIComponent(url);
      if (!decoded.endsWith("/api/webhooks/polar")) {
        fail(`webhook URL does not end in /api/webhooks/polar — every delivery will 404:\n      ${url}` +
          (decoded !== url ? `\n      decodes to: ${decoded}` : ""));
      } else if (SERVER === "production" && /trycloudflare\.com|ngrok|localhost|\.local\b/.test(url)) {
        fail(`webhook points at a temporary tunnel, not a stable production host:\n      ${url}`);
      } else {
        pass(`webhook endpoint: ${url} (${(e.events ?? []).length} events)`);
      }
    }
  }
}

// ── Deploy-time env sanity ────────────────────────────────────────────────────
const returnUrl = process.env.BILLING_RETURN_URL ?? "";
if (!returnUrl) fail("BILLING_RETURN_URL not set — customers return to http://localhost:5173/billing after paying");
else if (SERVER === "production" && /localhost|127\.0\.0\.1/.test(returnUrl)) {
  fail(`BILLING_RETURN_URL points at localhost (${returnUrl}) while POLAR_SERVER=production`);
} else pass(`return URL: ${returnUrl}`);

// Left over from the retired Clics billing engine — Polar owns renewals now, so
// these no longer do anything and should be deleted from .env to avoid confusion.
const dead = ["BILLING_OFF_SESSION", "BILLING_CRON_SECRET", "POLAR_CHARGE_PRODUCT_ID", "POLAR_SANDBOX_CHARGE_PRODUCT_ID"]
  .filter((k) => process.env[k]);
if (dead.length) console.log(`\nnote: unused since the billing engine was retired — safe to delete: ${dead.join(", ")}`);

console.log("─".repeat(64));
console.log(failures === 0 ? "READY — Polar billing is correctly configured\n" : `NOT READY — ${failures} problem(s) above\n`);
process.exit(failures === 0 ? 0 : 1);

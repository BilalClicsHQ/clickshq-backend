// ─────────────────────────────────────────────────────────────────────────────
// Self-test for the half of the Polar integration WE own — the parts that stay
// our responsibility once Polar computes every amount:
//
//   A. webhook signature verification (the only trust boundary Polar crosses)
//   B. Polar product id -> plan mapping, which must fail CLOSED
//   C. subscription status -> feature entitlement gating
//   D. the mounted route surface (no retired billing-engine endpoints survive)
//
// Runs entirely offline: no Polar API calls, no database writes, no server boot.
// Uses the REAL webhook secret and product ids from .env, so it fails if those
// are misconfigured.
//
//   npx tsx --env-file=.env scripts/billing-selftest.ts
// ─────────────────────────────────────────────────────────────────────────────
import { Webhook } from "standardwebhooks";
import { validateEvent, WebhookVerificationError } from "@polar-sh/sdk/webhooks";
import { buildEntitlements, planIncludesFeature } from "../shared/entitlements";

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => { failures++; console.log(`  ✗ ${m}`); };
const check = (cond: boolean, m: string) => (cond ? pass(m) : fail(m));

// ── A. Webhook signature verification ─────────────────────────────────────────
// Polar signs with standard-webhooks; @polar-sh/sdk base64-encodes the raw secret
// before verifying. A correct signature that then fails SCHEMA parsing proves the
// signature step passed — that separation is what each case below asserts.
console.log("\nA. Webhook signature verification");
{
  const secret = process.env.POLAR_SANDBOX_WEBHOOK_SECRET || process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    fail("no webhook secret configured — cannot verify the trust boundary");
  } else {
    const signer = new Webhook(Buffer.from(secret, "utf-8").toString("base64"));
    const body = JSON.stringify({ type: "subscription.created", data: { id: "sub_test" } });
    const msgId = "msg_selftest";
    const now = new Date();
    const sign = (b: string, id = msgId, at = now) => ({
      "webhook-id": id,
      "webhook-timestamp": Math.floor(at.getTime() / 1000).toString(),
      "webhook-signature": signer.sign(id, at, b),
    });

    // 1. Correctly signed → must get PAST signature checking.
    try {
      validateEvent(body, sign(body) as any, secret);
      pass("valid signature accepted");
    } catch (err) {
      check(
        !(err instanceof WebhookVerificationError),
        err instanceof WebhookVerificationError
          ? "valid signature was REJECTED — real Polar deliveries would 403"
          : "valid signature accepted (payload then failed schema parse, as expected for a stub)",
      );
    }

    // 2. Body tampered after signing → must be rejected.
    try {
      const headers = sign(body);
      validateEvent(JSON.stringify({ type: "subscription.created", data: { id: "sub_EVIL" } }), headers as any, secret);
      fail("TAMPERED body was accepted — forged webhooks could rewrite subscriptions");
    } catch (err) {
      check(err instanceof WebhookVerificationError, "tampered body rejected");
    }

    // 3. Signed with a different secret → must be rejected.
    try {
      const other = new Webhook(Buffer.from("wrong_secret_value", "utf-8").toString("base64"));
      validateEvent(body, {
        "webhook-id": msgId,
        "webhook-timestamp": Math.floor(now.getTime() / 1000).toString(),
        "webhook-signature": other.sign(msgId, now, body),
      } as any, secret);
      fail("signature from a FOREIGN secret was accepted");
    } catch (err) {
      check(err instanceof WebhookVerificationError, "foreign-secret signature rejected");
    }

    // 4. Replay of an old delivery → standard-webhooks enforces a timestamp window.
    try {
      const old = new Date(Date.now() - 60 * 60 * 1000); // 1 hour old
      validateEvent(body, sign(body, msgId, old) as any, secret);
      fail("1-hour-old delivery was accepted — replay window not enforced");
    } catch (err) {
      check(err instanceof WebhookVerificationError, "stale (replayed) delivery rejected");
    }

    // 5. No signature headers at all.
    try {
      validateEvent(body, {} as any, secret);
      fail("unsigned delivery was accepted");
    } catch (err) {
      check(err instanceof WebhookVerificationError, "unsigned delivery rejected");
    }
  }
}

// ── B. Product -> plan mapping (must fail closed) ─────────────────────────────
// An active subscription on an UNRECOGNISED product must resolve to free, never
// to a paid tier — otherwise env drift or a new add-on product grants premium.
console.log("\nB. Polar product id -> plan (fail-closed)");
{
  const { planForProductId } = await import("../server/services/entitlementService");
  const sandbox = process.env.POLAR_SERVER !== "production";
  const monthly = (sandbox ? process.env.POLAR_SANDBOX_PRODUCT_TEAMS_MONTHLY : "") || process.env.POLAR_PRODUCT_TEAMS_MONTHLY;
  const yearly = (sandbox ? process.env.POLAR_SANDBOX_PRODUCT_TEAMS_YEARLY : "") || process.env.POLAR_PRODUCT_TEAMS_YEARLY;

  check(!!monthly && planForProductId(monthly) === "teams", `configured monthly product -> teams`);
  check(!!yearly && planForProductId(yearly) === "teams", `configured yearly product -> teams`);
  check(planForProductId("prod_completely_unknown") === "free", "unknown product -> free (fail closed)");
  check(planForProductId(null) === "free", "null product -> free");
  check(planForProductId("") === "free", "empty product -> free");
}

// ── C. Status -> entitlement gating ───────────────────────────────────────────
// Polar owns dunning: a past_due subscription must KEEP access while Polar retries,
// and only lose it when Polar revokes (status canceled/revoked).
console.log("\nC. Subscription status -> feature access");
{
  const ent = (plan: "free" | "teams", status: string) =>
    buildEntitlements({ plan, status, currentPeriodEnd: null, cancelAtPeriodEnd: false, source: "subscription" });

  check(ent("teams", "active").isActive, "active -> entitled");
  check(ent("teams", "past_due").isActive, "past_due -> STILL entitled (Polar is retrying; don't cut off mid-dunning)");
  check(ent("teams", "trialing").isActive, "trialing -> entitled");
  check(!ent("teams", "canceled").isActive, "canceled -> not entitled");
  check(!ent("teams", "revoked").isActive, "revoked -> not entitled");
  check(!ent("free", "none").isActive, "no subscription -> not entitled");

  check(planIncludesFeature("teams", "example_premium_feature"), "teams unlocks the gated feature");
  check(!planIncludesFeature("free", "example_premium_feature"), "free does NOT unlock the gated feature");
}

// ── D. Route surface ──────────────────────────────────────────────────────────
// The retired Clics engine must have no reachable endpoint left. Anything here
// would let a caller provision a subscription outside Polar.
console.log("\nD. Mounted /api/billing route surface");
{
  const router: any = (await import("../server/routes/billing.routes")).default;
  const mounted = new Set<string>();
  for (const layer of router.stack ?? []) {
    if (layer.route?.path) {
      for (const m of Object.keys(layer.route.methods ?? {})) mounted.add(`${m.toUpperCase()} ${layer.route.path}`);
    }
  }

  const retired = ["/workspace", "/subscribe", "/subscribe-checkout", "/confirm-checkout", "/preview", "/change", "/credit", "/invoices", "/cron/renew"];
  const leaked = retired.filter((p) => [...mounted].some((m) => m.endsWith(` ${p}`)));
  check(leaked.length === 0, leaked.length ? `engine endpoints STILL MOUNTED: ${leaked.join(", ")}` : "no retired billing-engine endpoints remain");

  for (const expected of ["GET /config", "GET /subscription", "POST /checkout", "POST /portal", "GET /seats", "PATCH /seats", "GET /orders", "POST /plan", "POST /cancel"]) {
    check(mounted.has(expected), `${expected} mounted`);
  }
  console.log(`  (${mounted.size} routes mounted in total)`);
}

console.log("\n" + "─".repeat(64));
console.log(failures === 0 ? "ALL PASS — our side of the Polar integration is sound\n" : `${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);

// Guards the fail-closed rule in the payment gateway: a simulated (no money moved)
// charge must NEVER report success in production. No test runner exists in this
// repo, so this is a standalone script: run with
//   npx tsx scripts/payment-gateway.test.ts
// DATABASE_URL is set below only because polarService -> server/db.ts requires it
// at import time; pg does not connect until a query runs, and none does here.
process.env.DATABASE_URL ||= "postgres://unused/unused";

const { chargeOffSession } = await import("../server/services/paymentGateway");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const charge = { externalCustomerId: "u1", currency: "usd", description: "test" };

// Force the "not fully configured" path (no charge product) for every case.
delete process.env.POLAR_CHARGE_PRODUCT_ID;
delete process.env.POLAR_SANDBOX_CHARGE_PRODUCT_ID;
process.env.POLAR_ACCESS_TOKEN = "polar_test";
process.env.BILLING_OFF_SESSION = "true";

// 1) Dev + sandbox → simulation is allowed (the Phase-1 affordance still works).
process.env.NODE_ENV = "development";
process.env.POLAR_SERVER = "sandbox";
{
  const r = await chargeOffSession({ ...charge, amountCents: 1200 });
  check("dev/sandbox simulates", r.ok && r.simulated && r.status === "simulated", r.status);
}

// 2) Production Polar org → must FAIL, not simulate (real cards live there).
process.env.POLAR_SERVER = "production";
{
  const r = await chargeOffSession({ ...charge, amountCents: 1200 });
  check("production Polar fails closed", !r.ok && !r.simulated && r.status === "not_configured", r.status);
}

// 3) NODE_ENV=production with POLAR_SERVER unset (defaults to sandbox) → also fails.
process.env.NODE_ENV = "production";
delete process.env.POLAR_SERVER;
{
  const r = await chargeOffSession({ ...charge, amountCents: 1200 });
  check("prod deploy w/o POLAR_SERVER fails closed", !r.ok && r.status === "not_configured", r.status);
}

// 4) $0 (credit covered the invoice) is still a no-op success, even in production.
{
  const r = await chargeOffSession({ ...charge, amountCents: 0 });
  check("zero-amount still succeeds", r.ok && r.status === "no_charge", r.status);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

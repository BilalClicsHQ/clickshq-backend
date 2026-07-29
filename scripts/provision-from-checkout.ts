// Recovery: provision the workspace subscription from an already-PAID Polar
// checkout that never got provisioned (e.g. webhook never arrived + no confirm).
// Picks the latest succeeded new_subscription checkout, or a checkout id if given.
// Run: npx tsx scripts/provision-from-checkout.ts [checkoutId]
import fs from "fs";
import path from "path";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const { Polar } = await import("@polar-sh/sdk");
const { finalizeNewSubscriptionFromCheckout } = await import("../server/services/billingEngineService");
const { billingStorage } = await import("../server/storage/billingStorage");
const { pool } = await import("../server/db");

const server = process.env.POLAR_SERVER === "production" ? "production" : "sandbox";
const accessToken =
  server === "sandbox" ? process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN : process.env.POLAR_ACCESS_TOKEN;
const polar = new Polar({ accessToken: accessToken!, server });

try {
  const arg = process.argv[2];
  let checkout: any = null;
  if (arg) {
    checkout = await polar.checkouts.get({ id: arg });
  } else {
    const res = await polar.checkouts.list({ limit: 20 });
    for await (const page of res) {
      const items: any[] = (page as any)?.result?.items ?? [];
      checkout = items.find((c) => c.status === "succeeded" && c.metadata?.kind === "new_subscription") ?? null;
      break;
    }
  }

  if (!checkout) {
    console.log("No succeeded new_subscription checkout found.");
    process.exit(1);
  }
  if (checkout.status !== "succeeded") {
    console.log(`Checkout ${checkout.id} is "${checkout.status}", not "succeeded" — refusing to provision.`);
    process.exit(1);
  }

  const meta = checkout.metadata ?? {};
  console.log(
    `Provisioning from checkout ${checkout.id}: company=${meta.companyId} plan=${meta.planKey} interval=${meta.interval} seats=${meta.seats} amount=${checkout.totalAmount ?? checkout.amount}`,
  );

  await finalizeNewSubscriptionFromCheckout({
    companyId: String(meta.companyId),
    planKey: String(meta.planKey),
    interval: meta.interval === "year" ? "year" : "month",
    seats: Number(meta.seats) || 1,
    polarCustomerId: checkout.customerId ?? null,
    polarOrderId: null,
    amountCents: checkout.totalAmount ?? checkout.amount ?? undefined,
  });

  const sub = await billingStorage.getActiveWorkspaceSubscription(String(meta.companyId));
  console.log("\nActive workspace subscription now:");
  console.log(sub ? { planKey: sub.planKey, seats: sub.seats, interval: sub.billingInterval, status: sub.status, periodEnd: sub.currentPeriodEnd } : "(none — provisioning failed)");
} catch (e: any) {
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
} finally {
  await pool.end();
}

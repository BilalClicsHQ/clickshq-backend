// End-to-end smoke test of the Clics billing engine against the real DB with the
// SIMULATED payment gateway. Uses a synthetic companyId and DELETES all of its
// rows at the end (finally), so it leaves no residue. Run from clickshq-backend:
//   npx tsx scripts/smoke-billing.ts
import fs from "fs";
import path from "path";

// Load .env into process.env BEFORE importing modules that read it at import time
// (server/db.ts throws if DATABASE_URL is unset).
for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const { startSubscription, preview, apply, getBillingState } = await import("../server/services/billingEngineService");
const { billingStorage } = await import("../server/storage/billingStorage");
const { db, pool } = await import("../server/db");
const { workspaceSubscriptions, billingCreditLedger, billingInvoices, accountCredit } = await import("../shared/schema");
const { eq } = await import("drizzle-orm");

const COMPANY = `__smoke_${Math.floor(Math.random() * 1e9)}`;
const USER = "__smoke_user";
const $ = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`;
let fails = 0;
const check = (label: string, got: number, want: number) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${$(got)} (want ${$(want)})`);
};

try {
  console.log("company:", COMPANY, "\n");

  // §1 New subscription: teams monthly, 10 seats → $120 charged (simulated).
  const sub = await startSubscription({ companyId: COMPANY, actingUserId: USER, planKey: "teams", interval: "month", seats: 10 });
  console.log("subscribe ok:", sub.ok);
  check("new subscription charge", sub.quote.netChargeCents, 12000);

  // §3 Remove 2 seats (10→8) at period start → ~full-period credit ≈ $24.
  const q = await preview(COMPANY, { kind: "seats", seats: 8 });
  console.log(`\npreview remove 2 seats → ${q.direction} ${$(q.grossCents)}`);
  check("remove-seat credit ≈ $24", q.grossCents, 2400);
  const r = await apply(COMPANY, USER, { kind: "seats", seats: 8 });
  console.log("apply remove ok:", r.ok, "→ credit balance", $(r.newCreditBalanceCents));
  check("credit balance after remove", r.newCreditBalanceCents, 2400);

  const st = await getBillingState(COMPANY);
  check("seats after remove (×100 for display)", (st.subscription?.seats ?? 0) * 100, 800);

  // §2 Add 2 seats back (8→10) → ~$24 charge, fully offset by the $24 credit → net $0.
  const r2 = await apply(COMPANY, USER, { kind: "seats", seats: 10 });
  console.log(`\napply add 2 seats → gross ${$(r2.quote.grossCents)}, credit applied ${$(r2.quote.creditAppliedCents)}, net charged ${$(r2.quote.netChargeCents)}`);
  check("add-seat net charge (covered by credit)", r2.quote.netChargeCents, 0);
  const st2 = await getBillingState(COMPANY);
  check("credit balance after add (consumed)", st2.creditBalanceCents, 0);
  check("seats after add (×100)", (st2.subscription?.seats ?? 0) * 100, 1000);

  // Audit trail
  const ledger = await billingStorage.getLedger(COMPANY, 20);
  const invoices = await billingStorage.getInvoices(COMPANY, 20);
  console.log(`\nledger entries: ${ledger.length}, invoices: ${invoices.length}`);
  console.table(ledger.map((l) => ({ dir: l.direction, amount: $(l.amount), balanceAfter: $(l.balanceAfter), reason: l.reason })));
  console.table(invoices.map((i) => ({ type: i.type, subtotal: $(i.subtotalCents), credit: $(i.creditAppliedCents), charged: $(i.totalChargedCents), status: i.status })));

  console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
} catch (e: any) {
  fails++;
  console.error("ERROR:", e?.message ?? e);
} finally {
  // Clean up — leave no test data behind.
  await db.delete(billingCreditLedger).where(eq(billingCreditLedger.companyId, COMPANY));
  await db.delete(billingInvoices).where(eq(billingInvoices.companyId, COMPANY));
  await db.delete(accountCredit).where(eq(accountCredit.companyId, COMPANY));
  await db.delete(workspaceSubscriptions).where(eq(workspaceSubscriptions.companyId, COMPANY));
  console.log("cleaned up test data for", COMPANY);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

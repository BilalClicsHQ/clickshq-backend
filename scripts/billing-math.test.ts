// Golden tests for the billing engine — asserts the exact numbers from the
// Clics Billing Logic Brief. No test runner exists in this repo, so this is a
// standalone script: run with `npx tsx scripts/billing-math.test.ts`.
import {
  seatAddCharge,
  seatRemoveCredit,
  planUpgradeCharge,
  planDowngradeCredit,
  monthlyToAnnualCharge,
  annualToMonthlyCredit,
  applyCredit,
  prorationFraction,
  monthsUsedCeil,
} from "../shared/billing-math";

let failures = 0;
function eq(label: string, got: number, want: number) {
  const ok = got === want;
  if (!ok) failures++;
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  console.log(`${ok ? "✓" : "✗"} ${label}: got ${money(got)} want ${money(want)}`);
}

// Brief worked examples (all in cents) ----------------------------------------
// §2 Add 2 seats @ $10, 20 of 30 days left → $13.33
eq("§2 add seats", seatAddCharge(1000, 2, 20 / 30), 1333);
// §3 Remove 2 seats @ $10, 27 of 30 days left → $18.00 credit
eq("§3 remove seats credit", seatRemoveCredit(1000, 2, 27 / 30), 1800);
// §4 Upgrade Pro→Business, 10 seats, ($20−$10), 15/30 → $50.00
eq("§4 plan upgrade", planUpgradeCharge(1000, 2000, 10, 15 / 30), 5000);
// §5 Downgrade Business→Pro, 10 seats, ($20−$10), 15/30 → $50.00 credit
eq("§5 plan downgrade credit", planDowngradeCredit(2000, 1000, 10, 15 / 30), 5000);
// §6 Monthly→Annual: annual $960, monthly total $100, 20/30 unused → $893.33
eq("§6 monthly→annual due", monthlyToAnnualCharge(96000, 10000, 20 / 30), 89333);
// §7 Annual→Monthly: paid $960, 2 months used @ $10×10 → $760.00 credit
eq("§7 annual→monthly credit", annualToMonthlyCredit(96000, 1000, 10, 2), 76000);

// §9 Apply credit: 8 seats @ $10 = $80 next invoice, $18 credit → charge $62
{
  const a = applyCredit(8000, 1800);
  eq("§9 credit applied (charged)", a.chargedCents, 6200);
  eq("§9 credit applied (used)", a.creditUsedCents, 1800);
  eq("§9 credit applied (remaining)", a.remainingCreditCents, 0);
}
// §7 follow-on: $760 credit vs $100/mo invoices → covered for 7 full months, 8th partial
{
  let credit = 76000;
  let covered = 0;
  while (credit >= 10000) {
    credit = applyCredit(10000, credit).remainingCreditCents;
    covered++;
  }
  console.log(`✓ §7 carry-over: $760 credit fully covers ${covered} monthly invoices, $${(credit / 100).toFixed(2)} left`);
  if (covered !== 7) {
    failures++;
    console.log(`✗ expected 7 fully-covered months, got ${covered}`);
  }
}

// Helper sanity ----------------------------------------------------------------
{
  const start = Date.UTC(2026, 5, 17);
  const end = Date.UTC(2026, 6, 17); // ~30 days
  const now = Date.UTC(2026, 5, 27); // 10 days in → ~2/3 remaining
  const f = prorationFraction(now, start, end);
  const ok = f > 0.6 && f < 0.7;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} prorationFraction ~0.667: got ${f.toFixed(4)}`);
  const used = monthsUsedCeil(Date.UTC(2026, 7, 14), Date.UTC(2026, 5, 17)); // ~58 days → 2 months
  eq("monthsUsedCeil ≈ 2 (as count×1)", used, 2);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

// Runs every Clics Billing Brief scenario through the REAL engine math, using our
// ACTUAL Teams pricing (perSeatPrice from billingEngineService), and prints it
// side-by-side with the brief's $10 examples. Run:
//   npx tsx scripts/verify-brief-our-pricing.ts
import fs from "fs";
import path from "path";
import {
  prorationFraction,
  monthsUsedCeil,
  seatAddCharge,
  seatRemoveCredit,
  monthlyToAnnualCharge,
  annualToMonthlyCredit,
  applyCredit,
  periodSubtotal,
} from "../shared/billing-math";

// Load .env before importing the engine (it transitively requires DATABASE_URL).
for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
const { perSeatPrice } = await import("../server/services/billingEngineService");

const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
const MO = perSeatPrice("teams", "month"); // our monthly per-seat (cents)
const YR = perSeatPrice("teams", "year"); // our yearly per-seat (cents)

// Brief's example dates: a 30-day cycle Jun 17 → Jul 17.
const Y = 2025;
const d = (m: number, day: number) => new Date(Date.UTC(Y, m, day)).getTime();
const START = d(5, 17); // Jun 17
const END = d(6, 17); // Jul 17

console.log(`Our Teams pricing:  monthly = ${$(MO)}/seat,  yearly = ${$(YR)}/seat\n`);

const rows: any[] = [];
const add = (section: string, scenario: string, brief: string, ours: number, expected: number) =>
  rows.push({
    section,
    scenario,
    "brief ($10)": brief,
    "ours (Teams)": $(ours),
    ok: ours === expected ? "✓" : `✗ want ${$(expected)}`,
  });

// §1 New subscription — 10 seats
add("§1", "New sub, 10 seats / month", "$100.00", periodSubtotal(MO, 10), 10 * MO);
add("§1", "New sub, 10 seats / year", "$960.00", periodSubtotal(YR, 10), 10 * YR);

// §2 Add seats 10→12 on Jun 27 (20/30 left)
const remAdd = prorationFraction(d(5, 27), START, END);
add("§2", "Add 2 seats (20/30 left) — CHARGE", "$13.33", seatAddCharge(MO, 2, remAdd), Math.round(MO * 2 * (20 / 30)));

// §3 Remove seats 10→8 on Jun 20 (27/30 left)
const remRem = prorationFraction(d(5, 20), START, END);
add("§3", "Remove 2 seats (27/30 left) — CREDIT", "$18.00", seatRemoveCredit(MO, 2, remRem), Math.round(MO * 2 * (27 / 30)));

// §4 / §5 Plan up/downgrade — N/A: Teams is the only self-serve paid plan.
rows.push({ section: "§4/§5", scenario: "Plan upgrade/downgrade", "brief ($10)": "$50.00", "ours (Teams)": "N/A", ok: "only Teams is self-serve paid" });

// §6 Monthly → Annual on Jun 27 (20/30 left), 10 seats
const remCyc = prorationFraction(d(5, 27), START, END);
const m2aAnnual = periodSubtotal(YR, 10);
const m2aMonthly = periodSubtotal(MO, 10);
add("§6", "Monthly→Annual, 10 seats — CHARGE", "$893.33", monthlyToAnnualCharge(m2aAnnual, m2aMonthly, remCyc), m2aAnnual - Math.round(m2aMonthly * (20 / 30)));

// §7 Annual → Monthly after ~2 months (Jun 17 → Aug 14), 10 seats
const usedMonths = monthsUsedCeil(d(7, 14), START);
const a2mCredit = annualToMonthlyCredit(periodSubtotal(YR, 10), MO, 10, usedMonths);
add("§7", `Annual→Monthly, used ${usedMonths}mo — CREDIT`, "$760.00", a2mCredit, periodSubtotal(YR, 10) - MO * 10 * usedMonths);

// §9 Apply credit: §3 credit ($21.60) vs next 8-seat monthly invoice
const credit = seatRemoveCredit(MO, 2, remRem);
const nextInvoice = periodSubtotal(MO, 8);
const applied = applyCredit(nextInvoice, credit);
add("§9", "Next 8-seat invoice − credit — CHARGED", "$62.00", applied.chargedCents, nextInvoice - credit);

console.table(rows);

// §7 carry-over: how many monthly invoices does the §7 credit cover?
let bal = a2mCredit;
const monthly = periodSubtotal(MO, 10);
let full = 0;
while (bal >= monthly) { bal -= monthly; full++; }
console.log(
  `\n§7 carry-over: ${$(a2mCredit)} credit covers ${full} full monthly invoices of ${$(monthly)}, ` +
    `then ${$(monthly - bal)} charged on invoice ${full + 1} (${$(bal)} credit left before it).`,
);

// §8 cancel — no money movement
console.log("§8 Cancel: no charge, no credit; plan stays active until period end (handled by apply({kind:'cancel'})).");

const fails = rows.filter((r) => typeof r.ok === "string" && r.ok.startsWith("✗"));
console.log(fails.length ? `\n${fails.length} MISMATCH(ES)` : "\nAll engine outputs match the expected values for our pricing.");

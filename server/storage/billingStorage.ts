// Data access for the Clics billing engine: workspace subscriptions, the
// account-credit ledger + balance cache, and our invoice records. Follows the
// modular server/storage/*.ts pattern (e.g. spaceStorage.ts).
import {
  workspaceSubscriptions,
  billingCreditLedger,
  billingInvoices,
  accountCredit,
  users,
  companies,
  type WorkspaceSubscription,
  type InsertWorkspaceSubscription,
  type BillingCreditLedgerEntry,
  type BillingInvoice,
  type InsertBillingInvoice,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, lte, count } from "drizzle-orm";

export type CreditReason =
  | "seat_removed"
  | "plan_downgrade"
  | "cycle_switch"
  | "credit_applied"
  | "adjustment";

const ACTIVE_STATUSES = ["active", "past_due", "incomplete"] as const;

export class BillingStorage {
  // ── Workspace subscription ──────────────────────────────────────────────────
  async getActiveWorkspaceSubscription(companyId: string): Promise<WorkspaceSubscription | undefined> {
    const rows = await db
      .select()
      .from(workspaceSubscriptions)
      .where(eq(workspaceSubscriptions.companyId, companyId))
      .orderBy(desc(workspaceSubscriptions.updatedAt))
      .limit(5);
    return rows.find((r) => (ACTIVE_STATUSES as readonly string[]).includes(r.status)) ?? undefined;
  }

  async getWorkspaceSubscriptionById(id: string): Promise<WorkspaceSubscription | undefined> {
    const [row] = await db.select().from(workspaceSubscriptions).where(eq(workspaceSubscriptions.id, id)).limit(1);
    return row;
  }

  async createWorkspaceSubscription(data: InsertWorkspaceSubscription): Promise<WorkspaceSubscription> {
    const [row] = await db.insert(workspaceSubscriptions).values(data).returning();
    return row;
  }

  async updateWorkspaceSubscription(
    id: string,
    updates: Partial<InsertWorkspaceSubscription>,
  ): Promise<WorkspaceSubscription | undefined> {
    const [row] = await db
      .update(workspaceSubscriptions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(workspaceSubscriptions.id, id))
      .returning();
    return row;
  }

  // Subscriptions whose period has ended and that are still billable — drives the
  // renewal cron. cancelAtPeriodEnd rows are returned too so the cron can finalize.
  async getDueSubscriptions(now: Date): Promise<WorkspaceSubscription[]> {
    return db
      .select()
      .from(workspaceSubscriptions)
      .where(
        and(eq(workspaceSubscriptions.status, "active"), lte(workspaceSubscriptions.currentPeriodEnd, now)),
      );
  }

  // Past-due subscriptions whose next dunning retry is due. (Rows with a null
  // nextRetryAt are excluded by the <= comparison.)
  async getRetryableSubscriptions(now: Date): Promise<WorkspaceSubscription[]> {
    return db
      .select()
      .from(workspaceSubscriptions)
      .where(
        and(eq(workspaceSubscriptions.status, "past_due"), lte(workspaceSubscriptions.nextRetryAt, now)),
      );
  }

  // Past-due subscriptions whose grace period has elapsed — these get downgraded.
  async getGraceExpiredSubscriptions(now: Date): Promise<WorkspaceSubscription[]> {
    return db
      .select()
      .from(workspaceSubscriptions)
      .where(
        and(eq(workspaceSubscriptions.status, "past_due"), lte(workspaceSubscriptions.gracePeriodEndsAt, now)),
      );
  }

  // ── Membership ───────────────────────────────────────────────────────────────
  async getCompanyMemberCount(companyId: string): Promise<number> {
    const [row] = await db.select({ n: count() }).from(users).where(eq(users.companyId, companyId));
    return Number(row?.n ?? 0);
  }

  // The owner is the billing principal (= Polar externalCustomerId) for charges.
  async getCompanyOwnerUserId(companyId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ ownerUserId: companies.ownerUserId })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    return row?.ownerUserId;
  }

  // Owner contact for dunning emails (id doubles as the Polar externalCustomerId).
  async getCompanyOwnerContact(
    companyId: string,
  ): Promise<{ userId: string; email: string; displayName: string } | undefined> {
    const [row] = await db
      .select({ userId: users.id, email: users.email, displayName: users.displayName })
      .from(companies)
      .innerJoin(users, eq(users.id, companies.ownerUserId))
      .where(eq(companies.id, companyId))
      .limit(1);
    return row;
  }

  // ── Account credit (ledger + balance cache) ───────────────────────────────────
  async getCreditBalance(companyId: string): Promise<number> {
    const [row] = await db.select().from(accountCredit).where(eq(accountCredit.companyId, companyId)).limit(1);
    return row?.balanceCents ?? 0;
  }

  // Grant credit (e.g. a downgrade). Returns the new balance. Atomic: balance
  // cache + ledger entry move together.
  async addCredit(
    companyId: string,
    amountCents: number,
    reason: CreditReason,
    description?: string,
    relatedInvoiceId?: string,
    currency = "usd",
  ): Promise<number> {
    if (amountCents <= 0) return this.getCreditBalance(companyId);
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(accountCredit)
        .where(eq(accountCredit.companyId, companyId))
        .limit(1);
      const newBalance = (existing?.balanceCents ?? 0) + amountCents;
      if (existing) {
        await tx
          .update(accountCredit)
          .set({ balanceCents: newBalance, updatedAt: new Date() })
          .where(eq(accountCredit.companyId, companyId));
      } else {
        await tx.insert(accountCredit).values({ companyId, balanceCents: newBalance, currency });
      }
      await tx.insert(billingCreditLedger).values({
        companyId,
        direction: "credit",
        amount: amountCents,
        balanceAfter: newBalance,
        reason,
        description,
        relatedInvoiceId,
      });
      return newBalance;
    });
  }

  // Consume up to `amountCents` of credit toward an invoice. Returns the amount
  // actually consumed (<= available balance). Atomic.
  async consumeCredit(
    companyId: string,
    amountCents: number,
    relatedInvoiceId?: string,
    description?: string,
  ): Promise<number> {
    if (amountCents <= 0) return 0;
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(accountCredit)
        .where(eq(accountCredit.companyId, companyId))
        .limit(1);
      const available = existing?.balanceCents ?? 0;
      const used = Math.min(available, amountCents);
      if (used <= 0) return 0;
      const newBalance = available - used;
      await tx
        .update(accountCredit)
        .set({ balanceCents: newBalance, updatedAt: new Date() })
        .where(eq(accountCredit.companyId, companyId));
      await tx.insert(billingCreditLedger).values({
        companyId,
        direction: "debit",
        amount: used,
        balanceAfter: newBalance,
        reason: "credit_applied",
        description,
        relatedInvoiceId,
      });
      return used;
    });
  }

  async getLedger(companyId: string, limit = 50): Promise<BillingCreditLedgerEntry[]> {
    return db
      .select()
      .from(billingCreditLedger)
      .where(eq(billingCreditLedger.companyId, companyId))
      .orderBy(desc(billingCreditLedger.createdAt))
      .limit(limit);
  }

  // ── Invoices ───────────────────────────────────────────────────────────────
  async createInvoice(data: InsertBillingInvoice): Promise<BillingInvoice> {
    const [row] = await db.insert(billingInvoices).values(data).returning();
    return row;
  }

  async updateInvoice(id: string, updates: Partial<InsertBillingInvoice>): Promise<BillingInvoice | undefined> {
    const [row] = await db.update(billingInvoices).set(updates).where(eq(billingInvoices.id, id)).returning();
    return row;
  }

  async getInvoiceByPeriodKey(periodKey: string): Promise<BillingInvoice | undefined> {
    const [row] = await db.select().from(billingInvoices).where(eq(billingInvoices.periodKey, periodKey)).limit(1);
    return row;
  }

  async getInvoices(companyId: string, limit = 50): Promise<BillingInvoice[]> {
    return db
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.companyId, companyId))
      .orderBy(desc(billingInvoices.createdAt))
      .limit(limit);
  }
}

export const billingStorage = new BillingStorage();

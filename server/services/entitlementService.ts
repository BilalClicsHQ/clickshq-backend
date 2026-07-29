// ─────────────────────────────────────────────────────────────────────────────
// Entitlement service — resolves a user's effective plan + feature access.
//
// This is the bridge between the raw billing layer (Polar `subscriptions` rows)
// and the logical feature catalog (@shared/entitlements). It answers the only
// question the rest of the app cares about: "what is this user allowed to do?"
//
// SCOPE / MULTI-TENANCY
//   clicksHQ is company-scoped: every user belongs to at most one company
//   (`users.companyId`) and a company has one owner (`companies.ownerUserId`).
//   Polar subscriptions, however, are written against the *purchasing user*
//   (`subscriptions.userId`). To give a "Teams" plan proper team semantics, we
//   resolve entitlements from the COMPANY OWNER's subscription so every member
//   inherits it — with a fallback to the user's OWN subscription (so a personal
//   subscriber is still entitled even if their company owner hasn't paid). The
//   highest-tier active subscription among those principals wins.
//
//   This is purely additive: it changes nothing about how checkout/webhooks work.
// ─────────────────────────────────────────────────────────────────────────────
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { companies, type Subscription } from "@shared/schema";
import {
  getActiveSubscriptionForUser,
  getBillingConfig,
  getActiveSeatSubscription,
  upsertSubscriptionFromPolar,
} from "./polarService";
import {
  buildEntitlements,
  DEFAULT_PLAN,
  FREE_ENTITLEMENTS,
  isActiveStatus,
  planTier,
  type Entitlements,
  type PlanKey,
} from "@shared/entitlements";

// ── Polar product id → plan key ───────────────────────────────────────────────
// Built from the live billing config (env-driven product ids). Add new plans
// here when you add them to @shared/entitlements + polarService.getBillingConfig.
function productPlanMap(): Record<string, PlanKey> {
  const map: Record<string, PlanKey> = {};
  const cfg = getBillingConfig();
  const teams = cfg.plans.teams;
  if (teams.monthly.productId) map[teams.monthly.productId] = "teams";
  if (teams.yearly.productId) map[teams.yearly.productId] = "teams";
  return map;
}

/**
 * Map a Polar product id to a logical plan.
 *
 * Fails CLOSED: an active subscription whose product id we don't recognize is
 * treated as the free plan, NOT as a paid tier. Deriving "paid" from an unmapped
 * id would be a privilege escalation — e.g. env drift (POLAR_PRODUCT_TEAMS_* unset
 * makes the map empty), add-on products, or a future tier could otherwise grant
 * full premium off a product the catalog has never heard of. The remedy is to
 * register the product → plan mapping below, not to guess.
 */
export function planForProductId(productId?: string | null): PlanKey {
  if (!productId) return DEFAULT_PLAN;
  const mapped = productPlanMap()[productId];
  if (mapped) return mapped;
  console.warn(`[entitlements] Unrecognized Polar product id "${productId}" — treating as free. Register it in productPlanMap().`);
  return DEFAULT_PLAN;
}

// ── Subscription → Entitlements ───────────────────────────────────────────────
function entitlementsFromSubscription(sub: Subscription | null): Entitlements {
  if (!sub) return FREE_ENTITLEMENTS;
  const plan = isActiveStatus(sub.status) ? planForProductId(sub.polarProductId) : DEFAULT_PLAN;
  return buildEntitlements({
    plan,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toISOString() : null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    source: "subscription",
  });
}

// ── Live-Polar fallback ───────────────────────────────────────────────────────
// The mirror (`subscriptions` table) is fed by the Polar webhook. When a webhook is
// delayed or missed (local dev with no public URL, or a dropped delivery), a paying
// user would read as free. So when the mirror knows nothing, reconcile straight from
// Polar's live seat subscription. Cached briefly to avoid a Polar call on every
// request, and self-heals the mirror on a hit so the fast path works next time.
// ponytail: 60s cache bounds the cost. If free-user traffic makes even this hot,
// cache the negative result longer or gate the fallback behind a cheaper hint.
const LIVE_TTL_MS = 60_000;
const liveSubCache = new Map<string, { at: number; sub: any }>();

async function liveSeatSub(userId: string): Promise<any | null> {
  const hit = liveSubCache.get(userId);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.sub;
  const sub = await getActiveSeatSubscription(userId).catch(() => null);
  liveSubCache.set(userId, { at: Date.now(), sub });
  if (sub) upsertSubscriptionFromPolar(sub).catch(() => {}); // self-heal the mirror
  return sub;
}

async function entitlementsFromLivePolar(userId?: string | null): Promise<Entitlements> {
  if (!userId) return FREE_ENTITLEMENTS;
  const sub = await liveSeatSub(userId);
  if (!sub) return FREE_ENTITLEMENTS;
  const productId = sub.productId ?? sub.product?.id ?? null;
  const plan = isActiveStatus(sub.status) ? planForProductId(productId) : DEFAULT_PLAN;
  return buildEntitlements({
    plan,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toISOString() : null,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    source: "subscription",
  });
}

// NOTE: membership is the single `users.companyId` column (no membership/seat
// table in this app), so a non-null companyId is taken as ground truth — exactly
// as the rest of the app does for tenant scoping. Offboarding flows must clear
// users.companyId; otherwise a stale value keeps a removed user entitled.
/** Resolve the company owner's user id for a member, if any. */
async function resolveCompanyOwnerId(companyId?: string | null): Promise<string | null> {
  if (!companyId) return null;
  const [company] = await db
    .select({ ownerUserId: companies.ownerUserId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return company?.ownerUserId ?? null;
}

/** Pick the highest-tier entitlement (free is tier 0, so paid always wins). */
function bestEntitlements(candidates: Entitlements[]): Entitlements {
  let best = FREE_ENTITLEMENTS;
  for (const e of candidates) {
    if (planTier(e.plan) > planTier(best.plan)) best = e;
  }
  return best;
}

/**
 * Resolve the effective entitlements for a user. `user` is the deserialized
 * `users` row (req.user). Returns FREE_ENTITLEMENTS for anonymous/unknown users.
 */
export async function getEntitlementsForUser(user: { id?: string; companyId?: string | null } | null | undefined): Promise<Entitlements> {
  if (!user?.id) return FREE_ENTITLEMENTS;

  const ownerId = await resolveCompanyOwnerId(user.companyId);
  // Team inheritance (company owner) + personal fallback (the user themselves).
  const principalIds = Array.from(new Set([ownerId, user.id].filter(Boolean))) as string[];

  // Fast path: the webhook-synced Polar mirror (owner's for team inheritance + own).
  const subs = await Promise.all(principalIds.map((id) => getActiveSubscriptionForUser(id)));
  let best = bestEntitlements(subs.map(entitlementsFromSubscription));

  // Fallback: the mirror knows nothing (webhook not delivered yet / missed) →
  // reconcile from live Polar so a paying user isn't stuck on free.
  if (planTier(best.plan) === 0) {
    const live = await Promise.all(principalIds.map((id) => entitlementsFromLivePolar(id)));
    best = bestEntitlements([best, ...live]);
  }
  return best;
}

/**
 * Load (and memoize on the request) the caller's entitlements. Use this inside
 * gating middleware so multiple gates on one request don't re-query the DB.
 */
export async function loadEntitlements(req: Request): Promise<Entitlements> {
  const r = req as any;
  if (r.entitlements) return r.entitlements as Entitlements;
  const entitlements = await getEntitlementsForUser(r.user);
  r.entitlements = entitlements;
  return entitlements;
}

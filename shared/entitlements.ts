// ─────────────────────────────────────────────────────────────────────────────
// Entitlements / feature-access catalog — the single source of truth for
// "which plan unlocks which feature" across clicksHQ.
//
// This module is INTENTIONALLY pure (no DB, no env, no Express) so the *exact*
// same file can live in both repos and be imported via the `@shared/*` alias on
// the backend (gating middleware) AND the frontend (gates / hooks / pricing UI).
// Keep `clickshq-backend/shared/entitlements.ts` and
// `clickshq-frontend/shared/entitlements.ts` byte-for-byte identical, exactly
// like `shared/schema.ts` and `shared/context-helpers.ts`.
//
// HOW THIS FITS THE EXISTING BILLING STACK
//   Payments already exist (Polar — see server/services/polarService.ts). Polar
//   writes raw rows into the `subscriptions` table. This catalog is the layer on
//   top that turns a raw subscription (a Polar product id + status) into a
//   logical PLAN, and a plan into a set of unlocked FEATURES + numeric LIMITS.
//   The backend resolves a user's Entitlements (server/services/entitlementService.ts)
//   and gates routes (server/middleware/requireEntitlement.ts); the frontend
//   reads the same Entitlements over /api/entitlements and gates UI.
//
// ── HOW TO ADD A NEW PREMIUM FEATURE ─────────────────────────────────────────
//   1. Add a key to the `FeatureKey` union below.
//   2. Register it in `FEATURES` with the minimum plan that unlocks it.
//   3. Gate it: backend `requireFeature("your_key")`, frontend
//      `<FeatureGate feature="your_key">…</FeatureGate>` or `useFeatureAccess`.
//   Nothing else changes — the plan→feature mapping is derived from tiers.
//
// ── HOW TO ADD A NEW PLAN ────────────────────────────────────────────────────
//   1. Add a key to `PlanKey`, an entry to `PLANS` (with a unique `tier`), and a
//      row to `PLAN_LIMITS`.
//   2. Map its Polar product id(s) to the plan key in entitlementService.ts
//      (`productPlanMap`) so paid checkouts resolve to it.
// ─────────────────────────────────────────────────────────────────────────────

// ── Plans ────────────────────────────────────────────────────────────────────

/** Logical plan identifiers. Extend this union to add tiers (e.g. "enterprise"). */
export type PlanKey = "free" | "teams";

/** Billing cadence. Matches Polar's `recurring_interval` values. */
export type BillingInterval = "month" | "year";

export interface PlanDefinition {
  key: PlanKey;
  name: string;
  description: string;
  /**
   * Ordering rank for "at least this plan" comparisons. Higher = more access.
   * Gaps are intentional so new tiers can slot in between without renumbering.
   */
  tier: number;
  /** Whether this plan requires an active paid subscription. `free` is false. */
  isPaid: boolean;
  /**
   * Display-only marketing price, in the smallest currency unit (e.g. cents).
   * The authoritative price lives in Polar — never charge off these numbers.
   */
  price: { month: number | null; year: number | null; currency: string };
  /** Short marketing bullet points for pricing UI (not used for gating). */
  highlights: string[];
}

/** Canonical plan order, lowest tier first. Drives pricing tables and lookups. */
export const PLAN_KEYS: PlanKey[] = ["free", "teams"];

export const PLANS: Record<PlanKey, PlanDefinition> = {
  free: {
    key: "free",
    name: "Free",
    description: "Everything you need to get started with your workspace.",
    tier: 0,
    isPaid: false,
    price: { month: 0, year: 0, currency: "USD" },
    highlights: ["Core spaces, tasks & docs", "Up to 3 automations", "Community support"],
  },
  teams: {
    key: "teams",
    name: "Teams",
    description: "Advanced collaboration and automation for growing teams.",
    tier: 10,
    isPaid: true,
    // Display only — real prices are configured on the Polar products.
    price: { month: 900, year: 9000, currency: "USD" },
    highlights: ["Unlimited automations", "Premium integrations", "Priority support"],
  },
};

/** The plan a user has when they have no active paid subscription. */
export const DEFAULT_PLAN: PlanKey = "free";

// ── Features (the registry future premium features plug into) ─────────────────

/**
 * Feature flags gated by plan. The values prefixed/commented as PLACEHOLDER are
 * scaffolding to demonstrate the system — no real premium feature is built yet.
 */
export type FeatureKey =
  | "example_premium_feature" // PLACEHOLDER demo used by the example gate
  | "advanced_automations" // PLACEHOLDER — not implemented yet
  | "unlimited_docs" // PLACEHOLDER — not implemented yet
  | "priority_support"; // PLACEHOLDER — not implemented yet

export interface FeatureDefinition {
  key: FeatureKey;
  name: string;
  description: string;
  /** Minimum plan that unlocks this feature (inclusive). */
  minPlan: PlanKey;
  /** Marks scaffolding/demo features that have no real implementation yet. */
  placeholder?: boolean;
}

export const FEATURES: Record<FeatureKey, FeatureDefinition> = {
  example_premium_feature: {
    key: "example_premium_feature",
    name: "Example Premium Feature",
    description: "A placeholder feature that demonstrates subscription gating end-to-end.",
    minPlan: "teams",
    placeholder: true,
  },
  advanced_automations: {
    key: "advanced_automations",
    name: "Advanced Automations",
    description: "Unlimited, advanced workflow automations.",
    minPlan: "teams",
    placeholder: true,
  },
  unlimited_docs: {
    key: "unlimited_docs",
    name: "Unlimited Docs",
    description: "Remove the document count limit.",
    minPlan: "teams",
    placeholder: true,
  },
  priority_support: {
    key: "priority_support",
    name: "Priority Support",
    description: "Faster, dedicated support response times.",
    minPlan: "teams",
    placeholder: true,
  },
};

/** All registered feature keys. */
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

// ── Limits (numeric quotas per plan) ──────────────────────────────────────────

/** Sentinel meaning "no limit". */
export const UNLIMITED = -1;

export interface PlanLimits {
  /** Max workflow automations. `UNLIMITED` (-1) = no cap. */
  maxAutomations: number;
  /** Max documents. `UNLIMITED` (-1) = no cap. */
  maxDocs: number;
  /** Max single file upload size, in megabytes. */
  maxFileUploadMb: number;
}

export const PLAN_LIMITS: Record<PlanKey, PlanLimits> = {
  free: { maxAutomations: 3, maxDocs: 50, maxFileUploadMb: 10 },
  teams: { maxAutomations: UNLIMITED, maxDocs: UNLIMITED, maxFileUploadMb: 100 },
};

// ── Subscription status semantics ─────────────────────────────────────────────

/**
 * Statuses we treat as "entitled". Mirrors polarService's own `live` set so the
 * entitlement layer and the billing layer never disagree about who is active.
 */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"] as const;
export type ActiveSubscriptionStatus = (typeof ACTIVE_SUBSCRIPTION_STATUSES)[number];

export function isActiveStatus(status?: string | null): boolean {
  return !!status && (ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

// ── Entitlements (the computed shape shared between backend & frontend) ────────

export type EntitlementSource = "subscription" | "none";

export interface Entitlements {
  /** Effective plan after applying subscription status (falls back to free). */
  plan: PlanKey;
  planName: string;
  /** Raw subscription status, or "none" when there is no subscription. */
  status: string;
  /** True when the user has an active paid subscription. */
  isActive: boolean;
  /** Feature keys unlocked by the effective plan. */
  features: FeatureKey[];
  /** Numeric quotas for the effective plan. */
  limits: PlanLimits;
  /** ISO date when the current paid period ends, if known. */
  currentPeriodEnd: string | null;
  /** True when an active subscription is set to not renew. */
  cancelAtPeriodEnd: boolean;
  /** Where the entitlement came from. */
  source: EntitlementSource;
}

// ── Pure helpers (used by both runtimes) ──────────────────────────────────────

export function getPlan(plan: PlanKey): PlanDefinition {
  return PLANS[plan] ?? PLANS[DEFAULT_PLAN];
}

export function planTier(plan: PlanKey): number {
  return getPlan(plan).tier;
}

/** True when `plan`'s tier is >= `required`'s tier. */
export function isPlanAtLeast(plan: PlanKey, required: PlanKey): boolean {
  return planTier(plan) >= planTier(required);
}

/** All feature keys unlocked by a plan (by tier inclusion). */
export function featuresForPlan(plan: PlanKey): FeatureKey[] {
  return FEATURE_KEYS.filter((key) => isPlanAtLeast(plan, FEATURES[key].minPlan));
}

/** Whether a plan unlocks a specific feature. */
export function planIncludesFeature(plan: PlanKey, feature: FeatureKey): boolean {
  const def = FEATURES[feature];
  return !!def && isPlanAtLeast(plan, def.minPlan);
}

export function limitsForPlan(plan: PlanKey): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS[DEFAULT_PLAN];
}

/** The minimum plan required to access a feature. */
export function requiredPlanForFeature(feature: FeatureKey): PlanKey {
  return FEATURES[feature]?.minPlan ?? DEFAULT_PLAN;
}

/** The lowest-tier paid plan — the default upsell target. Falls back to free. */
export function lowestPaidPlan(): PlanKey {
  const paid = PLAN_KEYS.filter((key) => PLANS[key].isPaid).sort((a, b) => PLANS[a].tier - PLANS[b].tier);
  return paid[0] ?? DEFAULT_PLAN;
}

export function isUnlimited(value: number): boolean {
  return value === UNLIMITED;
}

// ── Building & reading Entitlements ───────────────────────────────────────────

export interface EntitlementInput {
  /** Plan resolved from the subscription's product id. */
  plan: PlanKey;
  status?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean | null;
  source?: EntitlementSource;
}

/**
 * Build a normalized Entitlements object. If the resolved plan is paid but the
 * subscription is not in an active status, access drops to the default (free)
 * plan — i.e. a canceled "Teams" sub does not keep premium features.
 */
export function buildEntitlements(input: EntitlementInput): Entitlements {
  const requestedPlan: PlanKey = PLANS[input.plan] ? input.plan : DEFAULT_PLAN;
  const status = input.status ?? "none";
  const isActive = isActiveStatus(status) && getPlan(requestedPlan).isPaid;

  // Free plans are always "effective"; paid plans only when the sub is active.
  const effectivePlan: PlanKey = !getPlan(requestedPlan).isPaid || isActive ? requestedPlan : DEFAULT_PLAN;

  return {
    plan: effectivePlan,
    planName: getPlan(effectivePlan).name,
    status,
    isActive,
    features: featuresForPlan(effectivePlan),
    limits: limitsForPlan(effectivePlan),
    currentPeriodEnd: input.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: !!input.cancelAtPeriodEnd,
    source: input.source ?? (isActive ? "subscription" : "none"),
  };
}

/** Entitlements for a user with no active subscription. */
export const FREE_ENTITLEMENTS: Entitlements = buildEntitlements({
  plan: DEFAULT_PLAN,
  status: "none",
  source: "none",
});

/** Whether the given (possibly missing) entitlements unlock a feature. */
export function hasFeature(entitlements: Entitlements | null | undefined, feature: FeatureKey): boolean {
  if (!entitlements) return planIncludesFeature(DEFAULT_PLAN, feature);
  return entitlements.features.includes(feature);
}

/** Whether the entitlements meet a minimum plan tier. */
export function meetsPlan(entitlements: Entitlements | null | undefined, required: PlanKey): boolean {
  return isPlanAtLeast(entitlements?.plan ?? DEFAULT_PLAN, required);
}

/** Read a numeric limit from (possibly missing) entitlements. */
export function getLimit(entitlements: Entitlements | null | undefined, key: keyof PlanLimits): number {
  return (entitlements?.limits ?? PLAN_LIMITS[DEFAULT_PLAN])[key];
}

// ── Catalog (for pricing pages / API) ─────────────────────────────────────────

export interface EntitlementCatalog {
  plans: PlanDefinition[];
  features: FeatureDefinition[];
  limits: Record<PlanKey, PlanLimits>;
}

export function getEntitlementCatalog(): EntitlementCatalog {
  return {
    plans: PLAN_KEYS.map((key) => PLANS[key]),
    features: FEATURE_KEYS.map((key) => FEATURES[key]),
    limits: PLAN_LIMITS,
  };
}

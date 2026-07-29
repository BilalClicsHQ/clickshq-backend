// ─────────────────────────────────────────────────────────────────────────────
// Feature-gating middleware. Chain these AFTER `requireAuth` to restrict a route
// to subscribers / specific plans / specific features.
//
//   router.get("/x", requireAuth, requireActiveSubscription(), handler)
//   router.get("/y", requireAuth, requireFeature("advanced_automations"), handler)
//   router.get("/z", requireAuth, requirePlan("teams"), handler)
//
// Each is a middleware FACTORY (returns the actual middleware), mirroring
// server/middleware/requireIntegration.ts, and returns the same structured
// envelope `{ success: false, error: { code, message, retryable, ... } }` so the
// SPA can drive a paywall/upgrade prompt off the machine-readable `code`.
//
// STATUS CODES
//   401 — not authenticated (defensive; requireAuth should run first).
//   402 — Payment Required: authenticated but the plan doesn't include this.
//         (Deliberately distinct from 403 "forbidden" so an upgrade wall is
//          never confused with an authorization error.)
//   500 — unexpected failure while resolving entitlements (fail-closed).
// ─────────────────────────────────────────────────────────────────────────────
import type { Request, Response, NextFunction } from "express";
import { loadEntitlements } from "../services/entitlementService";
import {
  getPlan,
  hasFeature,
  meetsPlan,
  requiredPlanForFeature,
  type Entitlements,
  type FeatureKey,
  type PlanKey,
} from "@shared/entitlements";

// ── Carry the resolved entitlements to downstream handlers ────────────────────
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      entitlements?: Entitlements;
    }
  }
}

function unauthenticated(res: Response) {
  return res.status(401).json({
    success: false,
    error: { code: "UNAUTHORIZED", message: "User not authenticated", retryable: false },
  });
}

function checkFailed(res: Response, err: unknown, where: string) {
  console.error(`[entitlements] ${where} failed:`, (err as any)?.message ?? err);
  return res.status(500).json({
    success: false,
    error: { code: "ENTITLEMENT_CHECK_FAILED", message: "Failed to verify subscription", retryable: true },
  });
}

/** Require any active paid subscription (no specific plan/feature). */
export function requireActiveSubscription() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as any;
      if (!user?.id) return unauthenticated(res);

      const entitlements = await loadEntitlements(req);
      if (!entitlements.isActive) {
        return res.status(402).json({
          success: false,
          error: {
            code: "NO_ACTIVE_SUBSCRIPTION",
            message: "This requires an active subscription.",
            retryable: false,
            upgradeRequired: true,
          },
        });
      }
      return next();
    } catch (err) {
      return checkFailed(res, err, "requireActiveSubscription");
    }
  };
}

/** Require a specific feature to be unlocked by the caller's plan. */
export function requireFeature(feature: FeatureKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as any;
      if (!user?.id) return unauthenticated(res);

      const entitlements = await loadEntitlements(req);
      if (!hasFeature(entitlements, feature)) {
        const requiredPlan = requiredPlanForFeature(feature);
        return res.status(402).json({
          success: false,
          error: {
            code: "FEATURE_NOT_IN_PLAN",
            message: `The "${feature}" feature is not included in your plan.`,
            retryable: false,
            upgradeRequired: true,
            feature,
            requiredPlan,
            requiredPlanName: getPlan(requiredPlan).name,
          },
        });
      }
      return next();
    } catch (err) {
      return checkFailed(res, err, "requireFeature");
    }
  };
}

/** Require the caller's plan to be at least `plan` (tier comparison). */
export function requirePlan(plan: PlanKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as any;
      if (!user?.id) return unauthenticated(res);

      const entitlements = await loadEntitlements(req);
      if (!meetsPlan(entitlements, plan)) {
        return res.status(402).json({
          success: false,
          error: {
            code: "PLAN_REQUIRED",
            message: `This requires the ${getPlan(plan).name} plan or higher.`,
            retryable: false,
            upgradeRequired: true,
            requiredPlan: plan,
            requiredPlanName: getPlan(plan).name,
          },
        });
      }
      return next();
    } catch (err) {
      return checkFailed(res, err, "requirePlan");
    }
  };
}

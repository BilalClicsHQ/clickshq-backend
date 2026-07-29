// ─────────────────────────────────────────────────────────────────────────────
// Entitlements routes — exposes the caller's effective plan + feature access and
// the static plan/feature catalog. Mounted at /api/entitlements (see routes.ts).
//
// This is the feature-access counterpart to the Polar billing routes
// (/api/billing/*): billing handles *buying* a plan, entitlements handle *what a
// plan unlocks*. The SPA reads GET /api/entitlements to drive feature gates.
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth";
import { getEntitlementsForUser } from "../services/entitlementService";
import { requireFeature } from "../middleware/requireEntitlement";
import { getEntitlementCatalog } from "@shared/entitlements";

const router = Router();

// GET /api/entitlements — the caller's effective plan, unlocked features & limits.
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const entitlements = await getEntitlementsForUser(req.user as any);
    res.json({ success: true, entitlements });
  } catch (error) {
    console.error("[entitlements] get error:", error);
    res.status(500).json({
      success: false,
      error: { code: "ENTITLEMENT_CHECK_FAILED", message: "Failed to load entitlements", retryable: true },
    });
  }
});

// GET /api/entitlements/catalog — static plan + feature catalog (pricing UI).
// Same data the SPA can import from @shared/entitlements; served for parity and
// for any consumer that prefers a single network source of truth.
router.get("/catalog", requireAuth, (_req: Request, res: Response) => {
  res.json({ success: true, catalog: getEntitlementCatalog() });
});

// ── PLACEHOLDER EXAMPLE ───────────────────────────────────────────────────────
// Demonstrates how a future premium endpoint is gated. This is NOT a real
// feature — it only proves the gate works end-to-end. A non-subscriber hitting
// this gets HTTP 402 with a machine-readable upgrade payload; a subscriber gets
// the demo response.
router.get(
  "/example/premium-ping",
  requireAuth,
  requireFeature("example_premium_feature"),
  (_req: Request, res: Response) => {
    res.json({
      success: true,
      demo: true,
      message: "🎉 You have access to the example premium feature.",
    });
  },
);

export default router;

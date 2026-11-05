/**
 * Integration requests from the Integrations page ("Request Integration").
 *
 *   POST /api/integration-requests  { productName, useCase?, priority, notifyEmail? }
 *
 * Saves the request and emails the requester a confirmation.
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { db } from "../db";
import { integrationRequests } from "@shared/schema";
import { sendIntegrationRequestEmail } from "../email";

const router = Router();

const PRIORITIES = ["High", "Medium", "Low"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const body = req.body ?? {};
    const productName = typeof body.productName === "string" ? body.productName.trim().slice(0, 120) : "";
    const useCase = typeof body.useCase === "string" ? body.useCase.trim().slice(0, 2000) : "";
    const priority = PRIORITIES.includes(body.priority) ? body.priority : "";
    const notifyEmail = typeof body.notifyEmail === "string" ? body.notifyEmail.trim().slice(0, 254) : "";

    if (!productName) {
      return res.status(400).json({ message: "Please tell us which product you want to integrate." });
    }
    if (!priority) {
      return res.status(400).json({ message: "Please choose a priority." });
    }
    if (notifyEmail && !EMAIL_RE.test(notifyEmail)) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }

    const [request] = await db
      .insert(integrationRequests)
      .values({
        userId: user.id,
        companyId: user.companyId ?? null,
        productName,
        useCase: useCase || null,
        priority,
        notifyEmail: notifyEmail || null,
      })
      .returning();

    // Confirmation email (non-blocking — a mail failure shouldn't lose the saved request)
    const toEmail = notifyEmail || user.email;
    if (toEmail) {
      sendIntegrationRequestEmail({
        toEmail,
        displayName: user.displayName || user.firstName || "there",
        productName,
        priority,
      }).catch((err) => console.error("[Integration request] confirmation email failed:", err?.message ?? err));
    }

    res.status(201).json({ success: true, data: { id: request.id } });
  } catch (error) {
    console.error("Error saving integration request:", error);
    res.status(500).json({ message: "Failed to submit request. Please try again." });
  }
});

export default router;

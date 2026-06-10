/**
 * Rate Limiting Middleware
 *
 * Production-grade rate limiting to prevent brute-force attacks on public document tokens.
 * Uses a sliding window algorithm with in-memory storage.
 *
 * Features:
 * - Per-IP rate limiting
 * - Configurable limits
 * - Automatic cleanup of old entries
 * - Returns standard rate limit headers
 */

import type { Request, Response, NextFunction } from "express";

// ============================================================================
// TYPES
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window
  message?: string;      // Error message
  skipFailedRequests?: boolean;
}

// ============================================================================
// RATE LIMITER CLASS
// ============================================================================

class RateLimiter {
  private store: Map<string, RateLimitEntry> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Cleanup old entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if request should be rate limited
   */
  check(key: string, config: RateLimitConfig): {
    allowed: boolean;
    remaining: number;
    resetTime: number;
    total: number;
  } {
    const now = Date.now();
    const entry = this.store.get(key);

    // If no entry or window has passed, create new entry
    if (!entry || now > entry.resetTime) {
      this.store.set(key, {
        count: 1,
        resetTime: now + config.windowMs,
      });
      return {
        allowed: true,
        remaining: config.maxRequests - 1,
        resetTime: now + config.windowMs,
        total: config.maxRequests,
      };
    }

    // Increment count
    entry.count++;
    this.store.set(key, entry);

    const allowed = entry.count <= config.maxRequests;
    return {
      allowed,
      remaining: Math.max(0, config.maxRequests - entry.count),
      resetTime: entry.resetTime,
      total: config.maxRequests,
    };
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of Array.from(this.store.entries())) {
      if (now > entry.resetTime) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Destroy the rate limiter (cleanup interval)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// ============================================================================
// MIDDLEWARE FACTORY
// ============================================================================

const rateLimiter = new RateLimiter();

/**
 * Get client IP address from request
 */
function getClientIp(req: Request): string {
  // Check for forwarded IP (behind proxy)
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = Array.isArray(forwarded)
      ? forwarded[0]
      : forwarded.split(",")[0];
    return ips.trim();
  }

  // Check for real IP header
  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  // Fallback to socket address
  return req.socket.remoteAddress || "unknown";
}

/**
 * Create rate limiting middleware
 */
export function createRateLimiter(config: RateLimitConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req);
    const key = `${ip}:${req.path}`;

    const result = rateLimiter.check(key, config);

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", result.total);
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    res.setHeader("X-RateLimit-Reset", Math.ceil(result.resetTime / 1000));

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);
      res.setHeader("Retry-After", retryAfter);

      console.warn(`[RateLimit] IP ${ip} exceeded rate limit for ${req.path}`);

      return res.status(429).json({
        message: config.message || "Too many requests, please try again later",
        retryAfter,
      });
    }

    next();
  };
}

// ============================================================================
// PRE-CONFIGURED LIMITERS
// ============================================================================

/**
 * Rate limiter for public document access
 * Allows 60 requests per minute per IP
 * Prevents brute-force token guessing
 */
export const publicDocRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 60,     // 60 requests per minute
  message: "Too many requests to view this document. Please try again in a minute.",
});

/**
 * Stricter rate limiter for token validation attempts
 * Prevents rapid token guessing
 */
export const tokenValidationLimiter = createRateLimiter({
  windowMs: 60 * 1000,  // 1 minute
  maxRequests: 30,      // 30 attempts per minute
  message: "Too many link access attempts. Please try again later.",
});

/**
 * Rate limiter for API endpoints
 * General purpose limiter
 */
export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100,    // 100 requests per minute
  message: "Too many API requests. Please slow down.",
});

/**
 * Rate limiter for user search endpoint
 * Prevents email enumeration attacks and abuse
 * Allows 30 searches per minute per IP
 */
export const userSearchRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,  // 1 minute
  maxRequests: 30,      // 30 searches per minute
  message: "Too many search requests. Please slow down.",
});

/**
 * Rate limiter for document sharing endpoints
 * Prevents spam sharing
 */
export const shareDocumentRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,  // 1 minute
  maxRequests: 20,      // 20 share operations per minute
  message: "Too many sharing requests. Please slow down.",
});

/**
 * Rate limiter for Slack OAuth endpoints
 * Prevents OAuth abuse
 */
export const slackOAuthRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,  // 1 minute
  maxRequests: 10,       // 10 OAuth attempts per minute
  message: "Too many Slack OAuth requests. Please try again later.",
});

export { getClientIp };

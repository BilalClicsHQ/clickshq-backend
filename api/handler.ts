import type { VercelRequest, VercelResponse } from "@vercel/node";

// Lazily-initialised Express app (Vercel reuses the warm instance across invocations).
let app: any;
let initialized = false;
let initError: Error | null = null;

function validateEnvironment() {
  const required = ["DATABASE_URL", "SESSION_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

async function getApp() {
  if (initError) throw initError;
  if (initialized) return app;

  try {
    validateEnvironment();

    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const passport = (await import("passport")).default;
    const cors = (await import("cors")).default;
    const { setupAuth } = await import("../server/auth");
    const { registerRoutesServerless } = await import("../server/routes");

    const newApp = express();
    const isProduction = process.env.NODE_ENV === "production";

    // CORS
    const allowedOrigins: string[] = [];
    if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);
    if (process.env.ALLOWED_ORIGINS) {
      allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean));
    }
    if (!isProduction) allowedOrigins.push("http://localhost:5173", "http://localhost:3000");

    newApp.use(
      cors({
        origin: (origin, cb) => {
          if (!origin) return cb(null, true);
          if (allowedOrigins.includes(origin)) return cb(null, origin);
          return cb(null, false);
        },
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
        credentials: true,
      }),
    );

    // Body parsers with raw-body capture for webhooks/Slack HMAC
    newApp.use(express.json({
      limit: "5mb",
      verify: (req: any, _res, buf) => {
        if (req.originalUrl && (
          req.originalUrl.startsWith("/api/webhooks/") ||
          req.originalUrl.startsWith("/api/integrations/slack/commands") ||
          req.originalUrl.startsWith("/api/integrations/slack/interactivity")
        )) req.rawBody = buf;
      },
    }));
    newApp.use(express.urlencoded({
      extended: true,
      limit: "5mb",
      verify: (req: any, _res, buf) => {
        if (req.originalUrl && (
          req.originalUrl.startsWith("/api/integrations/slack/commands") ||
          req.originalUrl.startsWith("/api/integrations/slack/interactivity")
        )) req.rawBody = buf;
      },
    }));

    newApp.set("trust proxy", 1);

    // Session — cross-site cookies in production
    const PgStore = (await import("connect-pg-simple")).default(session);
    const { pool } = await import("../server/db");
    newApp.use(session({
      store: new PgStore({ pool: pool as any, tableName: "session", createTableIfMissing: true }),
      secret: process.env.SESSION_SECRET || "your-secret-key-change-this",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: isProduction,
        httpOnly: true,
        sameSite: isProduction ? "none" : "lax",
        maxAge: 24 * 60 * 60 * 1000,
      },
    }));

    newApp.use(passport.initialize());
    newApp.use(passport.session());
    setupAuth();

    await registerRoutesServerless(newApp);

    // Error handler
    newApp.use((err: any, _req: any, res: any, _next: any) => {
      const status = err.status || err.statusCode || 500;
      res.status(status).json({ message: err.message || "Internal Server Error" });
      console.error("Error:", err);
    });

    app = newApp;
    initialized = true;
    return app;
  } catch (error) {
    initError = error as Error;
    throw error;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const expressApp = await getApp();
    expressApp(req, res);
  } catch (error: any) {
    res.status(500).json({
      error: "Server initialization failed",
      message: error?.message ?? String(error),
    });
  }
}

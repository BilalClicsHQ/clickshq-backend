import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readFileSync, existsSync } from 'fs';
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Verify the server certificate against the RDS CA bundle when one is present.
// Download it on the host with:
//   sudo curl -o /etc/ssl/rds/global-bundle.pem \
//     https://truststore.pki.rds.amazonaws.com/global-bundle.pem
function sslConfig() {
  if (process.env.NODE_ENV !== 'production') return false;

  const caPath = process.env.DATABASE_CA_PATH || '/etc/ssl/rds/global-bundle.pem';
  if (existsSync(caPath)) {
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }

  // No bundle on disk: still encrypt, but the certificate can't be verified.
  console.warn(`[db] RDS CA bundle not found at ${caPath} — connecting without certificate verification`);
  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig()
});
export const db = drizzle(pool, { schema });

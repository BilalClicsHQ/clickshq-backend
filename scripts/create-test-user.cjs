// Creates a loginable test user that MIRRORS all of asad's user fields (role,
// verified, onboarded, settings/flags), with its own company so it doesn't share
// asad's billing. Copies asad's row via INSERT...SELECT (preserving column types
// like the role enum), overriding identity/session/security columns.
// Run: node scripts/create-test-user.cjs [email] [password] [displayName]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");

const EMAIL = process.argv[2] || "clics.testuser@gmail.com";
const PASSWORD = process.argv[3] || "Test@12345";
const DISPLAY = process.argv[4] || "Test User";
const COMPANY_NAME = "Test Workspace";
const TEMPLATE_EMAIL = "asadaslam7652@gmail.com"; // user to mirror

function readEnv(key) {
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && m[1] === key) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  }
}

(async () => {
  const dbUrl = readEnv("DATABASE_URL");
  let host = "";
  try { host = new URL(dbUrl).hostname; } catch {}
  const isLocal = ["localhost", "127.0.0.1"].includes(host);
  const pool = new Pool({ connectionString: dbUrl, ssl: isLocal ? false : { rejectUnauthorized: false } });

  try {
    const dup = await pool.query("SELECT id FROM users WHERE email=$1", [EMAIL]);
    if (dup.rowCount) { console.error(`A user with email ${EMAIL} already exists (${dup.rows[0].id}).`); process.exit(1); }
    const tpl = await pool.query("SELECT id, company_id FROM users WHERE email=$1", [TEMPLATE_EMAIL]);
    if (!tpl.rowCount) { console.error(`Template user ${TEMPLATE_EMAIL} not found.`); process.exit(1); }
    const templateCompanyId = tpl.rows[0].company_id;

    const userId = crypto.randomUUID();
    const companyId = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(PASSWORD, 12);

    await pool.query("BEGIN");

    // 1) User — copy asad's settings columns, override identity/session/security.
    await pool.query(
      `INSERT INTO users (
        id, email, display_name, password, role, profile_picture, is_online, last_activity,
        reset_token, reset_token_expiry, created_at, last_login, first_name, last_name, country,
        phone, birthday, language, timezone, theme, date_format, time_format, week_format,
        has_completed_onboarding, onboarding_use_case, onboarding_management_area, onboarding_heard_from,
        onboarding_workspace_name, onboarding_interested_features, is_email_verified,
        email_verification_token, email_verification_expiry, auth_provider, google_id, microsoft_id,
        is_soft_signup, email_notifications, in_app_notifications, notify_task_assigned, notify_mentions,
        notify_comments, notify_due_date_reminders, email_2fa_enabled, email_2fa_code, email_2fa_code_expiry,
        email_2fa_pending_action, totp_2fa_enabled, totp_secret, totp_temp_secret, totp_backup_codes,
        company_id, slack_user_id
      )
      SELECT
        $1, $2, $3, $4, role, profile_picture, false, now(),
        NULL, NULL, now(), now(), $5, $6, country,
        phone, birthday, language, timezone, theme, date_format, time_format, week_format,
        has_completed_onboarding, onboarding_use_case, onboarding_management_area, onboarding_heard_from,
        $7, onboarding_interested_features, is_email_verified,
        NULL, NULL, auth_provider, NULL, NULL,
        is_soft_signup, email_notifications, in_app_notifications, notify_task_assigned, notify_mentions,
        notify_comments, notify_due_date_reminders, email_2fa_enabled, NULL, NULL,
        NULL, totp_2fa_enabled, NULL, NULL, totp_backup_codes,
        NULL, NULL
      FROM users WHERE email = $8`,
      [userId, EMAIL, DISPLAY, passwordHash, "Test", "User", COMPANY_NAME, TEMPLATE_EMAIL],
    );

    // 2) Company — copy asad's company columns, override id/name/owner, no default space.
    await pool.query(
      `INSERT INTO companies (id, name, owner_user_id, work_role, work_function, use_case, heard_from, default_space_id, created_at, updated_at)
       SELECT $1, $2, $3, work_role, work_function, use_case, heard_from, NULL, now(), now()
       FROM companies WHERE id = $4`,
      [companyId, COMPANY_NAME, userId, templateCompanyId],
    );

    // 3) Link the user to its new company.
    await pool.query("UPDATE users SET company_id=$1 WHERE id=$2", [companyId, userId]);

    await pool.query("COMMIT");

    console.log("✅ Test user created.\n");
    console.log("  Login email: ", EMAIL);
    console.log("  Password:    ", PASSWORD);
    console.log("  user id:     ", userId);
    console.log("  company id:  ", companyId, `("${COMPANY_NAME}")`);
    console.log("  role: admin · email verified · onboarding complete · own workspace");
  } catch (e) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("ERROR:", e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();

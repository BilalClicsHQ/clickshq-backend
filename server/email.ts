import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ── ClicsHQ logo (white, for the black email header) ─────────────────────────
// Embedded via CID so it renders reliably everywhere (Gmail/Outlook block SVG
// and inline data: URIs). nodemailer reads the file and inlines it per email.
const __dirnameEsm = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dirnameEsm, 'assets', 'clicshq-logo-white.png');
const LOGO_CID = 'clicshqlogo';
const logoAttachment = { filename: 'clicshq-logo.png', path: LOGO_PATH, cid: LOGO_CID };
// Reusable <img> wordmark for the dark header.
const LOGO_IMG = `<img src="cid:${LOGO_CID}" width="150" height="56" alt="ClicsHQ" style="display:block; width:150px; max-width:150px; height:auto; margin:0 auto; border:0;" />`;

// Website fonts: Urbanist for text, Inter for buttons. Clients that load web fonts
// (Apple Mail, iOS Mail, Outlook for Mac…) use them; others fall back to the stack.
const FONT_LINK =
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Urbanist:wght@400;500;600;700&display=swap" rel="stylesheet" />';
const FONT_STACK = "'Urbanist','Segoe UI',Tahoma,Geneva,Verdana,sans-serif";
const BUTTON_FONT_STACK = "'Inter','Urbanist','Segoe UI',Arial,sans-serif";

// When no Gmail credentials are configured (e.g. local development), real SMTP
// auth fails with `Missing credentials for "PLAIN"`. Rather than crash every
// route that sends mail, fall back to a console "transport" that logs the email
// (and any verification/reset/invite link found in the body) to the terminal.
// Prefer a generic SMTP server when configured; otherwise fall back to Gmail,
// otherwise log to the console (local dev).
const hasResend = Boolean(process.env.RESEND_API_KEY);
const hasSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT);
const hasGmail = Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const hasEmailCredentials = hasResend || hasSmtp || hasGmail;

// Address outgoing mail is sent "from".
const MAIL_FROM =
  process.env.MAIL_FROM ||
  process.env.SMTP_FROM ||
  (process.env.SMTP_USER ? `"ClicsHQ" <${process.env.SMTP_USER}>` : '') ||
  (process.env.GMAIL_USER ? `"ClicsHQ" <${process.env.GMAIL_USER}>` : '') ||
  '"ClicsHQ" <no-reply@clicshq.com>';

function logEmailToConsole(mailOptions: any) {
  const links = String(mailOptions?.html ?? '').match(/https?:\/\/[^\s"'<)]+/g) || [];

  // Opt-in: dump the rendered HTML so templates can be opened in a browser and
  // compared against the design. Does nothing unless EMAIL_PREVIEW_DIR is set.
  const previewDir = process.env.EMAIL_PREVIEW_DIR;
  if (previewDir && mailOptions?.html) {
    try {
      const slug = String(mailOptions.subject ?? 'email')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
      mkdirSync(previewDir, { recursive: true });
      const previewFile = join(previewDir, `${slug || 'email'}.html`);
      writeFileSync(previewFile, String(mailOptions.html), 'utf8');
      console.log(`   Preview: ${previewFile}`);
    } catch (err) {
      console.warn('   (could not write email preview)', err instanceof Error ? err.message : err);
    }
  }
  console.log('\n📧 [DEV EMAIL — not sent, no email credentials configured]');
  console.log(`   To:      ${mailOptions?.to}`);
  console.log(`   Subject: ${mailOptions?.subject}`);
  if (links.length) {
    console.log('   Links:');
    for (const link of links) console.log(`     → ${link}`);
  }
  console.log('');
  return { messageId: 'dev-console-transport', accepted: [mailOptions?.to] };
}

/**
 * Resend speaks JSON over HTTPS rather than SMTP, so the nodemailer-shaped
 * options every send function below builds have to be translated:
 *
 *   - nodemailer's `attachments[].path` is a local file path, while Resend's
 *     `path` means a URL, so the file is read into a Buffer instead.
 *   - the inline logo is tied to its <img src="cid:..."> by `contentId`.
 *   - Resend reports failures in the response as `error` instead of throwing,
 *     so they are re-thrown here for the callers' try/catch to see.
 */
function createResendTransport() {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fileCache = new Map<string, Buffer>();

  // The logo is the same file on every email, so read it once.
  const readAttachment = (filePath: string): Buffer => {
    const cached = fileCache.get(filePath);
    if (cached) return cached;
    const buffer = readFileSync(filePath);
    fileCache.set(filePath, buffer);
    return buffer;
  };

  return {
    async sendMail(mailOptions: any) {
      const attachments = (mailOptions.attachments ?? [])
        .map((file: any) => {
          try {
            return {
              filename: file.filename,
              content: file.content ?? readAttachment(file.path),
              ...(file.cid ? { contentId: file.cid } : {}),
            };
          } catch (err) {
            // A missing logo should not stop the email from going out.
            console.warn(
              `⚠️  [email] attachment "${file.filename}" skipped:`,
              err instanceof Error ? err.message : err
            );
            return null;
          }
        })
        .filter(Boolean);

      const { data, error } = await resend.emails.send({
        from: mailOptions.from || MAIL_FROM,
        to: mailOptions.to,
        subject: mailOptions.subject,
        html: mailOptions.html,
        ...(mailOptions.text ? { text: mailOptions.text } : {}),
        ...(mailOptions.replyTo ? { replyTo: mailOptions.replyTo } : {}),
        ...(attachments.length ? { attachments } : {}),
      } as any);

      if (error) {
        throw new Error(`Resend rejected the email: ${error.message || JSON.stringify(error)}`);
      }
      return { messageId: data?.id, accepted: [mailOptions.to] };
    },
  };
}

// Transports in order of preference: Resend, generic SMTP, Gmail, then a
// console fallback for local development with nothing configured.
const transporter = hasResend
  ? createResendTransport()
  : hasSmtp
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      // true for 465 (SSL), false for 587/25 (STARTTLS) — override with SMTP_SECURE=true/false
      secure:
        process.env.SMTP_SECURE === 'true' ||
        Number(process.env.SMTP_PORT) === 465,
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    })
  : hasGmail
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER, // your-email@gmail.com
        pass: process.env.GMAIL_APP_PASSWORD, // App password (not regular password)
      },
    })
  : ({ sendMail: async (mailOptions: any) => logEmailToConsole(mailOptions) } as any);

if (hasResend) {
  console.log(`📧 Resend email enabled — sending as ${MAIL_FROM}`);
} else if (hasSmtp) {
  console.log(`📧 SMTP email enabled via ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`);
} else if (hasGmail) {
  console.log('📧 Gmail email enabled');
} else {
  console.warn(
    '⚠️  No RESEND_API_KEY, SMTP_* or GMAIL_* credentials set — emails will be logged to the console instead of sent. ' +
      'Verification/reset/invite links will appear in this terminal.'
  );
}

// ── Email design system ──────────────────────────────────────────────────────
// One shell for every ClicsHQ email, matching the product design: a black bar
// carrying the wordmark, a white card with a centred heading, left-aligned copy,
// a single black action button, a hairline divider broken by a padlock badge,
// a "Security Tip" line, and the support footer.
//
// Everything is table layout with fully inline styles — Gmail and Outlook strip
// <style> blocks and class attributes, and neither renders inline SVG, so the
// wordmark, padlock and entity icons are CID-attached PNGs.

const LOCK_CID = 'clicshqlock';
const ICON_TASK_CID = 'clicshqtask';
const ICON_DOC_CID = 'clicshqdoc';

const assetPath = (file: string) => join(__dirnameEsm, 'assets', file);
const lockAttachment = { filename: 'lock-badge.png', path: assetPath('lock-badge.png'), cid: LOCK_CID };
const taskIconAttachment = { filename: 'icon-task.png', path: assetPath('icon-task.png'), cid: ICON_TASK_CID };
const docIconAttachment = { filename: 'icon-doc.png', path: assetPath('icon-doc.png'), cid: ICON_DOC_CID };

/** The wordmark and padlock appear in every email; entity icons are added per template. */
const BASE_ATTACHMENTS = [logoAttachment, lockAttachment];

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@clicshq.com';

// Palette
const INK = '#111113';
const BODY_TEXT = '#4b4b53';
const MUTED = '#7c7c86';
const HAIRLINE = '#e6e6ea';
const PAGE_BG = '#e8e8ea';
const SOFT_BG = '#fafafa';

/** User-typed text going into an HTML email. */
const escapeHtml = (value: string) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Strip tags and collapse whitespace for the hidden preheader line. */
const toPreheader = (html: string) =>
  String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);

/** The hairline rule with the padlock badge sitting on it. */
function lockDivider(): string {
  const rule =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
    `<tr><td style="border-top:1px solid ${HAIRLINE}; font-size:0; line-height:0;">&nbsp;</td></tr></table>`;
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:30px 0 20px;">
                <tr>
                  <td valign="middle" style="font-size:0; line-height:0;">${rule}</td>
                  <td valign="middle" width="54" align="center" style="padding:0 10px;">
                    <img src="cid:${LOCK_CID}" width="32" height="32" alt="" style="display:block; width:32px; max-width:32px; height:32px; border:0;" />
                  </td>
                  <td valign="middle" style="font-size:0; line-height:0;">${rule}</td>
                </tr>
              </table>`;
}

/** A plain hairline, used between the Security Tip and the footer. */
function plainDivider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 18px;">
                <tr><td style="border-top:1px solid ${HAIRLINE}; font-size:0; line-height:0;">&nbsp;</td></tr>
              </table>`;
}

/**
 * Builds a ClicsHQ email.
 *
 * `paragraphs` and `block` are injected as HTML, so any user-supplied value must
 * already have been passed through `escapeHtml` by the caller.
 */
function buildEmailTemplate(opts: {
  /** Used for <title> and, when no explicit preheader is given, the inbox preview. */
  title: string;
  /** Centred heading inside the card. Some designs (task/billing alerts) have none. */
  heading?: string;
  /** "Hi Sara," */
  greeting: string;
  /** Body copy, one <p> each. */
  paragraphs?: string[];
  /** Card, code box or detail table rendered between the copy and the button. */
  block?: string;
  buttonLabel?: string;
  buttonUrl?: string;
  /** The line printed under "Security Tip". */
  securityTip?: string;
}): string {
  const { title, heading, greeting, paragraphs = [], block, buttonLabel, buttonUrl, securityTip } = opts;
  const year = new Date().getFullYear();

  const copy = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px; font-size:13.5px; line-height:1.75; color:${BODY_TEXT};">${p}</p>`,
    )
    .join('\n                  ');

  const button =
    buttonLabel && buttonUrl
      ? `
                  <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:28px auto 6px; width:72%; min-width:230px;">
                    <tr>
                      <td align="center" style="background-color:${INK}; border-radius:8px;">
                        <a href="${buttonUrl}" target="_blank" style="display:block; padding:14px 22px; font-family:${BUTTON_FONT_STACK}; font-size:13.5px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:8px;">${buttonLabel}</a>
                      </td>
                    </tr>
                  </table>`
      : '';

  const tip = securityTip
    ? `
                  <p style="margin:0 0 6px; font-size:13.5px; font-weight:600; color:${INK};">Security Tip</p>
                  <p style="margin:0; font-size:12.5px; line-height:1.7; color:${BODY_TEXT};">${securityTip}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light only" />
    <title>${title}</title>
    ${FONT_LINK}
  </head>
  <body style="margin:0; padding:0; background-color:${PAGE_BG}; -webkit-text-size-adjust:100%; font-family:${FONT_STACK};">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0;">${toPreheader(heading || copy || title)}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${PAGE_BG}; padding:26px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:14px; overflow:hidden; font-family:${FONT_STACK};">

            <!-- Wordmark bar -->
            <tr>
              <td style="background-color:#000000; padding:22px 32px; text-align:center;">${LOGO_IMG}</td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:30px 32px 26px;">
                ${heading ? `<p style="margin:0 0 24px; font-size:17px; font-weight:600; color:${INK}; text-align:center;">${heading}</p>` : ''}
                <p style="margin:0 0 16px; font-size:13.5px; color:${INK};">${greeting}</p>
                ${copy}
                ${block ?? ''}
                ${button}
                ${lockDivider()}
                ${tip}
                ${plainDivider()}
                <p style="margin:0 0 6px; font-size:12px; color:${BODY_TEXT}; text-align:center;">Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:${INK}; font-weight:600; text-decoration:underline;">Contact our support team</a></p>
                <p style="margin:0; font-size:12px; color:${MUTED}; text-align:center;">${year} ClicsHQ. All rights reserved</p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ── Reusable content blocks ──────────────────────────────────────────────────

/** The boxed one-digit-per-cell verification code. */
function codeBlock(code: string, expiresInMinutes = 10): string {
  const cells = String(code)
    .split('')
    .map(
      (digit) => `<td align="center" style="padding:0 3px;">
                          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                            <td align="center" width="44" height="52" style="width:44px; height:52px; background-color:#f3f3f5; border-radius:9px; font-family:${FONT_STACK}; font-size:21px; font-weight:600; color:${INK};">${escapeHtml(digit)}</td>
                          </tr></table>
                        </td>`,
    )
    .join('\n                        ');

  return `
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;">
                  <tr>
                    <td align="center" style="background-color:${SOFT_BG}; border:1px solid ${HAIRLINE}; border-radius:12px; padding:22px 16px;">
                      <p style="margin:0 0 16px; font-size:13.5px; font-weight:600; color:${INK};">Your ${String(code).length}-digit verification code</p>
                      <table role="presentation" align="center" cellpadding="0" cellspacing="0"><tr>
                        ${cells}
                      </tr></table>
                      <p style="margin:16px 0 0; font-size:12px; color:${MUTED};">This code will expire in <strong style="color:${INK};">${expiresInMinutes} minutes</strong>.</p>
                    </td>
                  </tr>
                </table>`;
}

/** A bordered card headed by an entity icon, its type and its name. */
function entityCard(opts: { iconCid: string; type: string; name: string; inner?: string }): string {
  const { iconCid, type, name, inner } = opts;
  return `
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;">
                  <tr>
                    <td style="border:1px solid ${HAIRLINE}; border-radius:12px; padding:18px 18px 16px;">
                      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                        <tr>
                          <td width="34" valign="top" style="padding-right:12px;">
                            <img src="cid:${iconCid}" width="26" height="26" alt="" style="display:block; width:26px; max-width:26px; height:26px; border:0;" />
                          </td>
                          <td valign="middle">
                            <p style="margin:0; font-size:11.5px; color:${MUTED};">${type}</p>
                            <p style="margin:3px 0 0; font-size:14px; font-weight:600; color:${INK};">${name}</p>
                          </td>
                        </tr>
                      </table>
                      ${inner ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr><td style="border-top:1px solid ${HAIRLINE}; padding-top:14px;">${inner}</td></tr></table>` : ''}
                    </td>
                  </tr>
                </table>`;
}

/** Label/value rows — Project, Due, Priority, Plan, Amount… */
function detailRows(rows: { label: string; value: string; pill?: 'plain' | 'danger' }[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        ${rows
                          .map((r) => {
                            const style =
                              r.pill === 'danger'
                                ? `display:inline-block; padding:4px 11px; border-radius:6px; background-color:#f5322c; color:#ffffff; font-size:11.5px; font-weight:600;`
                                : `display:inline-block; padding:4px 11px; border-radius:6px; background-color:#f3f3f5; color:${INK}; font-size:11.5px; font-weight:500;`;
                            return `<tr>
                            <td style="padding:7px 0; font-size:12.5px; color:${MUTED};">${r.label}</td>
                            <td align="right" style="padding:7px 0;"><span style="${style}">${r.value}</span></td>
                          </tr>`;
                          })
                          .join('\n                        ')}
                      </table>`;
}

/** The quoted comment with its author, avatar and age. */
function commentBlock(opts: { author: string; avatarUrl?: string | null; age: string; body: string }): string {
  const { author, avatarUrl, age, body } = opts;
  const initial = (author.trim()[0] || '?').toUpperCase();
  const avatar = avatarUrl
    ? `<img src="${avatarUrl}" width="28" height="28" alt="" style="display:block; width:28px; max-width:28px; height:28px; border:0; border-radius:14px;" />`
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" width="28" height="28" style="width:28px; height:28px; background-color:${INK}; border-radius:14px; color:#ffffff; font-size:12px; font-weight:600; font-family:${FONT_STACK};">${escapeHtml(initial)}</td></tr></table>`;

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="40" valign="top" style="padding-right:10px;">${avatar}</td>
                          <td valign="top">
                            <p style="margin:0; font-size:12.5px; font-weight:600; color:${INK};">${author}</p>
                            <p style="margin:2px 0 0; font-size:11px; color:${MUTED};">${age}</p>
                          </td>
                        </tr>
                        <tr>
                          <td colspan="2" style="padding-top:10px; font-size:12.5px; line-height:1.7; color:${BODY_TEXT};">${body}</td>
                        </tr>
                      </table>`;
}

/** Previous → new status, plus who changed it and when. */
function statusChangeBlock(opts: {
  previousStatus: string;
  newStatus: string;
  changedBy: string;
  changedByRole?: string | null;
  changedOn: string;
  changedAt?: string | null;
}): string {
  const { previousStatus, newStatus, changedBy, changedByRole, changedOn, changedAt } = opts;
  const initial = (changedBy.trim()[0] || '?').toUpperCase();
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td align="center" style="padding-bottom:16px;">
                            <table role="presentation" align="center" cellpadding="0" cellspacing="0">
                              <tr>
                                <td align="center" style="padding-right:14px;">
                                  <p style="margin:0 0 6px; font-size:11.5px; color:${MUTED};">Previous status</p>
                                  <span style="display:inline-block; padding:5px 12px; border-radius:6px; background-color:#f3f3f5; color:${BODY_TEXT}; font-size:11.5px; font-weight:500;">${previousStatus}</span>
                                </td>
                                <td align="center" style="padding:14px 10px 0; font-size:15px; color:${INK};">&rarr;</td>
                                <td align="center" style="padding-left:14px;">
                                  <p style="margin:0 0 6px; font-size:11.5px; color:${MUTED};">New status</p>
                                  <span style="display:inline-block; padding:5px 12px; border-radius:6px; background-color:${INK}; color:#ffffff; font-size:11.5px; font-weight:600;">${newStatus}</span>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                        <tr>
                          <td style="border-top:1px solid ${HAIRLINE}; padding-top:14px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                              <tr>
                                <td valign="top" width="50%">
                                  <p style="margin:0 0 8px; font-size:11.5px; color:${MUTED};">Changed by</p>
                                  <table role="presentation" cellpadding="0" cellspacing="0">
                                    <tr>
                                      <td width="36" valign="middle" style="padding-right:9px;">
                                        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" width="28" height="28" style="width:28px; height:28px; background-color:${INK}; border-radius:14px; color:#ffffff; font-size:12px; font-weight:600; font-family:${FONT_STACK};">${escapeHtml(initial)}</td></tr></table>
                                      </td>
                                      <td valign="middle">
                                        <p style="margin:0; font-size:12.5px; font-weight:600; color:${INK};">${changedBy}</p>
                                        ${changedByRole ? `<p style="margin:2px 0 0; font-size:11px; color:${MUTED};">${changedByRole}</p>` : ''}
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                                <td valign="top" width="50%" style="border-left:1px solid ${HAIRLINE}; padding-left:18px;">
                                  <p style="margin:0 0 8px; font-size:11.5px; color:${MUTED};">Changed on</p>
                                  <p style="margin:0; font-size:12.5px; font-weight:600; color:${INK};">${changedOn}</p>
                                  ${changedAt ? `<p style="margin:2px 0 0; font-size:11px; color:${MUTED};">${changedAt}</p>` : ''}
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>`;
}

// ── Senders ──────────────────────────────────────────────────────────────────

export async function send2FACodeEmail(
  email: string,
  code: string,
  displayName: string,
  action: "enable" | "disable"
) {
  const heading = action === 'enable' ? 'Enable two-factor authentication' : 'Disable two-factor authentication';
  const verb = action === 'enable' ? 'enable' : 'disable';

  const mailOptions = {
    from: MAIL_FROM,
    attachments: BASE_ATTACHMENTS,
    to: email,
    subject: `Your ClicsHQ verification code`,
    html: buildEmailTemplate({
      title: heading,
      heading,
      greeting: `Hi ${escapeHtml(displayName)},`,
      paragraphs: [`We received a request to ${verb} two-factor authentication on your ClicsHQ account.`],
      block: codeBlock(code, 10),
      securityTip: "If you didn't request this code, you can safely ignore this email or contact our team.",
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`2FA ${verb} email sent to ${email}`);
  } catch (error) {
    console.error(`Error sending 2FA ${verb} email:`, error);
    throw new Error(`Failed to send 2FA verification email`);
  }
}

export async function sendVerificationEmail(
  email: string,
  token: string,
  displayName: string
) {
  const verificationUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${token}`;

  const mailOptions = {
    from: MAIL_FROM,
    attachments: BASE_ATTACHMENTS,
    to: email,
    subject: 'Verify your ClicsHQ account',
    html: buildEmailTemplate({
      title: 'Verify your ClicsHQ account',
      heading: 'Verify your ClicsHQ account',
      greeting: `Hi ${escapeHtml(displayName)},`,
      paragraphs: [
        "Thanks for signing up! We're excited to have you on board.",
        'Please verify your email address by clicking the button below:',
      ],
      buttonLabel: 'Verify Email Address',
      buttonUrl: verificationUrl,
      securityTip: "If you didn't create an account with ClicsHQ please ignore this email.",
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Verification email sent to ${email}`);
  } catch (error) {
    console.error('Error sending verification email:', error);
    throw new Error('Failed to send verification email');
  }
}

export async function sendIntegrationRequestEmail(opts: {
  toEmail: string;
  displayName: string;
  productName: string;
  priority: string;
}) {
  const integrationsUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/apps-integrations`;
  const product = escapeHtml(opts.productName);

  const mailOptions = {
    from: MAIL_FROM,
    attachments: BASE_ATTACHMENTS,
    to: opts.toEmail,
    subject: `We received your ${opts.productName.replace(/[\r\n]+/g, ' ')} integration request`,
    html: buildEmailTemplate({
      title: 'Integration request received',
      heading: 'Integration request received',
      greeting: `Hi ${escapeHtml(opts.displayName)},`,
      paragraphs: [
        `Thanks for requesting a <strong style="color:${INK};">${product}</strong> integration.`,
        `Our product team will review it (priority: ${escapeHtml(opts.priority)}). We'll let you know on this email as soon as it launches.`,
      ],
      buttonLabel: 'View Integrations',
      buttonUrl: integrationsUrl,
      securityTip: "If you didn't make this request, you can safely ignore this email.",
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Integration request email sent to ${opts.toEmail}`);
  } catch (error) {
    console.error('Error sending integration request email:', error);
    throw new Error('Failed to send integration request email');
  }
}

export async function sendPasswordResetEmail(email: string, resetToken: string, displayName: string) {
  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${resetToken}`;

  const mailOptions = {
    from: MAIL_FROM,
    attachments: BASE_ATTACHMENTS,
    to: email,
    subject: 'Password reset request',
    html: buildEmailTemplate({
      title: 'Password reset request',
      heading: 'Password reset request',
      greeting: `Hi ${escapeHtml(displayName)},`,
      paragraphs: [
        'We received a request to reset your password for your ClicsHQ account.',
        'Use the button below to proceed. This link expires in 1 hour.',
      ],
      buttonLabel: 'Reset Password',
      buttonUrl: resetUrl,
      securityTip: "If you didn't request this, you can safely ignore this email or contact our team.",
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Password reset email sent to:', email);
  } catch (error) {
    console.error('Error sending password reset email:', error);
    throw error;
  }
}

export async function sendMemberInviteEmail(opts: {
  toEmail: string;
  inviterName: string;
  role: string;
  inviteLink: string;
  alreadyHasAccount?: boolean;
}) {
  const { toEmail, inviterName, role, inviteLink, alreadyHasAccount } = opts;
  const roleLabel = role === 'admin' ? 'an admin' : 'a member';
  const inviter = escapeHtml(inviterName);

  const mailOptions = {
    from: MAIL_FROM,
    attachments: BASE_ATTACHMENTS,
    to: toEmail,
    subject: `${inviterName} invited you to join ClicsHQ`,
    html: buildEmailTemplate({
      title: "You're invited to ClicsHQ",
      heading: "You're invited to ClicsHQ",
      greeting: 'Hi there,',
      paragraphs: [
        `<strong style="color:${INK};">${inviter}</strong> has invited you to join their workspace on ClicsHQ as ${roleLabel}.`,
        alreadyHasAccount
          ? "You already have a ClicsHQ account — just log in and you'll have access."
          : 'Click the button below to set up your account and get started.',
      ],
      buttonLabel: alreadyHasAccount ? 'Log in to ClicsHQ' : 'Accept Invitation',
      buttonUrl: inviteLink,
      securityTip: "If you weren't expecting this invitation, you can safely ignore this email.",
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Member invite email sent to ${toEmail}`);
  } catch (error) {
    console.error('Error sending member invite email:', error);
    // Don't throw — email failure shouldn't block the invite from being saved.
  }
}

interface SpaceInviteEmailOptions {
  toEmail: string;
  toName: string;
  spaceName: string;
  inviterName: string;
  inviteLink: string | null;
  isSoftSignup: boolean;
}

export async function sendSpaceInviteEmail(opts: SpaceInviteEmailOptions) {
  const { toEmail, toName, spaceName, inviterName, inviteLink, isSoftSignup } = opts;
  const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
  const inviter = escapeHtml(inviterName);
  const space = escapeHtml(spaceName);

  const mailOptions = {
    from: MAIL_FROM,
    attachments: BASE_ATTACHMENTS,
    to: toEmail,
    subject: isSoftSignup
      ? `${inviterName} invited you to join "${spaceName}" on ClicsHQ`
      : `You've been added to "${spaceName}" on ClicsHQ`,
    html: buildEmailTemplate({
      title: 'Setup account invitation to ClicsHQ',
      heading: isSoftSignup ? 'Setup account invitation to ClicsHQ' : "You've been added to a space",
      greeting: `Hi ${escapeHtml(toName)},`,
      paragraphs: [
        `<strong style="color:${INK};">${inviter}</strong> has invited you to collaborate on: <strong style="color:${INK};">${space}</strong>`,
        isSoftSignup
          ? 'To get started, click the button below to set up your ClicsHQ account.'
          : 'You can now log in to ClicsHQ and open the space directly.',
      ],
      buttonLabel: isSoftSignup ? 'Accept collaboration invitation' : 'Go to ClicsHQ',
      buttonUrl: inviteLink || loginUrl,
      securityTip: "If you weren't expecting this invitation, you can safely ignore this email.",
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Space invite email sent to ${toEmail}`);
  } catch (error) {
    console.error("Error sending space invite email:", error);
    throw new Error("Failed to send invite email");
  }
}

export async function sendMentionNotificationEmail(
  toEmail: string,
  toName: string,
  mentionedBy: string,
  taskName: string,
  spaceName: string,
  commentContent: string,
  taskUrl: string,
  opts?: { avatarUrl?: string | null; age?: string }
) {
  const by = escapeHtml(mentionedBy);

  const mailOptions = {
    from: MAIL_FROM,
    attachments: [...BASE_ATTACHMENTS, taskIconAttachment],
    to: toEmail,
    subject: `${mentionedBy} mentioned you in a comment on "${taskName}"`,
    html: buildEmailTemplate({
      title: "You're mentioned in a comment",
      heading: "You're mentioned in a comment",
      greeting: `Hi ${escapeHtml(toName)},`,
      paragraphs: [
        `<strong style="color:${INK};">${by}</strong> mentioned you in a comment in <strong style="color:${INK};">${escapeHtml(spaceName)}</strong>. Please review the details below and get started.`,
      ],
      block: entityCard({
        iconCid: ICON_TASK_CID,
        type: 'Task',
        name: escapeHtml(taskName),
        inner: commentBlock({
          author: by,
          avatarUrl: opts?.avatarUrl ?? null,
          age: opts?.age ?? 'just now',
          body: escapeHtml(commentContent),
        }),
      }),
      buttonLabel: 'View Comment',
      buttonUrl: taskUrl,
      securityTip: "If you weren't expecting this notification, you can safely ignore this email.",
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Mention notification email sent to ${toEmail}`);
  } catch (error) {
    console.error('Error sending mention email:', error);
    // Don't throw - email failure shouldn't block comment creation
  }
}

/** Mention inside a document comment — same shell, document card instead of a task. */
export async function sendDocumentMentionEmail(opts: {
  toEmail: string;
  toName: string;
  mentionedBy: string;
  documentName: string;
  commentContent: string;
  documentUrl: string;
  avatarUrl?: string | null;
  age?: string;
}) {
  const by = escapeHtml(opts.mentionedBy);
  const doc = escapeHtml(opts.documentName);

  const mailOptions = {
    from: MAIL_FROM,
    attachments: [...BASE_ATTACHMENTS, docIconAttachment],
    to: opts.toEmail,
    subject: `${opts.mentionedBy} mentioned you in "${opts.documentName}"`,
    html: buildEmailTemplate({
      title: "You're mentioned in a comment",
      heading: "You're mentioned in a comment",
      greeting: `Hi ${escapeHtml(opts.toName)},`,
      paragraphs: [
        `<strong style="color:${INK};">${by}</strong> mentioned you in a comment in <strong style="color:${INK};">${doc}</strong>. Please review the details below and get started.`,
      ],
      block: entityCard({
        iconCid: ICON_DOC_CID,
        type: 'Document',
        name: doc,
        inner: commentBlock({
          author: by,
          avatarUrl: opts.avatarUrl ?? null,
          age: opts.age ?? 'just now',
          body: escapeHtml(opts.commentContent),
        }),
      }),
      buttonLabel: 'Open Document',
      buttonUrl: opts.documentUrl,
      securityTip: "If you weren't expecting this notification, you can safely ignore this email.",
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Document mention email sent to ${opts.toEmail}`);
  } catch (error) {
    console.error('Error sending document mention email:', error);
  }
}

/** A task has been assigned — card lists project, due date, priority and people. */
export async function sendTaskAssignedEmail(opts: {
  toEmail: string;
  toName: string;
  assignedBy: string;
  taskName: string;
  taskUrl: string;
  projectName?: string | null;
  dueDate?: string | null;
  priority?: string | null;
  assigneeName?: string | null;
  reporterName?: string | null;
}) {
  const by = escapeHtml(opts.assignedBy);
  const rows: { label: string; value: string; pill?: 'plain' | 'danger' }[] = [];
  if (opts.projectName) rows.push({ label: 'Project', value: escapeHtml(opts.projectName) });
  if (opts.dueDate) rows.push({ label: 'Due', value: escapeHtml(opts.dueDate) });
  if (opts.priority) {
    rows.push({
      label: 'Priority',
      value: escapeHtml(opts.priority),
      pill: /^(high|urgent|critical)$/i.test(opts.priority) ? 'danger' : 'plain',
    });
  }
  if (opts.assigneeName) rows.push({ label: 'Assignee', value: escapeHtml(opts.assigneeName) });
  if (opts.reporterName) rows.push({ label: 'Reporter', value: escapeHtml(opts.reporterName) });

  const mailOptions = {
    from: MAIL_FROM,
    attachments: [...BASE_ATTACHMENTS, taskIconAttachment],
    to: opts.toEmail,
    subject: `${opts.assignedBy} assigned you "${opts.taskName}"`,
    html: buildEmailTemplate({
      title: 'A task was assigned to you',
      greeting: `Hi ${escapeHtml(opts.toName)},`,
      paragraphs: [
        `<strong style="color:${INK};">${by}</strong> has assigned you a task, please review the details below and get started.`,
      ],
      block: entityCard({
        iconCid: ICON_TASK_CID,
        type: 'Task',
        name: escapeHtml(opts.taskName),
        inner: rows.length ? detailRows(rows) : undefined,
      }),
      buttonLabel: 'Open Task',
      buttonUrl: opts.taskUrl,
      securityTip: "If you weren't expecting this notification, you can safely ignore this email.",
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Task assigned email sent to ${opts.toEmail}`);
  } catch (error) {
    console.error('Error sending task assigned email:', error);
  }
}

/** A task moved between statuses. */
export async function sendTaskStatusChangedEmail(opts: {
  toEmail: string;
  toName: string;
  changedBy: string;
  changedByRole?: string | null;
  taskName: string;
  taskUrl: string;
  previousStatus: string;
  newStatus: string;
  changedOn: string;
  changedAt?: string | null;
}) {
  const by = escapeHtml(opts.changedBy);

  const mailOptions = {
    from: MAIL_FROM,
    attachments: [...BASE_ATTACHMENTS, taskIconAttachment],
    to: opts.toEmail,
    subject: `"${opts.taskName}" moved to ${opts.newStatus}`,
    html: buildEmailTemplate({
      title: 'A task status changed',
      greeting: `Hi ${escapeHtml(opts.toName)},`,
      paragraphs: [
        `<strong style="color:${INK};">${by}</strong> changed the status of a task you follow, please review the details below.`,
      ],
      block: entityCard({
        iconCid: ICON_TASK_CID,
        type: 'Task',
        name: escapeHtml(opts.taskName),
        inner: statusChangeBlock({
          previousStatus: escapeHtml(opts.previousStatus),
          newStatus: escapeHtml(opts.newStatus),
          changedBy: by,
          changedByRole: opts.changedByRole ? escapeHtml(opts.changedByRole) : null,
          changedOn: escapeHtml(opts.changedOn),
          changedAt: opts.changedAt ? escapeHtml(opts.changedAt) : null,
        }),
      }),
      buttonLabel: 'View Task',
      buttonUrl: opts.taskUrl,
      securityTip: "If you weren't expecting this notification, you can safely ignore this email.",
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Task status email sent to ${opts.toEmail}`);
  } catch (error) {
    console.error('Error sending task status email:', error);
  }
}

/**
 * A subscription payment failed.
 *
 * NOT wired to anything today: Polar is merchant of record and owns renewals and
 * dunning, so it sends the live payment-failure mail. This exists so the design
 * is ready if dunning is ever brought in-house — see the note in
 * server/routes/billing.routes.ts.
 */
export async function sendPaymentFailedEmail(opts: {
  toEmail: string;
  toName: string;
  planName: string;
  amount: string;
  date: string;
  reason?: string;
  updatePaymentUrl: string;
}) {
  const mailOptions = {
    from: MAIL_FROM,
    attachments: BASE_ATTACHMENTS,
    to: opts.toEmail,
    subject: 'Action needed: your ClicsHQ payment failed',
    html: buildEmailTemplate({
      title: 'Your ClicsHQ payment failed',
      greeting: `Hi ${escapeHtml(opts.toName)},`,
      paragraphs: [
        'We were unable to process your recent payment for your ClicsHQ subscription.',
        'Please update your payment method to continue uninterrupted access.',
      ],
      block: `
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;">
                  <tr>
                    <td style="border:1px solid ${HAIRLINE}; border-radius:12px; padding:6px 18px;">
                      ${detailRows([
                        { label: 'Plan', value: escapeHtml(opts.planName) },
                        { label: 'Amount', value: escapeHtml(opts.amount) },
                        { label: 'Date', value: escapeHtml(opts.date) },
                        { label: 'Reason', value: escapeHtml(opts.reason || 'Payment Failed'), pill: 'danger' },
                      ])}
                    </td>
                  </tr>
                </table>`,
      buttonLabel: 'Update Payment Method',
      buttonUrl: opts.updatePaymentUrl,
      securityTip: 'If you have already updated your payment details, you can safely ignore this email.',
    }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Payment failed email sent to ${opts.toEmail}`);
  } catch (error) {
    console.error('Error sending payment failed email:', error);
  }
}

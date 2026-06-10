import nodemailer from 'nodemailer';

// When no Gmail credentials are configured (e.g. local development), real SMTP
// auth fails with `Missing credentials for "PLAIN"`. Rather than crash every
// route that sends mail, fall back to a console "transport" that logs the email
// (and any verification/reset/invite link found in the body) to the terminal.
const hasEmailCredentials = Boolean(
  process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
);

function logEmailToConsole(mailOptions: any) {
  const links = String(mailOptions?.html ?? '').match(/https?:\/\/[^\s"'<)]+/g) || [];
  console.log('\n📧 [DEV EMAIL — not sent, no GMAIL credentials]');
  console.log(`   To:      ${mailOptions?.to}`);
  console.log(`   Subject: ${mailOptions?.subject}`);
  if (links.length) {
    console.log('   Links:');
    for (const link of links) console.log(`     → ${link}`);
  }
  console.log('');
  return { messageId: 'dev-console-transport', accepted: [mailOptions?.to] };
}

// Configure Gmail transporter (real) or a console fallback (dev, no credentials)
const transporter = hasEmailCredentials
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER, // your-email@gmail.com
        pass: process.env.GMAIL_APP_PASSWORD, // App password (not regular password)
      },
    })
  : ({ sendMail: async (mailOptions: any) => logEmailToConsole(mailOptions) } as any);

if (!hasEmailCredentials) {
  console.warn(
    '⚠️  No GMAIL_USER / GMAIL_APP_PASSWORD set — emails will be logged to the console instead of sent. ' +
      'Verification/reset/invite links will appear in this terminal.'
  );
}

export async function send2FACodeEmail(
  email: string,
  code: string,
  displayName: string,
  action: "enable" | "disable"
) {
  const actionText = action === "enable" ? "enable" : "disable";

  const mailOptions = {
    from: `"ClicsHQ" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `Your ClicsHQ verification code`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #000; color: #fff; padding: 28px 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .header h1 { margin: 0; font-size: 22px; }
            .content { background: #fafafa; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #e5e7eb; }
            .code-box { background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px; text-align: center; margin: 24px 0; }
            .code { font-size: 36px; font-weight: 700; letter-spacing: 10px; color: #111; font-family: monospace; }
            .footer { text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>ClicsHQ</h1>
            </div>
            <div class="content">
              <h2>Hi ${displayName},</h2>
              <p>
                You requested to <strong>${actionText} two-factor authentication</strong> on your ClicsHQ account.
                Use the verification code below to complete the process.
              </p>
              <div class="code-box">
                <div class="code">${code}</div>
              </div>
              <p><strong>This code expires in 10 minutes.</strong></p>
              <p>If you didn't request to ${actionText} 2FA, please ignore this email. Your account remains secure.</p>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} ClicsHQ. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`2FA ${actionText} email sent to ${email}`);
  } catch (error) {
    console.error(`Error sending 2FA ${actionText} email:`, error);
    throw new Error(`Failed to send 2FA verification email`);
  }
}

export async function sendVerificationEmail(
  email: string,
  token: string,
  displayName: string
) {
  const verificationUrl = `${process.env.APP_URL || 'http://localhost:5000'}/verify-email?token=${token}`;

  const mailOptions = {
    from: `"ClicsHQ" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Verify your ClicsHQ account',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .button { display: inline-block; padding: 15px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Welcome to ClicsHQ! 🎉</h1>
            </div>
            <div class="content">
              <h2>Hi ${displayName},</h2>
              <p>Thanks for signing up! We're excited to have you on board.</p>
              <p>Please verify your email address by clicking the button below:</p>
              <div style="text-align: center;">
                <a href="${verificationUrl}" class="button">Verify Email Address</a>
              </div>
              <p>Or copy and paste this link into your browser:</p>
              <p style="background: #fff; padding: 10px; border-radius: 5px; word-break: break-all;">
                ${verificationUrl}
              </p>
              <p><strong>This link will expire in 24 hours.</strong></p>
              <p>If you didn't create an account with ClicsHQ, please ignore this email.</p>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} ClicsHQ. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Verification email sent to ${email}`);
  } catch (error) {
    console.error('Error sending verification email:', error);
    throw new Error('Failed to send verification email');
  }
}

export async function sendPasswordResetEmail(email: string, resetToken: string, displayName: string) {
  const resetUrl = `${process.env.APP_URL || 'http://localhost:5000'}/reset-password?token=${resetToken}`;

  const mailOptions = {
    from: `"${process.env.APP_NAME || 'Your App'}" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: 'Reset Your Password',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #000; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 30px; background-color: #c1ff72; color: #000; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
            .warning { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Password Reset Request</h1>
            </div>
            <div class="content">
              <p>Hi ${displayName},</p>
              <p>We received a request to reset your password. Click the button below to create a new password:</p>
              <div style="text-align: center;">
                <a href="${resetUrl}" class="button">Reset Password</a>
              </div>
              <p>Or copy and paste this link into your browser:</p>
              <p style="word-break: break-all; color: #666;">${resetUrl}</p>
              <div class="warning">
                <strong>⚠️ Security Notice:</strong>
                <p style="margin: 5px 0 0 0;">This link will expire in 1 hour. If you didn't request a password reset, please ignore this email and your password will remain unchanged.</p>
              </div>
              <p>For security reasons, we recommend that you:</p>
              <ul>
                <li>Choose a strong, unique password</li>
                <li>Never share your password with anyone</li>
              </ul>
            </div>
            <div class="footer">
              <p>If you have any questions or concerns, please contact our support team.</p>
              <p>&copy; ${new Date().getFullYear()} ${process.env.APP_NAME || 'Your App'}. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Password reset email sent to:', email);
  } catch (error) {
    console.error('Error sending password reset email:', error);
    throw error;
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

  const subject = isSoftSignup
    ? `${inviterName} invited you to join "${spaceName}" on ClicsHQ`
    : `You've been added to "${spaceName}" on ClicsHQ`;

  const ctaBlock = inviteLink
    ? `
      <div style="text-align: center; margin: 30px 0;">
        <a href="${inviteLink}" class="button" style="display:inline-block;padding:15px 30px;background:#000;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;">
          Accept Invitation & Set Up Account
        </a>
      </div>
      <p>Or paste this link in your browser:</p>
      <p style="background:#f3f4f6;padding:10px;border-radius:6px;word-break:break-all;font-size:13px;">${inviteLink}</p>
      <p style="color:#6b7280;font-size:13px;"><strong>This link expires in 7 days.</strong></p>
    `
    : `
      <p>You can now log in to ClicsHQ and access the space directly.</p>
      <div style="text-align:center;margin:30px 0;">
        <a href="${process.env.APP_URL || 'http://localhost:5000'}/login" class="button" style="display:inline-block;padding:15px 30px;background:#000;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;">
          Go to ClicsHQ
        </a>
      </div>
    `;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #111; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #000; color: #c1ff72; padding: 28px 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .header h1 { margin: 0; font-size: 24px; }
          .content { background: #fafafa; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #e5e7eb; }
          .space-badge { display:inline-block; background:#f3f4f6; border:1px solid #e5e7eb; border-radius:8px; padding:10px 18px; font-size:16px; font-weight:600; color:#111; margin:16px 0; }
          .footer { text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>ClicsHQ</h1>
          </div>
          <div class="content">
            <h2>Hi ${toName},</h2>
            <p>
              <strong>${inviterName}</strong> has invited you to collaborate on:
            </p>
            <div class="space-badge">🗂️ ${spaceName}</div>
            ${isSoftSignup
              ? `<p>To get started, click the button below to set up your ClicsHQ account. It only takes a minute!</p>`
              : `<p>You've been added to this space and can start collaborating right away.</p>`
            }
            ${ctaBlock}
          </div>
          <div class="footer">
            <p>If you weren't expecting this invitation, you can safely ignore this email.</p>
            <p>© ${new Date().getFullYear()} ClicsHQ. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  const mailOptions = {
    from: `"ClicsHQ" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject,
    html,
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
  taskUrl: string
) {
  const mailOptions = {
    from: `"ClicsHQ" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: `${mentionedBy} mentioned you in a comment on "${taskName}"`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1f2937; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #000; color: #c1ff72; padding: 28px 30px; text-align: center; border-radius: 12px 12px 0 0; }
            .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
            .content { background: #ffffff; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none; }
            .comment-box { background: #f9fafb; border-left: 4px solid #c1ff72; padding: 16px; margin: 20px 0; border-radius: 8px; }
            .comment-box p { margin: 0; color: #374151; font-size: 14px; }
            .task-link { display: inline-block; padding: 12px 24px; background: #000; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 500; margin: 20px 0; }
            .task-link:hover { background: #1f2937; }
            .footer { text-align: center; margin-top: 24px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px; }
            .space-badge { display: inline-block; background: #f3f4f6; padding: 4px 12px; border-radius: 16px; font-size: 13px; color: #374151; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>ClicsHQ</h1>
            </div>
            <div class="content">
              <h2 style="margin-top: 0; font-size: 18px;">Hi ${toName},</h2>
              <p><strong>${mentionedBy}</strong> mentioned you in a comment on task <strong>"${taskName}"</strong> in space <span class="space-badge">🗂️ ${spaceName}</span>.</p>

              <div class="comment-box">
                <p style="color: #6b7280; font-size: 12px; margin-bottom: 8px;">Comment:</p>
                <p style="margin: 0;">"${commentContent}"</p>
              </div>

              <div style="text-align: center;">
                <a href="${taskUrl}" class="task-link">View Comment →</a>
              </div>

              <p style="color: #6b7280; font-size: 13px;">Click the button above to see the comment and reply.</p>
            </div>
            <div class="footer">
              <p>You're receiving this because someone mentioned you in a comment.</p>
              <p>© ${new Date().getFullYear()} ClicsHQ. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Mention notification email sent to ${toEmail}`);
  } catch (error) {
    console.error('Error sending mention email:', error);
    // Don't throw - email failure shouldn't block comment creation
  }
}
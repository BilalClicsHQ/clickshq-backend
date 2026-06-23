import type { Express } from "express";
import { createServer, type Server } from "http";
import passport from "passport";
import { storage } from "./storage";
import { requireAuth, hashPassword, validatePassword, validateEmail, generateVerificationToken } from "./auth";
import { insertProjectSchema, updateProjectSchema, insertTeamMemberSchema, insertGoalSchema, updateGoalSchema, insertSprintSchema, updateSprintSchema, updateUserRoleSchema, projectStatusUpdates, projectBudgets, projectCosts, workspaceProjects, projectActivities, projectAttachments, insertProjectBudgetSchema, insertProjectCostSchema, users, projects, tasks, spaceInvitations, spaces, spaceFavourites, spaceRecentActivity, taskComments, taskFileAttachments, taskActivities } from "@shared/schema";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { z } from "zod";
import { isValidContextId } from "@shared/context-helpers";
import { db } from "./db";
import { eq, desc, sql, and } from "drizzle-orm";
import { sendPasswordResetEmail, sendVerificationEmail, send2FACodeEmail, sendMentionNotificationEmail } from "./email";
import crypto from 'crypto';
import { sendSpaceInviteEmail } from "./email";
import bcrypt from "bcrypt";
import * as otplib from 'otplib';
import QRCode from "qrcode";
// Workflows + Docs + Integrations (migrated from Nexus)
import workflowRoutes from "./routes/workflows.routes";
import { evaluateWorkflows } from "./services/workflowEngine";
import { registerDocsRoutes } from "./controllers/docs";
import aiRoutes from "./routes/ai.routes";
import { registerSlackRoutes } from "./controllers/slack/routes";
import integrationAuthRoutes from "./routes/integration-auth.routes";
import calendarRoutes from "./routes/calendar.routes";
import driveRoutes from "./routes/drive.routes";
import integrationSettingsRoutes from "./routes/integration-settings.routes";
import zapierRoutes from "./routes/zapier.routes";
import zapierPlatformRoutes from "./routes/zapier-platform.routes";
import githubRoutes from "./routes/github.routes";
import githubIntegrationRoutes from "./routes/github-integration.routes";
import githubWebhooksRoutes from "./routes/github-webhooks.routes";
import jiraRoutes from "./routes/jira.routes";
import jiraIntegrationRoutes from "./routes/jira-integration.routes";
import jiraWebhooksRoutes from "./routes/jira-webhooks.routes";
import fileAttachmentsRoutes from "./routes/file-attachments.routes";
import taskSubtasksChecklistsRoutes from "./routes/task-subtasks-checklists.routes";
import figmaRoutes from "./routes/figma.routes";
import figmaIntegrationRoutes from "./routes/figma-integration.routes";
import calendarIntegrationRoutes from "./routes/calendar-integration.routes";
import outlookIntegrationRoutes from "./routes/outlook-integration.routes";
import outlookEmailRoutes from "./routes/outlook-email.routes";
import outlookCalendarRoutes from "./routes/outlook-calendar.routes";
import teamsIntegrationRoutes from "./routes/teams-integration.routes";
import msTeamsRoutes from "./routes/ms-teams.routes";
import slackIntegrationRoutes from "./routes/slack-integration.routes";
import salesforceRoutes from "./routes/salesforce.routes";
import gmailRoutes from "./routes/gmail.routes";
import onedriveRoutes from "./routes/onedrive.routes";
import notificationRoutes from "./routes/notifications.routes";
import multer from "multer";
import { uploadFileToS3, copyS3Object, deleteS3Object } from "./services/s3Service";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const { authenticator } = otplib;

async function upsertRecentActivity(db: any, userId: string, spaceId: string) {
  const existing = await db
    .select()
    .from(spaceRecentActivity)
    .where(and(eq(spaceRecentActivity.userId, userId), eq(spaceRecentActivity.spaceId, spaceId)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(spaceRecentActivity)
      .set({ lastActivityAt: new Date() })
      .where(and(eq(spaceRecentActivity.userId, userId), eq(spaceRecentActivity.spaceId, spaceId)));
  } else {
    await db.insert(spaceRecentActivity).values({ userId, spaceId, lastActivityAt: new Date() });
  }
}

async function syncTaskAttachments(taskId: string, attachments: any[], userId: string): Promise<string[]> {
  try {
    const realDbAttachments = await storage.getTaskFileAttachments(taskId);

    const tempTaskIds = Array.from(new Set(
      attachments
        .filter(att => att && typeof att.taskId === "string" && att.taskId.startsWith("temp"))
        .map(att => att.taskId)
    ));

    const tempDbAttachments = [];
    for (const tempId of tempTaskIds) {
      const atts = await storage.getTaskFileAttachments(tempId);
      tempDbAttachments.push(...atts);
    }

    const allDbAttachments = [...realDbAttachments, ...tempDbAttachments];

    const incomingIds = attachments.filter(att => att && att.id).map(att => att.id);
    const deletedAttachments = allDbAttachments.filter(dbAtt => !incomingIds.includes(dbAtt.id));

    for (const del of deletedAttachments) {
      console.log(`[Sync S3] Deleting attachment ${del.name} (${del.id})`);
      if (del.provider === "s3" && del.externalId) {
        await deleteS3Object(del.externalId).catch(err => {
          console.error(`[Sync S3] Failed to delete key ${del.externalId} from S3:`, err);
        });
      }
      await storage.deleteFileAttachment(del.id).catch(err => {
        console.error(`[Sync DB] Failed to delete attachment record ${del.id}:`, err);
      });
    }

    const savedUrls: string[] = [];

    for (const incoming of attachments) {
      if (!incoming) continue;
      
      const dbRecord = allDbAttachments.find(d => d.id === incoming.id);
      if (!dbRecord) {
        if (incoming.externalUrl) {
          savedUrls.push(incoming.externalUrl);
        }
        continue;
      }

      if (dbRecord.taskId.startsWith("temp")) {
        const oldKey = dbRecord.externalId;
        const keyParts = oldKey.split("/");
        const filenameWithUuid = keyParts[keyParts.length - 1];
        const newKey = `tasks/${taskId}/${filenameWithUuid}`;
        
        const oldUrl = dbRecord.externalUrl || "";
        const bucketName = process.env.AWS_S3_BUCKET || "";
        const region = process.env.AWS_REGION || "us-east-1";
        const newUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${newKey}`;

        console.log(`[Sync S3] Re-parenting S3 file: ${oldKey} -> ${newKey}`);
        
        try {
          await copyS3Object(oldKey, newKey);
          await deleteS3Object(oldKey);

          await db
            .update(taskFileAttachments)
            .set({
              taskId: taskId,
              externalId: newKey,
              externalUrl: newUrl,
              downloadUrl: newUrl,
              embedUrl: newUrl,
              thumbnailUrl: dbRecord.mimeType?.startsWith("image/") ? newUrl : null,
              metadata: {
                ...(dbRecord.metadata as any || {}),
                s3Key: newKey,
              }
            })
            .where(eq(taskFileAttachments.id, dbRecord.id));
          
          savedUrls.push(newUrl);

          await db
            .update(taskActivities)
            .set({ taskId: taskId })
            .where(eq(taskActivities.taskId, dbRecord.taskId));
            
        } catch (err) {
          console.error(`[Sync S3] Failed to move S3 object ${oldKey}:`, err);
          savedUrls.push(oldUrl);
        }
      } else {
        savedUrls.push(dbRecord.externalUrl || "");
      }
    }

    return savedUrls;
  } catch (error) {
    console.error("[syncTaskAttachments Error]:", error);
    return [];
  }
}

const profileSettingsSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).optional().nullable().default(""),
  email: z.string().trim().email(),
  phone: z.string().trim().max(30).optional().nullable(),
  timezone: z.string().trim().min(1).max(100),
  profilePicture: z.string().trim().optional().nullable(),
});

const preferenceSettingsSchema = z.object({
  theme: z.enum(["light", "dark", "system", "Light", "Dark", "Auto"]).transform((v) => {
    const normalized = v.toLowerCase();
    return normalized === "auto" ? "system" : normalized;
  }),
  language: z.string().trim().min(2).max(20),
  dateFormat: z.string().trim().min(1).max(50),
  timeFormat: z.enum(["12h", "24h", "12", "24"])
    .transform(v => {
      if (v === "12") return "12h";
      if (v === "24") return "24h";
      return v as "12h" | "24h";
    }),
  weekFormat: z.enum(["sunday", "monday", "saturday"]),
});

const notificationSettingsSchema = z.object({
  emailNotifications: z.boolean(),
  inAppNotifications: z.boolean(),
  notifyTaskAssigned: z.boolean(),
  notifyMentions: z.boolean(),
  notifyComments: z.boolean(),
  notifyDueDateReminders: z.boolean(),
});

const email2faInitSchema = z.object({
  email: z.string().email(),
  password: z.string().optional().default(""),
});

const codeSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

const totpSetupSchema = z.object({
  email: z.string().email(),
  password: z.string().optional().default(""),
});

const totpVerifySchema = z.object({
  token: z.string().regex(/^\d{6}$/),
});

function generateNumericCode(length = 6) {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  const visible = name.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(name.length - 2, 2))}@${domain}`;
}

function generateBackupCodes(count = 10) {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

// Registers ALL API routes on the given app (no server creation).
// Used by both registerRoutes (dev) and registerRoutesServerless (Vercel).
async function registerAllRoutes(app: Express): Promise<void> {
  // Authentication Routes
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const { email, password, firstName, lastName, phone } = req.body;

      // Validate email
      const emailValidation = validateEmail(email);
      if (!emailValidation.isValid) {
        return res.status(400).json({ message: emailValidation.message });
      }

      // Validate password
      const passwordValidation = await validatePassword(password);
      if (!passwordValidation.isValid) {
        return res.status(400).json({ message: passwordValidation.message });
      }

      // Check if user already exists
      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        return res.status(400).json({ message: "An account with this email already exists." });
      }

      // Generate verification token
      const { token, expiry } = generateVerificationToken();

      // Hash password and create user
      const hashedPassword = await hashPassword(password);
      const displayName = `${firstName} ${lastName}`;

      const user = await storage.createUser({
        email,
        password: hashedPassword,
        displayName,
        firstName,
        lastName,
        phone,
        role: "admin",
        authProvider: "local",
        isEmailVerified: false,
        emailVerificationToken: token,
        emailVerificationExpiry: expiry,
      });

      // Send verification email
      await sendVerificationEmail(email, token, displayName);

      res.status(201).json({
        message: "Account created successfully!",
        email: user.email,
        requiresVerification: true,
      });
    } catch (error) {
      console.error("Signup error:", error);
      res.status(500).json({ message: "Failed to create account. Please try again." });
    }
  });

  app.get('/api/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
  );

  app.get('/api/auth/google/callback',
    passport.authenticate('google', {
      failureRedirect: '/login?error=google_auth_failed',
      session: true
    }),
    (req, res) => {
      const base = process.env.APP_URL || 'http://localhost:5000';
      const user = req.user as any;
      if (user && !user.hasCompletedOnboarding) {
        return res.redirect(`${base}/onboarding`);
      }
      res.redirect(base);
    }
  );

  // ========== MICROSOFT OAUTH ROUTES ==========
  app.get('/api/auth/microsoft',
    passport.authenticate('microsoft', { scope: ['user.read'] })
  );

  app.get('/api/auth/microsoft/callback',
    passport.authenticate('microsoft', {
      failureRedirect: '/login?error=microsoft_auth_failed',
      session: true
    }),
    (req, res) => {
      const base = process.env.APP_URL || 'http://localhost:5000';
      const user = req.user as any;
      if (user && !user.hasCompletedOnboarding) {
        return res.redirect(`${base}/onboarding`);
      }
      res.redirect(base);
    }
  );

  // Add verification endpoint
  app.get("/api/auth/verify-email", async (req, res) => {
    try {
      const { token } = req.query;

      if (!token || typeof token !== "string") {
        return res.status(400).json({
          success: false,
          message: "Invalid verification token."
        });
      }

      const user = await storage.verifyEmail(token);

      if (!user) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired verification token."
        });
      }

      // ✅ Auto-login the user after verification
      req.login(user, (err) => {
        if (err) {
          console.error("Login error after verification:", err);
          return res.json({
            success: true,
            message: "Email verified successfully! Please log in.",
            requiresLogin: true, // ✅ Flag to show login is needed
            redirect: "/login",
          });
        }

        // ✅ User is now logged in - send user data
        res.json({
          success: true,
          message: "Email verified successfully!",
          user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            role: user.role,
            profilePicture: user.profilePicture,
          },
          redirect: "/",
        });
      });
    } catch (error) {
      console.error("Email verification error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to verify email."
      });
    }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    passport.authenticate('local', async (err: any, user: any, info: any) => {
      if (err) {
        console.error('Authentication error:', err);
        return res.status(500).json({ message: 'Authentication system error. Please try again later.' });
      }
      if (!user) {
        const message = info?.message || 'Invalid email or password. Please check your credentials and try again.';
        return res.status(401).json({ message });
      }

      req.login(user, async (loginErr) => {
        if (loginErr) {
          console.error('Login error:', loginErr);
          return res.status(500).json({ message: 'Login session error. Please try again.' });
        }

        try {
          // Log the login activity
          await storage.logActivity({
            userId: user.id,
            action: 'login',
            details: JSON.stringify({ email: user.email }),
            ipAddress: req.ip || req.connection.remoteAddress,
            userAgent: req.headers['user-agent']
          });

          // Update user online status
          await storage.updateUserOnlineStatus(user.id, true);

          res.json({
            user: {
              id: user.id,
              email: user.email,
              displayName: user.displayName,
              role: user.role,
              profilePicture: user.profilePicture
            }
          });
        } catch (logError) {
          console.error('Error logging activity:', logError);
          // Still allow login even if logging fails
          res.json({
            user: {
              id: user.id,
              email: user.email,
              displayName: user.displayName,
              role: user.role,
              profilePicture: user.profilePicture
            }
          });
        }
      });
    })(req, res, next);
  });

  app.post('/api/auth/logout', async (req, res) => {
    const userId = (req.user as any)?.id;

    req.logout(async () => {
      if (userId) {
        try {
          // Log the logout activity
          await storage.logActivity({
            userId,
            action: 'logout',
            details: JSON.stringify({ timestamp: new Date().toISOString() }),
            ipAddress: req.ip || req.connection.remoteAddress,
            userAgent: req.headers['user-agent']
          });

          // Update user online status
          await storage.updateUserOnlineStatus(userId, false);
        } catch (error) {
          console.error('Error logging logout:', error);
        }
      }
      res.json({ message: 'Logged out successfully' });
    });
  });


  app.post('/api/auth/forgot-password', async (req, res) => {
    try {
      const { email } = req.body;

      // Validate email
      const emailValidation = validateEmail(email);
      if (!emailValidation.isValid) {
        return res.status(400).json({ message: emailValidation.message });
      }

      const user = await storage.getUserByEmail(email);

      // Always return the same message to prevent user enumeration
      const successMessage = 'If an account with this email exists, a password reset link has been sent.';

      // If user doesn't exist, still return success message
      if (!user) {
        return res.json({ message: successMessage });
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Save token to database
      await storage.updateUserResetToken(user.id, resetToken, resetExpiry);

      // Send the password reset email
      try {
        await sendPasswordResetEmail(user.email, resetToken, user.displayName || user.email);
        console.log(`Password reset email sent to: ${user.email}`);
      } catch (emailError) {
        console.error('Error sending password reset email:', emailError);
        // Don't reveal email sending failure to prevent user enumeration
      }

      return res.json({ message: successMessage });
    } catch (error) {
      console.error('Forgot password error:', error);
      return res.status(500).json({
        message: 'Failed to process password reset request. Please try again later.'
      });
    }
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    try {
      const { token, newPassword } = req.body;

      // Validate password
      const passwordValidation = await validatePassword(newPassword);
      if (!passwordValidation.isValid) {
        return res.status(400).json({ message: passwordValidation.message });
      }

      const user = await storage.getUserByResetToken(token);
      if (!user) {
        return res.status(400).json({ message: 'Invalid or expired reset token.' });
      }

      // Hash new password and update user
      const hashedPassword = await hashPassword(newPassword);
      await storage.updateUser(user.id, { password: hashedPassword });
      await storage.clearResetToken(user.id);

      res.json({ message: 'Password reset successfully.' });
    } catch (error) {
      console.error('Reset password error:', error);
      res.status(500).json({ message: 'Failed to reset password.' });
    }
  });

  app.get('/api/auth/user', (req, res) => {
    if (req.isAuthenticated()) {
      res.json(req.user);
    } else {
      res.status(401).json({ message: 'Not authenticated' });
    }
  });

  // Onboarding Routes
  app.post('/api/onboarding/complete', requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const {
        role,
        useCase,
        managementArea,
        companyName,
        workspaceName,
        heardFrom,
        features,
        projectName,
        tasks: onboardingTasks,
        sections,
        layout,
        inviteEmails,
      } = req.body;

      // 1. Create company record
      const company = await storage.createCompany({
        name: companyName || workspaceName || 'My Company',
        ownerUserId: user.id,
        workRole: role || null,
        workFunction: managementArea || null,
        useCase: useCase || null,
        heardFrom: heardFrom || null,
      });

      // 2. Build statuses from sections (or defaults)
      const STATUS_COLORS = ['#6B7280', '#3B82F6', '#F59E0B', '#10B981', '#8B5CF6'];
      const rawSections: string[] = Array.isArray(sections) && sections.length > 0
        ? sections
        : ['To Do', 'In Progress', 'Done'];
      const statusList = rawSections.map((name, i) => ({
        name,
        colorCode: STATUS_COLORS[i] ?? STATUS_COLORS[STATUS_COLORS.length - 1],
        order: i,
      }));

      // 3. Create space with statuses
      const spaceName = projectName || workspaceName || 'My Workspace';
      const space = await storage.createSpace({
        name: spaceName,
        iconUrl: '📁',
        description: null,
        defaultPermission: 'full_access',
        privacy: 'private',
        memberIds: [user.id],
        teamIds: [],
        ownerId: user.id,
        companyId: company.id,
        statuses: statusList,
      });

      // 4. Fetch the created statuses to get their IDs
      const createdStatuses = await storage.getSpaceStatuses(space.id);
      const firstStatusId = createdStatuses[0]?.id;

      // 5. Create tasks under the first status
      if (firstStatusId && Array.isArray(onboardingTasks)) {
        for (let i = 0; i < onboardingTasks.length; i++) {
          const taskName = onboardingTasks[i];
          if (taskName && typeof taskName === 'string' && taskName.trim()) {
            await storage.createTask({
              spaceId: space.id,
              name: taskName.trim(),
              statusId: firstStatusId,
              ownerId: user.id,
              assigneeIds: [user.id],
              order: i,
            });
          }
        }
      }

      // 6. Update user with onboarding data + companyId
      await storage.updateUser(user.id, {
        hasCompletedOnboarding: true,
        companyId: company.id,
        onboardingUseCase: useCase,
        onboardingManagementArea: managementArea,
        onboardingHeardFrom: heardFrom,
        onboardingWorkspaceName: workspaceName,
        onboardingInterestedFeatures: features || [],
      });

      // 7. Link default space back to company
      await storage.updateCompany(company.id, { defaultSpaceId: space.id });

      // 8. Process invitations
      if (Array.isArray(inviteEmails) && inviteEmails.length > 0) {
        for (const invite of inviteEmails) {
          if (invite.email && validateEmail(invite.email).isValid) {
            await storage.createInvitation({
              email: invite.email,
              role: invite.role || 'user',
              invitedBy: user.id,
            });
          }
        }
      }

      res.json({ message: 'Onboarding completed successfully', companyId: company.id, spaceId: space.id });
    } catch (error) {
      console.error('Error completing onboarding:', error);
      res.status(500).json({ message: 'Failed to complete onboarding' });
    }
  });

  app.post('/api/onboarding/skip', requireAuth, async (req, res) => {
    try {
      const user = req.user as any;

      // Simply mark onboarding as completed without collecting data
      await storage.updateUser(user.id, {
        hasCompletedOnboarding: true
      });

      res.json({ message: 'Onboarding skipped successfully' });
    } catch (error) {
      console.error('Error skipping onboarding:', error);
      res.status(500).json({ message: 'Failed to skip onboarding' });
    }
  });

  // Company Routes
  app.get('/api/company', requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const company = await storage.getCompanyByOwner(user.id);
      if (!company) {
        return res.status(404).json({ message: 'Company not found' });
      }
      res.json(company);
    } catch (error) {
      console.error('Error fetching company:', error);
      res.status(500).json({ message: 'Failed to fetch company' });
    }
  });

  app.patch('/api/company', requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const company = await storage.getCompanyByOwner(user.id);
      if (!company) {
        return res.status(404).json({ message: 'Company not found' });
      }
      const updated = await storage.updateCompany(company.id, req.body);
      res.json(updated);
    } catch (error) {
      console.error('Error updating company:', error);
      res.status(500).json({ message: 'Failed to update company' });
    }
  });

  // Admin Routes - only accessible by admin and sub-admin users
  const requireAdminAccess = (req: any, res: any, next: any) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    const user = req.user;
    if (user.role !== 'admin' && user.role !== 'sub-admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    next();
  };

  app.get('/api/admin/users', requireAdminAccess, async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      // Remove password from response
      const sanitizedUsers = users.map(({ password, resetToken, resetTokenExpiry, ...user }) => user);
      res.json(sanitizedUsers);
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({ message: 'Failed to fetch users' });
    }
  });

  app.get('/api/admin/users/online', requireAdminAccess, async (req, res) => {
    try {
      const onlineUsers = await storage.getOnlineUsers();
      // Remove sensitive data from response
      const sanitizedUsers = onlineUsers.map(({ password, resetToken, resetTokenExpiry, ...user }) => user);
      res.json(sanitizedUsers);
    } catch (error) {
      console.error('Error fetching online users:', error);
      res.status(500).json({ message: 'Failed to fetch online users' });
    }
  });

  app.get('/api/admin/activity-logs', requireAdminAccess, async (req, res) => {
    try {
      const { userId, action, limit = 50, offset = 0 } = req.query;
      const logs = await storage.getActivityLogs({
        userId: userId as string,
        action: action as string,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string)
      });
      res.json(logs);
    } catch (error) {
      console.error('Error fetching activity logs:', error);
      res.status(500).json({ message: 'Failed to fetch activity logs' });
    }
  });

  app.get('/api/admin/login-stats', requireAdminAccess, async (req, res) => {
    try {
      const stats = await storage.getUserLoginStats();
      res.json(stats);
    } catch (error) {
      console.error('Error fetching login stats:', error);
      res.status(500).json({ message: 'Failed to fetch login statistics' });
    }
  });

  app.put('/api/admin/users/:id/role', requireAdminAccess, async (req, res) => {
    try {
      const currentUser = req.user as any;
      const targetUserId = req.params.id;

      // Only admin can change roles, not sub-admin
      if (currentUser.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can change user roles' });
      }

      const validatedData = updateUserRoleSchema.parse(req.body);
      const updatedUser = await storage.updateUserRole(targetUserId, validatedData.role);

      if (!updatedUser) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Log the role change activity
      await storage.logActivity({
        userId: currentUser.id,
        action: 'role_change',
        details: JSON.stringify({
          targetUserId,
          oldRole: 'unknown', // We'd need to fetch this first in a real implementation
          newRole: validatedData.role
        }),
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.headers['user-agent']
      });

      // Remove sensitive data from response
      const { password, resetToken, resetTokenExpiry, ...sanitizedUser } = updatedUser;
      res.json(sanitizedUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid role data', errors: error.errors });
      } else {
        console.error('Error updating user role:', error);
        res.status(500).json({ message: 'Failed to update user role' });
      }
    }
  });

  // Invitations Routes
  app.post('/api/invites', requireAdminAccess, async (req, res) => {
    try {
      const currentUser = req.user as any;
      const { emails, role } = req.body;

      if (!emails || typeof emails !== 'string') {
        return res.status(400).json({ message: 'Email addresses are required' });
      }

      // Split emails by comma or space and clean them
      const emailList = emails
        .split(/[,\s]+/)
        .map((email: string) => email.trim())
        .filter((email: string) => email.length > 0);

      if (emailList.length === 0) {
        return res.status(400).json({ message: 'Please provide at least one valid email address' });
      }

      // Create invitations for each email
      const createdInvitations = [];
      for (const email of emailList) {
        const invitation = await storage.createInvitation({
          email,
          role: role || 'user',
          invitedBy: currentUser.id,
          status: 'pending'
        });
        createdInvitations.push(invitation);
      }

      // Log the invitation activity
      await storage.logActivity({
        userId: currentUser.id,
        action: 'invitations_sent',
        details: JSON.stringify({
          emails: emailList,
          role: role || 'user',
          count: emailList.length
        }),
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.headers['user-agent']
      });

      res.status(201).json({
        message: `${createdInvitations.length} invitation(s) sent successfully`,
        invitations: createdInvitations
      });
    } catch (error) {
      console.error('Error creating invitations:', error);
      res.status(500).json({ message: 'Failed to send invitations' });
    }
  });

  app.get('/api/invites', requireAdminAccess, async (req, res) => {
    try {
      const invitations = await storage.getInvitations();
      res.json(invitations);
    } catch (error) {
      console.error('Error fetching invitations:', error);
      res.status(500).json({ message: 'Failed to fetch invitations' });
    }
  });

  // Teams Routes
  app.get('/api/teams', async (req, res) => {
    try {
      const teams = await storage.getAllTeams();
      res.json(teams);
    } catch (error) {
      console.error('Error fetching teams:', error);
      res.status(500).json({ message: 'Failed to fetch teams' });
    }
  });

  app.post('/api/teams', requireAdminAccess, async (req, res) => {
    try {
      const { name, icon, color, description } = req.body;

      if (!name || !icon || !color) {
        return res.status(400).json({ message: 'Name, icon, and color are required' });
      }

      const newTeam = await storage.createTeam({
        name,
        icon,
        color,
        description: description || null,
      });

      // Create default kanban columns for new team
      const defaultColumns = [
        { teamId: newTeam.id, name: 'New task', color: '#8B5CF6', icon: '📋', order: 0, isDefault: true },
        { teamId: newTeam.id, name: 'Scheduled', color: '#3B82F6', icon: '📅', order: 1, isDefault: true },
        { teamId: newTeam.id, name: 'In Progress', color: '#F59E0B', icon: '🔨', order: 2, isDefault: true },
        { teamId: newTeam.id, name: 'Completed', color: '#10B981', icon: '✅', order: 3, isDefault: true },
      ];

      for (const column of defaultColumns) {
        await storage.createKanbanColumn(column);
      }

      // Log activity
      const currentUser = req.user as any;
      if (currentUser) {
        await storage.logActivity({
          userId: currentUser.id,
          action: 'team_created',
          details: JSON.stringify({ teamId: newTeam.id, teamName: newTeam.name }),
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      }

      res.status(201).json(newTeam);
    } catch (error) {
      console.error('Error creating team:', error);
      res.status(500).json({ message: 'Failed to create team' });
    }
  });

  // View Preferences Routes
  app.get('/api/teams/:teamId/view-preference', requireAuth, async (req, res) => {
    try {
      const { teamId } = req.params;
      const userId = (req.user as any).id;

      // Validate contextId format
      if (!isValidContextId(teamId)) {
        return res.status(400).json({ message: 'Invalid context ID format. Expected "dept:<name>" or "team:<uuid>"' });
      }

      const preference = await storage.getViewPreference(userId, teamId);

      if (!preference) {
        // Return default preference if none exists
        return res.json({ viewType: 'table' });
      }

      res.json({ viewType: preference.viewType });
    } catch (error) {
      console.error('Error fetching view preference:', error);
      res.status(500).json({ message: 'Failed to fetch view preference' });
    }
  });

  app.post('/api/teams/:teamId/view-preference', requireAuth, async (req, res) => {
    try {
      const { teamId } = req.params;
      const { viewType } = req.body;
      const userId = (req.user as any).id;

      // Validate contextId format
      if (!isValidContextId(teamId)) {
        return res.status(400).json({ message: 'Invalid context ID format. Expected "dept:<name>" or "team:<uuid>"' });
      }

      if (!viewType || !['table', 'kanban'].includes(viewType)) {
        return res.status(400).json({ message: 'Invalid view type. Must be "table" or "kanban"' });
      }

      const preference = await storage.setViewPreference(userId, teamId, viewType);
      res.json(preference);
    } catch (error) {
      console.error('Error setting view preference:', error);
      res.status(500).json({ message: 'Failed to set view preference' });
    }
  });

  // Kanban Columns Routes
  app.get('/api/teams/:teamId/kanban-columns', async (req, res) => {
    try {
      const { teamId } = req.params;

      // Validate contextId format
      if (!isValidContextId(teamId)) {
        return res.status(400).json({ message: 'Invalid context ID format. Expected "dept:<name>" or "team:<uuid>"' });
      }

      const columns = await storage.getKanbanColumns(teamId);
      res.json(columns);
    } catch (error) {
      console.error('Error fetching kanban columns:', error);
      res.status(500).json({ message: 'Failed to fetch kanban columns' });
    }
  });

  app.post('/api/teams/:teamId/kanban-columns', requireAdminAccess, async (req, res) => {
    try {
      const { teamId } = req.params;
      const { name, color, order } = req.body;

      // Validate contextId format
      if (!isValidContextId(teamId)) {
        return res.status(400).json({ message: 'Invalid context ID format. Expected "dept:<name>" or "team:<uuid>"' });
      }

      if (!name) {
        return res.status(400).json({ message: 'Column name is required' });
      }

      const column = await storage.createKanbanColumn({
        teamId,
        name,
        color: color || '#6B7280',
        order: order || 0,
        isDefault: false,
      });

      res.status(201).json(column);
    } catch (error) {
      console.error('Error creating kanban column:', error);
      res.status(500).json({ message: 'Failed to create kanban column' });
    }
  });

  app.put('/api/kanban-columns/:id', requireAdminAccess, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;

      const column = await storage.updateKanbanColumn(id, updates);

      if (!column) {
        return res.status(404).json({ message: 'Column not found' });
      }

      res.json(column);
    } catch (error) {
      console.error('Error updating kanban column:', error);
      res.status(500).json({ message: 'Failed to update kanban column' });
    }
  });

  app.delete('/api/kanban-columns/:id', requireAdminAccess, async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await storage.deleteKanbanColumn(id);

      if (!deleted) {
        return res.status(404).json({ message: 'Column not found' });
      }

      res.json({ message: 'Column deleted successfully' });
    } catch (error) {
      console.error('Error deleting kanban column:', error);
      res.status(500).json({ message: 'Failed to delete kanban column' });
    }
  });

  // Team Members Routes
  app.get("/api/team-members", async (_req, res) => {
    try {
      const members = await storage.getAllTeamMembers();
      res.json(members);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch team members" });
    }
  });

  app.post("/api/team-members", async (req, res) => {
    try {
      const validatedData = insertTeamMemberSchema.parse(req.body);
      const member = await storage.createTeamMember(validatedData);
      res.status(201).json(member);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to create team member" });
      }
    }
  });

  // Projects Routes
  app.get("/api/projects", async (req, res) => {
    try {
      const { department, status, owner, search } = req.query;

      let projects;
      if (search) {
        projects = await storage.searchProjects(search as string);
      } else if (department) {
        projects = await storage.getProjectsByDepartment(department as string);
      } else if (status) {
        projects = await storage.getProjectsByStatus(status as string);
      } else if (owner) {
        projects = await storage.getProjectsByOwner(owner as string);
      } else {
        projects = await storage.getAllProjects();
      }

      res.json(projects);
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({ message: "Failed to fetch projects", error: String(error) });
    }
  });

  app.get("/api/projects/:id", async (req, res) => {
    try {
      const project = await storage.getProject(req.params.id);
      if (!project) {
        res.status(404).json({ message: "Project not found" });
        return;
      }
      res.json(project);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch project" });
    }
  });

  app.post("/api/projects", async (req, res) => {
    try {
      console.log("Creating project with data:", req.body);
      const validatedData = insertProjectSchema.parse(req.body);
      console.log("Validated data:", validatedData);
      const project = await storage.createProject(validatedData);
      res.status(201).json(project);
    } catch (error) {
      console.error("Error creating project:", error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to create project", error: String(error) });
      }
    }
  });

  app.patch("/api/projects/:id", async (req, res) => {
    try {
      const validatedData = updateProjectSchema.parse(req.body);
      const project = await storage.updateProject(req.params.id, validatedData);
      if (!project) {
        res.status(404).json({ message: "Project not found" });
        return;
      }
      res.json(project);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to update project" });
      }
    }
  });

  app.delete("/api/projects/:id", async (req, res) => {
    try {
      const success = await storage.deleteProject(req.params.id);
      if (!success) {
        res.status(404).json({ message: "Project not found" });
        return;
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete project" });
    }
  });

  // Metrics Route
  app.get("/api/metrics", async (_req, res) => {
    try {
      const metrics = await storage.getProjectMetrics();
      res.json(metrics);
    } catch (error) {
      console.error("Error fetching metrics:", error);
      res.status(500).json({ message: "Failed to fetch metrics", error: String(error) });
    }
  });

  // Dependency Routes
  app.get("/api/projects/:id/dependencies", async (req, res) => {
    try {
      const dependencyInfo = await storage.getDependencyInfo(req.params.id);
      res.json(dependencyInfo);
    } catch (error) {
      console.error("Error fetching dependency info:", error);
      res.status(500).json({ message: "Failed to fetch dependency information" });
    }
  });

  app.post("/api/projects/:id/validate-dependencies", async (req, res) => {
    try {
      const { dependencies } = req.body;
      await storage.validateAndBlockIfNeeded(req.params.id, dependencies);
      res.json({ success: true });
    } catch (error) {
      console.error("Error validating dependencies:", error);
      res.status(500).json({ message: "Failed to validate dependencies" });
    }
  });

  // Goals Routes
  app.get("/api/goals", async (_req, res) => {
    try {
      const goals = await storage.getAllGoals();
      res.json(goals);
    } catch (error) {
      console.error("Error fetching goals:", error);
      res.status(500).json({ message: "Failed to fetch goals" });
    }
  });

  app.get("/api/goals/:id", async (req, res) => {
    try {
      const goal = await storage.getGoal(req.params.id);
      if (!goal) {
        res.status(404).json({ message: "Goal not found" });
        return;
      }
      res.json(goal);
    } catch (error) {
      console.error("Error fetching goal:", error);
      res.status(500).json({ message: "Failed to fetch goal" });
    }
  });

  app.get("/api/goals/:id/progress", async (req, res) => {
    try {
      const progress = await storage.getGoalProgress(req.params.id);
      res.json(progress);
    } catch (error) {
      console.error("Error fetching goal progress:", error);
      res.status(500).json({ message: "Failed to fetch goal progress" });
    }
  });

  app.post("/api/goals", async (req, res) => {
    try {
      const validatedData = insertGoalSchema.parse(req.body);
      const goal = await storage.createGoal(validatedData);
      res.status(201).json(goal);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid data", errors: error.errors });
      } else {
        console.error("Error creating goal:", error);
        res.status(500).json({ message: "Failed to create goal" });
      }
    }
  });

  app.put("/api/goals/:id", async (req, res) => {
    try {
      const validatedData = updateGoalSchema.parse(req.body);
      const goal = await storage.updateGoal(req.params.id, validatedData);
      if (!goal) {
        res.status(404).json({ message: "Goal not found" });
        return;
      }
      res.json(goal);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid data", errors: error.errors });
      } else {
        console.error("Error updating goal:", error);
        res.status(500).json({ message: "Failed to update goal" });
      }
    }
  });

  app.delete("/api/goals/:id", async (req, res) => {
    try {
      const success = await storage.deleteGoal(req.params.id);
      if (!success) {
        res.status(404).json({ message: "Goal not found" });
        return;
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting goal:", error);
      res.status(500).json({ message: "Failed to delete goal" });
    }
  });

  // Sprints Routes
  app.get("/api/sprints", async (_req, res) => {
    try {
      const sprints = await storage.getAllSprints();
      res.json(sprints);
    } catch (error) {
      console.error("Error fetching sprints:", error);
      res.status(500).json({ message: "Failed to fetch sprints" });
    }
  });

  app.get("/api/sprints/:id", async (req, res) => {
    try {
      const sprint = await storage.getSprint(req.params.id);
      if (!sprint) {
        res.status(404).json({ message: "Sprint not found" });
        return;
      }
      res.json(sprint);
    } catch (error) {
      console.error("Error fetching sprint:", error);
      res.status(500).json({ message: "Failed to fetch sprint" });
    }
  });

  app.get("/api/sprints/:id/progress", async (req, res) => {
    try {
      const progress = await storage.getSprintProgress(req.params.id);
      res.json(progress);
    } catch (error) {
      console.error("Error fetching sprint progress:", error);
      res.status(500).json({ message: "Failed to fetch sprint progress" });
    }
  });

  app.post("/api/sprints", async (req, res) => {
    try {
      const validatedData = insertSprintSchema.parse(req.body);
      const sprint = await storage.createSprint(validatedData);
      res.status(201).json(sprint);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid data", errors: error.errors });
      } else {
        console.error("Error creating sprint:", error);
        res.status(500).json({ message: "Failed to create sprint" });
      }
    }
  });

  app.put("/api/sprints/:id", async (req, res) => {
    try {
      const validatedData = updateSprintSchema.parse(req.body);
      const sprint = await storage.updateSprint(req.params.id, validatedData);
      if (!sprint) {
        res.status(404).json({ message: "Sprint not found" });
        return;
      }
      res.json(sprint);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid data", errors: error.errors });
      } else {
        console.error("Error updating sprint:", error);
        res.status(500).json({ message: "Failed to update sprint" });
      }
    }
  });

  app.delete("/api/sprints/:id", async (req, res) => {
    try {
      const success = await storage.deleteSprint(req.params.id);
      if (!success) {
        res.status(404).json({ message: "Sprint not found" });
        return;
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting sprint:", error);
      res.status(500).json({ message: "Failed to delete sprint" });
    }
  });

  app.post("/api/sprints/:id/assign-tasks", async (req, res) => {
    try {
      const { taskIds } = req.body;
      await storage.assignTasksToSprint(req.params.id, taskIds);
      res.json({ success: true });
    } catch (error) {
      console.error("Error assigning tasks to sprint:", error);
      res.status(500).json({ message: "Failed to assign tasks to sprint" });
    }
  });

  app.post("/api/sprints/:id/auto-assign", async (req, res) => {
    try {
      const criteria = req.body;
      const assignedTaskIds = await storage.autoAssignTasksToSprint(req.params.id, criteria);
      res.json({ assignedTaskIds, count: assignedTaskIds.length });
    } catch (error) {
      console.error("Error auto-assigning tasks to sprint:", error);
      res.status(500).json({ message: "Failed to auto-assign tasks to sprint" });
    }
  });

  // Calendar Routes
  app.put("/api/projects/:id/schedule", async (req, res) => {
    try {
      const { scheduledDate } = req.body;
      const project = await storage.updateProject(req.params.id, { scheduledDate });
      if (!project) {
        res.status(404).json({ message: "Project not found" });
        return;
      }
      res.json(project);
    } catch (error) {
      console.error("Error scheduling project:", error);
      res.status(500).json({ message: "Failed to schedule project" });
    }
  });

  // User Profile Routes
  app.patch("/api/users/profile", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ message: "Not authenticated" });
        return;
      }

      const updates = req.body;
      const updatedUser = await storage.updateUser(userId, updates);

      if (!updatedUser) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      res.json(updatedUser);
    } catch (error) {
      console.error("Error updating user profile:", error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });

  app.post("/api/users/change-password", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ message: "Not authenticated" });
        return;
      }

      const { currentPassword, newPassword } = req.body;

      // Get current user
      const user = await storage.getUser(userId);
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      // Verify current password
      const bcrypt = await import('bcrypt');
      const isValidPassword = await bcrypt.compare(currentPassword, user.password || "");
      if (!isValidPassword) {
        res.status(400).json({ message: "Current password is incorrect" });
        return;
      }

      // Validate new password
      const passwordValidation = await validatePassword(newPassword);
      if (!passwordValidation.isValid) {
        res.status(400).json({ message: passwordValidation.message });
        return;
      }

      // Hash new password
      const hashedPassword = await hashPassword(newPassword);

      // Update password
      await storage.updateUser(userId, { password: hashedPassword });

      res.json({ message: "Password changed successfully" });
    } catch (error) {
      console.error("Error changing password:", error);
      res.status(500).json({ message: "Failed to change password" });
    }
  });

  // Documents Routes — migrated to advanced Nexus docs controller (registerDocsRoutes, mounted below).
  // ==================== TASK COMMENTS ROUTES ====================

  app.get("/api/tasks/:taskId/comments", requireAuth, async (req, res) => {
    try {
      const { taskId } = req.params;
      const comments = await db.select().from(taskComments).where(eq(taskComments.taskId, taskId)).orderBy(taskComments.createdAt);
      const userIds = [...new Set(comments.map((c: any) => c.userId))];
      let userMap: Record<string, any> = {};
      if (userIds.length > 0) {
        const commentUsers = await db.select({ id: users.id, displayName: users.displayName, profilePicture: users.profilePicture, firstName: users.firstName, lastName: users.lastName }).from(users);
        commentUsers.filter((u: any) => userIds.includes(u.id)).forEach((u: any) => { userMap[u.id] = u; });
      }
      const enriched = comments.map((c: any) => ({ ...c, user: userMap[c.userId] || null }));
      res.json(enriched);
    } catch (error) { console.error("Error fetching task comments:", error); res.status(500).json({ message: "Failed to fetch task comments" }); }
  });

// routes.ts mein POST /api/tasks/:taskId/comments ko replace karo:

app.post("/api/tasks/:taskId/comments", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const currentUser = req.user as any;
    const { taskId } = req.params;
    const { content, mentionedUserIds } = req.body;

    if (!content?.trim()) {
      return res.status(400).json({ message: "Comment content is required" });
    }

    // Create comment
    const [comment] = await db.insert(taskComments).values({
      taskId,
      userId,
      content: content.trim(),
      mentionedUserIds: mentionedUserIds || []
    }).returning();

    // ✅ SEND EMAILS TO MENTIONED USERS
    if (mentionedUserIds && mentionedUserIds.length > 0) {
      try {
        // Get task details
        const taskResult = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
        const taskData = taskResult[0];

        if (taskData) {
          // Get space details
          const spaceResult = await db.select().from(spaces).where(eq(spaces.id, taskData.spaceId)).limit(1);
          const spaceData = spaceResult[0];

          // Get mentioned users' emails
          const mentionedUsers = await db.select({
            id: users.id,
            email: users.email,
            displayName: users.displayName
          }).from(users).where(sql`${users.id} IN (${mentionedUserIds.join(',')})`);

          // Import email function
          const { sendMentionNotificationEmail } = await import('./email');

          // Send email to each mentioned user
          for (const mentionedUser of mentionedUsers) {
            // Don't send email to yourself
            if (mentionedUser.id !== userId && mentionedUser.email) {
              // Extract mentioned name from content (first mention)
              const mentionMatch = content.match(/@([a-zA-Z0-9_\s]+?)(?=\s|$)/);
              const mentionedByName = mentionMatch ? mentionMatch[1].trim() : mentionedUser.displayName;

              await sendMentionNotificationEmail(
                mentionedUser.email,
                mentionedUser.displayName || mentionedUser.email.split('@')[0],
                currentUser.displayName || currentUser.email?.split('@')[0] || 'Someone',
                taskData.name,
                spaceData?.name || 'a space',
                content.trim(),
                `${process.env.APP_URL || 'http://localhost:5000'}/task/${taskId}`
              ).catch(err => console.error(`Failed to send mention email to ${mentionedUser.email}:`, err));
            }
          }
        }
      } catch (emailError) {
        console.error("Error sending mention emails:", emailError);
        // Don't fail the comment creation if email fails
      }
    }

    // Get user data for response
    const [user] = await db.select({
      id: users.id,
      displayName: users.displayName,
      profilePicture: users.profilePicture,
      firstName: users.firstName,
      lastName: users.lastName
    }).from(users).where(eq(users.id, userId));

    res.status(201).json({ ...comment, user: user || null });

  } catch (error) {
    console.error("Error creating task comment:", error);
    res.status(500).json({ message: "Failed to create task comment" });
  }
});

  app.delete("/api/tasks/:taskId/comments/:commentId", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const { commentId } = req.params;
      const [existing] = await db.select().from(taskComments).where(eq(taskComments.id, commentId));
      if (!existing) return res.status(404).json({ message: "Comment not found" });
      if (existing.userId !== userId) return res.status(403).json({ message: "Not authorized" });
      await db.delete(taskComments).where(eq(taskComments.id, commentId));
      res.status(204).send();
    } catch (error) { console.error("Error deleting task comment:", error); res.status(500).json({ message: "Failed to delete task comment" }); }
  });

    // PATCH /api/tasks/:taskId/comments/:commentId - Update comment
app.patch("/api/tasks/:taskId/comments/:commentId", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { commentId } = req.params;
    const { content } = req.body;

    if (!content?.trim()) {
      return res.status(400).json({ message: "Comment content is required" });
    }

    // Check if comment exists and user owns it
    const [existing] = await db.select().from(taskComments).where(eq(taskComments.id, commentId));
    if (!existing) {
      return res.status(404).json({ message: "Comment not found" });
    }
    if (existing.userId !== userId) {
      return res.status(403).json({ message: "Not authorized to edit this comment" });
    }

    // Update comment
    const [updatedComment] = await db
      .update(taskComments)
      .set({ content: content.trim(), updatedAt: new Date() })
      .where(eq(taskComments.id, commentId))
      .returning();

    // Get user data for response
    const [user] = await db.select({
      id: users.id,
      displayName: users.displayName,
      profilePicture: users.profilePicture,
      firstName: users.firstName,
      lastName: users.lastName
    }).from(users).where(eq(users.id, userId));

    res.json({ ...updatedComment, user: user || null });

  } catch (error) {
    console.error("Error updating comment:", error);
    res.status(500).json({ message: "Failed to update comment" });
  }
});

  // ==================== SPACES CRUD ROUTES ====================

// GET all spaces for the authenticated user
app.get("/api/spaces", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const companyId = (req.user as any)?.companyId;
    const spaces = await storage.getSpacesForUser(userId, companyId);
    res.json(spaces);
  } catch (error) {
    console.error("Error fetching spaces:", error);
    res.status(500).json({ message: "Failed to fetch spaces" });
  }
});

  // GET /api/spaces/favourites — get favourite spaces for current user
  app.get("/api/spaces/favourites", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const userId = user?.id;
      const companyId = user?.companyId;
      const favRows = await db
        .select()
        .from(spaceFavourites)
        .where(eq(spaceFavourites.userId, userId));

      const spaceIds = favRows.map((r: any) => r.spaceId);
      if (spaceIds.length === 0) return res.json([]);

      const favSpaces = await Promise.all(spaceIds.map((id: string) => storage.getSpace(id)));
      const filtered = favSpaces.filter((space): space is NonNullable<typeof space> => Boolean(space)).filter(space => !space.companyId || space.companyId === companyId);
      res.json(filtered);
    } catch (error) {
      console.error("Error fetching favourite spaces:", error);
      res.status(500).json({ message: "Failed to fetch favourite spaces" });
    }
  });

  // POST /api/spaces/:id/favourite — toggle favourite
  app.post("/api/spaces/:id/favourite", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const spaceId = req.params.id;

      const existing = await db
        .select()
        .from(spaceFavourites)
        .where(and(eq(spaceFavourites.userId, userId), eq(spaceFavourites.spaceId, spaceId)))
        .limit(1);

      if (existing.length > 0) {
        await db
          .delete(spaceFavourites)
          .where(and(eq(spaceFavourites.userId, userId), eq(spaceFavourites.spaceId, spaceId)));
        return res.json({ favourited: false, spaceId });
      } else {
        await db.insert(spaceFavourites).values({ userId, spaceId });
        return res.json({ favourited: true, spaceId });
      }
    } catch (error) {
      console.error("Error toggling favourite:", error);
      res.status(500).json({ message: "Failed to toggle favourite" });
    }
  });

  // GET /api/spaces/recent — get recently active spaces for current user (max 4)
  app.get("/api/spaces/recent", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      const userId = user?.id;
      const companyId = user?.companyId;
      const recentRows = await db
        .select()
        .from(spaceRecentActivity)
        .where(eq(spaceRecentActivity.userId, userId))
        .orderBy(desc(spaceRecentActivity.lastActivityAt))
        .limit(4);

      if (recentRows.length === 0) return res.json([]);

      const recentSpaces = await Promise.all(
        recentRows.map((r: any) => storage.getSpace(r.spaceId))
      );
      const filtered = recentSpaces.filter((space): space is NonNullable<typeof space> => Boolean(space)).filter(space => !space.companyId || space.companyId === companyId);
      res.json(filtered);
    } catch (error) {
      console.error("Error fetching recent spaces:", error);
      res.status(500).json({ message: "Failed to fetch recent spaces" });
    }
  });

// GET single space by ID
app.get("/api/spaces/:id", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const space = await storage.getSpace(req.params.id);
    if (!space) {
      return res.status(404).json({ message: "Space not found" });
    }
    if (space.companyId && space.companyId !== user.companyId) {
      return res.status(403).json({ message: "Access denied: this space belongs to another company" });
    }

    // Upsert recent activity for the user viewing this space
    upsertRecentActivity(db, user.id, space.id).catch((err) => {
      console.error("Error upserting recent activity:", err);
    });

    res.json(space);
  } catch (error) {
    console.error("Error fetching space:", error);
    res.status(500).json({ message: "Failed to fetch space" });
  }
});

// POST create new space
app.post("/api/spaces", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const {
      name,
      iconUrl,
      description,
      defaultPermission,
      privacy,
      memberIds,
      teamIds,
      statuses
    } = req.body;

    if (!name || !iconUrl) {
      return res.status(400).json({ message: "Name and icon are required" });
    }

    if (!statuses || !Array.isArray(statuses) || statuses.length === 0) {
      return res.status(400).json({ message: "At least one status is required" });
    }

    const validStatuses = statuses.every(
      (status: any) => status.name && status.colorCode
    );
    if (!validStatuses) {
      return res.status(400).json({
        message: "Invalid status format. Each status must have name and colorCode"
      });
    }

    const companyId = (req.user as any)?.companyId;
    const space = await storage.createSpace({
      name,
      iconUrl,
      description: description || null,
      defaultPermission: defaultPermission || 'full_access',
      privacy: privacy || 'private',
      memberIds: memberIds || [],
      teamIds: teamIds || [],
      ownerId: userId,
      companyId: companyId || null,
      statuses,
    });

    // Log activity
    await storage.logActivity({
      userId,
      action: 'space_created',
      details: JSON.stringify({ spaceId: space.id, spaceName: space.name }),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(201).json(space);
  } catch (error) {
    console.error("Error creating space:", error);
    res.status(500).json({ message: "Failed to create space" });
  }
});


// PATCH update space
app.patch("/api/spaces/:id", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const spaceId = req.params.id;

    // Check if user owns the space
    const existingSpace = await storage.getSpace(spaceId);
    if (!existingSpace) {
      return res.status(404).json({ message: "Space not found" });
    }

    if (existingSpace.ownerId !== userId) {
      return res.status(403).json({ message: "You don't have permission to update this space" });
    }

    const updates = req.body;
    const updatedSpace = await storage.updateSpace(spaceId, updates);

    // Log activity
    await storage.logActivity({
      userId,
      action: 'space_updated',
      details: JSON.stringify({ spaceId, updates }),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(updatedSpace);
  } catch (error) {
    console.error("Error updating space:", error);
    res.status(500).json({ message: "Failed to update space" });
  }
});

// DELETE space
app.delete("/api/spaces/:id", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const spaceId = req.params.id;

    // Check if user owns the space
    const existingSpace = await storage.getSpace(spaceId);
    if (!existingSpace) {
      return res.status(404).json({ message: "Space not found" });
    }

    if (existingSpace.ownerId !== userId) {
      return res.status(403).json({ message: "You don't have permission to delete this space" });
    }

    const success = await storage.deleteSpace(spaceId);

    if (!success) {
      return res.status(404).json({ message: "Space not found" });
    }

    // Log activity
    await storage.logActivity({
      userId,
      action: 'space_deleted',
      details: JSON.stringify({ spaceId, spaceName: existingSpace.name }),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(204).send();
  } catch (error) {
    console.error("Error deleting space:", error);
    res.status(500).json({ message: "Failed to delete space" });
  }
});

// ==================== SPACE STATUSES CRUD ROUTES ====================

// GET all statuses for a space
app.get("/api/spaces/:spaceId/statuses", requireAuth, async (req, res) => {
  try {
    const statuses = await storage.getSpaceStatuses(req.params.spaceId);
    res.json(statuses);
  } catch (error) {
    console.error("Error fetching statuses:", error);
    res.status(500).json({ message: "Failed to fetch statuses" });
  }
});

// POST create new status
app.post("/api/spaces/:spaceId/statuses", requireAuth, async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { name, colorCode } = req.body;

    if (!name || !colorCode) {
      return res.status(400).json({ message: "Name and color code are required" });
    }

    const existingStatuses = await storage.getSpaceStatuses(spaceId);
    const order = existingStatuses.length;

    const status = await storage.createSpaceStatus({
      spaceId,
      name,
      colorCode,
      order,
    });

    res.status(201).json(status);
  } catch (error) {
    console.error("Error creating status:", error);
    res.status(500).json({ message: "Failed to create status" });
  }
});

app.patch("/api/spaces/:spaceId/statuses/:statusId", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { spaceId, statusId } = req.params;
    const { name, colorCode } = req.body;

    // Build updates object
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (colorCode !== undefined) updates.colorCode = colorCode;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No updates provided" });
    }

    const updatedStatus = await storage.updateSpaceStatus(statusId, updates);

    if (!updatedStatus) {
      return res.status(404).json({ message: "Status not found" });
    }

    upsertRecentActivity(db, userId, spaceId).catch(() => {});
    res.json(updatedStatus);
  } catch (error) {
    console.error("Error updating status:", error);
    res.status(500).json({ message: "Failed to update status" });
  }
});

// DELETE single status
app.delete("/api/spaces/:spaceId/statuses/:statusId", requireAuth, async (req, res) => {
  try {
    const success = await storage.deleteSpaceStatus(req.params.statusId);

    if (!success) {
      return res.status(404).json({ message: "Status not found" });
    }

    res.status(204).send();
  } catch (error) {
    console.error("Error deleting status:", error);
    res.status(500).json({ message: "Failed to delete status" });
  }
});

// DELETE all statuses for a space
app.delete("/api/spaces/:spaceId/statuses", requireAuth, async (req, res) => {
  try {
    const success = await storage.deleteAllSpaceStatuses(req.params.spaceId);
    res.json({ success, message: "All statuses deleted" });
  } catch (error) {
    console.error("Error deleting all statuses:", error);
    res.status(500).json({ message: "Failed to delete statuses" });
  }
});

app.post("/api/spaces/:spaceId/invite", requireAuth, async (req, res) => {
  try {
    const ownerId = (req.user as any)?.id;
    const { spaceId } = req.params;
    const { email } = req.body;

    if (!email || typeof email !== "string") {
      return res.status(400).json({ message: "Email is required" });
    }

    // Verify the requesting user is the space owner
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.id, spaceId),
    });
    if (!space) return res.status(404).json({ message: "Space not found" });
    if (space.ownerId !== ownerId) {
      return res.status(403).json({ message: "Only the space owner can invite members" });
    }

    // Normalise email
    const normalizedEmail = email.trim().toLowerCase();

    // ── Case 1: User already exists in the system ──────────────────────────
    const existingUser = await storage.getUserByEmail(normalizedEmail);

    if (existingUser) {
      // Already a member?
      if ((space.memberIds ?? []).includes(existingUser.id)) {
        return res.status(400).json({ message: "User is already a member of this space" });
      }

      // Add to space.memberIds
      const updatedMemberIds = [...(space.memberIds ?? []), existingUser.id];
      await db
        .update(spaces)
        .set({ memberIds: updatedMemberIds, updatedAt: new Date() })
        .where(eq(spaces.id, spaceId));

      // Record the owner↔member relationship in spaceInvitations (accepted immediately)
      await db.insert(spaceInvitations).values({
        spaceId,
        invitedByUserId: ownerId,
        invitedEmail: normalizedEmail,
        invitedUserId: existingUser.id,
        token: crypto.randomBytes(32).toString("hex"),
        status: "accepted",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      // Notify the added user
      await sendSpaceInviteEmail({
        toEmail: normalizedEmail,
        toName: existingUser.displayName,
        spaceName: space.name,
        inviterName: (req.user as any)?.displayName ?? "A team member",
        inviteLink: null,
        isSoftSignup: false,
      });

      return res.json({
        status: "added",
        userId: existingUser.id,
        displayName: existingUser.displayName,
        email: existingUser.email,
      });
    }

    // ── Case 2: User does NOT exist → soft signup ──────────────────────────
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const companyId = (req.user as any)?.companyId;
    // Create a placeholder user
    const softUser = await storage.createUser({
      email: normalizedEmail,
      displayName: normalizedEmail.split("@")[0],
      password: null,
      authProvider: "local",
      isEmailVerified: false,
      isSoftSignup: true,
      companyId: companyId || null,
      hasCompletedOnboarding: true,
    } as any);

    // Add to space.memberIds immediately so the space is accessible once they complete signup
    const updatedMemberIds = [...(space.memberIds ?? []), softUser.id];
    await db
      .update(spaces)
      .set({ memberIds: updatedMemberIds, updatedAt: new Date() })
      .where(eq(spaces.id, spaceId));

    // Create invitation record
    await db.insert(spaceInvitations).values({
      spaceId,
      invitedByUserId: ownerId,
      invitedEmail: normalizedEmail,
      invitedUserId: softUser.id,
      token: inviteToken,
      status: "pending",
      expiresAt,
    });

    // Build accept link
    const inviteLink = `${process.env.APP_URL || "http://localhost:5000"}/accept-invite?token=${inviteToken}`;

    await sendSpaceInviteEmail({
      toEmail: normalizedEmail,
      toName: normalizedEmail.split("@")[0],
      spaceName: space.name,
      inviterName: (req.user as any)?.displayName ?? "A team member",
      inviteLink,
      isSoftSignup: true,
    });

    return res.json({
      status: "invited",
      userId: softUser.id,
      email: normalizedEmail,
    });
  } catch (error) {
    console.error("Error inviting member:", error);
    return res.status(500).json({ message: "Failed to invite member" });
  }
});


// ── GET /api/spaces/invite/verify?token=...

app.get("/api/spaces/invite/verify", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== "string") {
      return res.status(400).json({ message: "Invalid or missing token" });
    }

    const invitation = await db.query.spaceInvitations.findFirst({
      where: eq(spaceInvitations.token, token),
    });

    if (!invitation) return res.status(404).json({ message: "Invitation not found" });
    if (invitation.status === "accepted") {
      return res.json({ status: "already_accepted" });
    }
    if (invitation.expiresAt && new Date() > invitation.expiresAt) {
      return res.status(410).json({ message: "Invitation has expired" });
    }

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.id, invitation.spaceId),
    });

    return res.json({
      status: "pending",
      email: invitation.invitedEmail,
      spaceName: space?.name ?? "a space",
      spaceId: invitation.spaceId,
    });
  } catch (error) {
    console.error("Error verifying invite:", error);
    return res.status(500).json({ message: "Failed to verify invitation" });
  }
});


// ── POST /api/spaces/invite/accept

app.post("/api/spaces/invite/accept", async (req, res) => {
  try {
    const { token, firstName, lastName, password, phone } = req.body;

    if (!token || !firstName || !lastName || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Validate password
    const passwordValidation = await validatePassword(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({ message: passwordValidation.message });
    }

    const invitation = await db.query.spaceInvitations.findFirst({
      where: eq(spaceInvitations.token, token),
    });

    if (!invitation) return res.status(404).json({ message: "Invitation not found" });
    if (invitation.status === "accepted") {
      return res.status(400).json({ message: "Invitation already accepted" });
    }
    if (invitation.expiresAt && new Date() > invitation.expiresAt) {
      return res.status(410).json({ message: "Invitation has expired" });
    }

    if (!invitation.invitedUserId) {
      return res.status(500).json({ message: "Invitation data i/api/spaces/:ids corrupt" });
    }

    // Hash the new password
    const hashedPassword = await hashPassword(password);
    const displayName = `${firstName} ${lastName}`;

    // Get the inviter to copy their companyId
    const inviter = await storage.getUser(invitation.invitedByUserId);
    const companyId = inviter?.companyId ?? null;

    // Update the soft-signup placeholder user with real details
    await storage.updateUser(invitation.invitedUserId, {
      firstName,
      lastName,
      displayName,
      password: hashedPassword,
      phone: phone ?? null,
      isEmailVerified: true,
      isSoftSignup: false,
      authProvider: "local",
      companyId: companyId,
      hasCompletedOnboarding: true,
    } as any);

    // Mark invitation as accepted
    await db
      .update(spaceInvitations)
      .set({ status: "accepted" })
      .where(eq(spaceInvitations.token, token));

    return res.json({ message: "Account setup complete! You can now log in.", email: invitation.invitedEmail });
  } catch (error) {
    console.error("Error accepting invite:", error);
    return res.status(500).json({ message: "Failed to complete signup" });
  }
});


  // GET /api/users — get all users for the current company
  app.get("/api/users", requireAuth, async (req, res) => {
    try {
      const user = req.user as any;
      if (!user.companyId) {
        // Fallback: if requesting user has no companyId, return only themselves
        const singleUser = await db
          .select()
          .from(users)
          .where(eq(users.id, user.id));
        return res.json(singleUser);
      }

      const companyUsers = await db
        .select()
        .from(users)
        .where(eq(users.companyId, user.companyId));

      res.json(companyUsers);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // GET /api/users/:id — get user details by ID
  app.get("/api/users/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json(user);
    } catch (error) {
      console.error("Error fetching user details:", error);
      res.status(500).json({ message: "Failed to fetch user details" });
    }
  });

  // ── GET /api/users/:userId/known-collaborators
  app.get("/api/users/:userId/known-collaborators", requireAuth, async (req, res) => {
  try {
    const requestingUser = (req.user as any)?.id;
    const { userId } = req.params;

    // Only allow querying your own collaborators
    if (requestingUser !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // Find all distinct invitedUserId that this owner has ever added
    const rows = await db
      .select({
        invitedEmail: spaceInvitations.invitedEmail,
        invitedUserId: spaceInvitations.invitedUserId,
        status: spaceInvitations.status,
      })
      .from(spaceInvitations)
      .where(eq(spaceInvitations.invitedByUserId, userId));

    // Deduplicate by email, prefer accepted entries
    const emailMap = new Map<string, typeof rows[0]>();
    for (const row of rows) {
      const existing = emailMap.get(row.invitedEmail);
      if (!existing || row.status === "accepted") {
        emailMap.set(row.invitedEmail, row);
      }
    }

    // Enrich with user details where available
    const collaborators = await Promise.all(
      Array.from(emailMap.values()).map(async (row) => {
        if (row.invitedUserId) {
          const user = await storage.getUser(row.invitedUserId);
          if (user && !user.isSoftSignup) {
            return {
              userId: user.id,
              email: user.email,
              displayName: user.displayName,
              profilePicture: user.profilePicture ?? null,
            };
          }
        }
        return {
          userId: null,
          email: row.invitedEmail,
          displayName: row.invitedEmail.split("@")[0],
          profilePicture: null,
        };
      })
    );

    return res.json(collaborators);
  } catch (error) {
    console.error("Error fetching collaborators:", error);
    return res.status(500).json({ message: "Failed to fetch collaborators" });
  }
});

// ==================== SETTINGS ROUTES ====================]

app.get("/api/settings", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const user = await storage.getUser(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      profile: {
        firstName: user.firstName ?? "",
        lastName: user.lastName ?? "",
        email: user.email ?? "",
        phone: user.phone ?? "",
        timezone: user.timezone ?? "Asia/Karachi",
        profilePicture: user.profilePicture ?? null,
      },
      preferences: {
        theme: (user.theme ?? "system").toLowerCase() === "auto" ? "system" : (user.theme ?? "system").toLowerCase(),
        language: user.language ?? "en",
        dateFormat: user.dateFormat ?? "DD/MM/YYYY",
        timeFormat: (user.timeFormat === "12" ? "12h" : user.timeFormat === "24" ? "24h" : user.timeFormat ?? "12h") as "12h" | "24h",
        weekFormat: (user.weekFormat ?? "monday").toLowerCase(),
      },
      notifications: {
        emailNotifications: user.emailNotifications ?? true,
        inAppNotifications: user.inAppNotifications ?? false,
        notifyTaskAssigned: user.notifyTaskAssigned ?? false,
        notifyMentions: user.notifyMentions ?? true,
        notifyComments: user.notifyComments ?? false,
        notifyDueDateReminders: user.notifyDueDateReminders ?? true,
      },
      security: {
        email2faEnabled: user.email2faEnabled ?? false,
        totp2faEnabled: user.totp2faEnabled ?? false,
        authProvider: user.authProvider ?? "local",
      },
    });
  } catch (error) {
    console.error("Error fetching settings:", error);
    return res.status(500).json({ message: "Failed to fetch settings" });
  }
});

app.put("/api/settings/profile", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const parsed = profileSettingsSchema.parse(req.body);
    const currentUser = await storage.getUser(userId);

    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const normalizedEmail = parsed.email.trim().toLowerCase();

    if (normalizedEmail !== currentUser.email) {
      const existingUser = await storage.getUserByEmail(normalizedEmail);
      if (existingUser && existingUser.id !== userId) {
        return res.status(400).json({ message: "Email is already in use" });
      }
    }

    const displayName = `${parsed.firstName} ${parsed.lastName}`.trim();

    const updatedUser = await storage.updateUser(userId, {
      firstName: parsed.firstName,
      lastName: parsed.lastName ?? "",
      displayName,
      email: normalizedEmail,
      phone: parsed.phone ?? null,
      timezone: parsed.timezone,
      profilePicture: parsed.profilePicture ?? currentUser.profilePicture ?? null,
    });

    return res.json({
      message: "Profile updated successfully",
      profile: {
        firstName: updatedUser?.firstName ?? "",
        lastName: updatedUser?.lastName ?? "",
        email: updatedUser?.email ?? "",
        phone: updatedUser?.phone ?? "",
        timezone: updatedUser?.timezone ?? "Asia/Karachi",
        profilePicture: updatedUser?.profilePicture ?? null,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid profile data", errors: error.errors });
    }
    console.error("Error updating profile settings:", error);
    return res.status(500).json({ message: "Failed to update profile settings" });
  }
});

app.put("/api/settings/preferences", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const parsed = preferenceSettingsSchema.parse(req.body);

    const updatedUser = await storage.updateUser(userId, {
      theme: parsed.theme,
      language: parsed.language,
      dateFormat: parsed.dateFormat,
      timeFormat: parsed.timeFormat,
      weekFormat: parsed.weekFormat,
    });

    return res.json({
      message: "Preferences updated successfully",
      preferences: {
        theme: (updatedUser?.theme ?? "system").toLowerCase(),
        language: updatedUser?.language ?? "en",
        dateFormat: updatedUser?.dateFormat ?? "DD/MM/YYYY",
        timeFormat: (updatedUser?.timeFormat === "12" ? "12h" : updatedUser?.timeFormat === "24" ? "24h" : updatedUser?.timeFormat ?? "12h") as "12h" | "24h",
        weekFormat: updatedUser?.weekFormat ?? "monday",
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid preferences data", errors: error.errors });
    }
    console.error("Error updating preferences:", error);
    return res.status(500).json({ message: "Failed to update preferences" });
  }
});

app.put("/api/settings/notifications", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const parsed = notificationSettingsSchema.parse(req.body);

    const updatedUser = await storage.updateUser(userId, {
      emailNotifications: parsed.emailNotifications,
      inAppNotifications: parsed.inAppNotifications,
      notifyTaskAssigned: parsed.notifyTaskAssigned,
      notifyMentions: parsed.notifyMentions,
      notifyComments: parsed.notifyComments,
      notifyDueDateReminders: parsed.notifyDueDateReminders,
    });

    return res.json({
      message: "Notification settings updated successfully",
      notifications: {
        emailNotifications: updatedUser?.emailNotifications ?? true,
        inAppNotifications: updatedUser?.inAppNotifications ?? false,
        notifyTaskAssigned: updatedUser?.notifyTaskAssigned ?? false,
        notifyMentions: updatedUser?.notifyMentions ?? true,
        notifyComments: updatedUser?.notifyComments ?? false,
        notifyDueDateReminders: updatedUser?.notifyDueDateReminders ?? true,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid notification settings data", errors: error.errors });
    }
    console.error("Error updating notifications:", error);
    return res.status(500).json({ message: "Failed to update notification settings" });
  }
});

app.post("/api/settings/security/email-2fa/enable/init", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { email, password } = email2faInitSchema.parse(req.body);

    const user = await storage.getUser(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ message: "Email does not match your account" });
    }

    // Skip password check for Google/OAuth users — they have no local password
    if (user.authProvider === "local") {
      const isValidPassword = await bcrypt.compare(password, user.password ?? "");
      if (!isValidPassword) {
        return res.status(400).json({ message: "Password is incorrect" });
      }
    }

    if (user.totp2faEnabled) {
      return res.status(400).json({ message: "Disable TOTP first" });
    }

    const code = generateNumericCode(6);
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    await storage.updateUser(userId, {
      email2faCode: code,
      email2faCodeExpiry: expiry,
      email2faPendingAction: "enable",
    });

    try {
      await send2FACodeEmail(user.email, code, user.displayName || user.email, "enable");
    } catch (emailError) {
      console.error("Error sending 2FA enable email:", emailError);
    }

    return res.json({
      message: "Verification code sent",
      maskedEmail: maskEmail(user.email),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid request", errors: error.errors });
    }
    console.error("Error initializing email 2FA enable:", error);
    return res.status(500).json({ message: "Failed to send verification code" });
  }
});

app.post("/api/settings/security/email-2fa/enable/resend", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const user = await storage.getUser(userId);

    if (!user) return res.status(404).json({ message: "User not found" });

    const code = generateNumericCode(6);
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    await storage.updateUser(userId, {
      email2faCode: code,
      email2faCodeExpiry: expiry,
      email2faPendingAction: "enable",
    });

    try {
      await send2FACodeEmail(user.email, code, user.displayName || user.email, "enable");
    } catch (emailError) {
      console.error("Error resending 2FA enable email:", emailError);
    }

    return res.json({
      message: "Verification code resent",
      maskedEmail: maskEmail(user.email),
    });
  } catch (error) {
    console.error("Error resending email 2FA code:", error);
    return res.status(500).json({ message: "Failed to resend verification code" });
  }
});

app.post("/api/settings/security/email-2fa/enable/verify", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { code } = codeSchema.parse(req.body);
    const user = await storage.getUser(userId);

    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.email2faPendingAction !== "enable") {
      return res.status(400).json({ message: "No pending email 2FA enable request" });
    }
    if (!user.email2faCode || !user.email2faCodeExpiry) {
      return res.status(400).json({ message: "No active verification code" });
    }
    if (new Date(user.email2faCodeExpiry).getTime() < Date.now()) {
      return res.status(400).json({ message: "Verification code expired" });
    }
    if (user.email2faCode !== code) {
      return res.status(400).json({ message: "Invalid verification code" });
    }

    await storage.updateUser(userId, {
      email2faEnabled: true,
      totp2faEnabled: false,
      email2faCode: null,
      email2faCodeExpiry: null,
      email2faPendingAction: null,
      totpSecret: null,
      totpTempSecret: null,
      totpBackupCodes: [],
    });

    return res.json({ message: "Email 2FA enabled successfully" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid request", errors: error.errors });
    }
    console.error("Error verifying email 2FA enable:", error);
    return res.status(500).json({ message: "Failed to verify code" });
  }
});

app.post("/api/settings/security/email-2fa/disable/init", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { email, password } = email2faInitSchema.parse(req.body);

    const user = await storage.getUser(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ message: "Email does not match your account" });
    }

    // Skip password check for Google/OAuth users — they have no local password
    if (user.authProvider === "local") {
      const isValidPassword = await bcrypt.compare(password, user.password ?? "");
      if (!isValidPassword) {
        return res.status(400).json({ message: "Password is incorrect" });
      }
    }

    const code = generateNumericCode(6);
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    await storage.updateUser(userId, {
      email2faCode: code,
      email2faCodeExpiry: expiry,
      email2faPendingAction: "disable",
    });

    try {
      await send2FACodeEmail(user.email, code, user.displayName || user.email, "disable");
    } catch (emailError) {
      console.error("Error sending 2FA disable email:", emailError);
    }

    return res.json({
      message: "Verification code sent",
      maskedEmail: maskEmail(user.email),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid request", errors: error.errors });
    }
    console.error("Error initializing email 2FA disable:", error);
    return res.status(500).json({ message: "Failed to send verification code" });
  }
});

app.post("/api/settings/security/email-2fa/disable/resend", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const user = await storage.getUser(userId);

    if (!user) return res.status(404).json({ message: "User not found" });

    const code = generateNumericCode(6);
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    await storage.updateUser(userId, {
      email2faCode: code,
      email2faCodeExpiry: expiry,
      email2faPendingAction: "disable",
    });

    try {
      await send2FACodeEmail(user.email, code, user.displayName || user.email, "disable");
    } catch (emailError) {
      console.error("Error resending 2FA disable email:", emailError);
    }

    return res.json({
      message: "Verification code resent",
      maskedEmail: maskEmail(user.email),
    });
  } catch (error) {
    console.error("Error resending email 2FA disable code:", error);
    return res.status(500).json({ message: "Failed to resend verification code" });
  }
});

app.post("/api/settings/security/email-2fa/disable/verify", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { code } = codeSchema.parse(req.body);
    const user = await storage.getUser(userId);

    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.email2faPendingAction !== "disable") {
      return res.status(400).json({ message: "No pending email 2FA disable request" });
    }
    if (!user.email2faCode || !user.email2faCodeExpiry) {
      return res.status(400).json({ message: "No active verification code" });
    }
    if (new Date(user.email2faCodeExpiry).getTime() < Date.now()) {
      return res.status(400).json({ message: "Verification code expired" });
    }
    if (user.email2faCode !== code) {
      return res.status(400).json({ message: "Invalid verification code" });
    }

    await storage.updateUser(userId, {
      email2faEnabled: false,
      email2faCode: null,
      email2faCodeExpiry: null,
      email2faPendingAction: null,
    });

    return res.json({ message: "Email 2FA disabled successfully" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid request", errors: error.errors });
    }
    console.error("Error verifying email 2FA disable:", error);
    return res.status(500).json({ message: "Failed to verify code" });
  }
});


app.post("/api/settings/security/totp/setup", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { email, password } = totpSetupSchema.parse(req.body);

    const user = await storage.getUser(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ message: "Email does not match your account" });
    }

    // Skip password check for Google/OAuth users — they have no local password
    if (user.authProvider === "local") {
      const isValidPassword = await bcrypt.compare(password, user.password ?? "");
      if (!isValidPassword) {
        return res.status(400).json({ message: "Password is incorrect" });
      }
    }

    if (user.email2faEnabled) {
      return res.status(400).json({ message: "Disable email 2FA first" });
    }

    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(user.email, "clicsHQ", secret);
    const qrCodeUrl = await QRCode.toDataURL(otpauthUrl);

    await storage.updateUser(userId, {
      totpTempSecret: secret,
    });

    return res.json({
      message: "TOTP setup initialized",
      qrCodeUrl,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid request", errors: error.errors });
    }
    console.error("Error setting up TOTP:", error);
    return res.status(500).json({ message: "Failed to initialize TOTP" });
  }
});

app.post("/api/settings/security/totp/enable", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { token } = totpVerifySchema.parse(req.body);

    const user = await storage.getUser(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.totpTempSecret) {
      return res.status(400).json({ message: "No pending TOTP setup found" });
    }

    const isValid = authenticator.verify({
      token,
      secret: user.totpTempSecret,
    });

    if (!isValid) {
      return res.status(400).json({ message: "Invalid authentication code" });
    }

    const backupCodes = generateBackupCodes(10);

    await storage.updateUser(userId, {
      totp2faEnabled: true,
      email2faEnabled: false,
      totpSecret: user.totpTempSecret,
      totpTempSecret: null,
      totpBackupCodes: backupCodes,
      email2faCode: null,
      email2faCodeExpiry: null,
      email2faPendingAction: null,
    });

    return res.json({
      message: "TOTP enabled successfully",
      backupCodes,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid request", errors: error.errors });
    }
    console.error("Error enabling TOTP:", error);
    return res.status(500).json({ message: "Failed to enable TOTP" });
  }
});

app.post("/api/settings/security/totp/disable/init", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { email, password } = totpSetupSchema.parse(req.body);

    const user = await storage.getUser(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ message: "Email does not match your account" });
    }

    // Skip password check for Google/OAuth users — they have no local password
    if (user.authProvider === "local") {
      const isValidPassword = await bcrypt.compare(password, user.password ?? "");
      if (!isValidPassword) {
        return res.status(400).json({ message: "Password is incorrect" });
      }
    }

    if (!user.totp2faEnabled || !user.totpSecret) {
      return res.status(400).json({ message: "TOTP is not enabled" });
    }

    return res.json({ message: "Proceed to TOTP verification" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid request", errors: error.errors });
    }
    console.error("Error initializing TOTP disable:", error);
    return res.status(500).json({ message: "Failed to continue" });
  }
});

app.post("/api/settings/security/totp/disable", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { token } = totpVerifySchema.parse(req.body);

    const user = await storage.getUser(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.totpSecret) {
      return res.status(400).json({ message: "TOTP is not enabled" });
    }

    const isValid = authenticator.verify({
      token,
      secret: user.totpSecret,
    });

    if (!isValid) {
      const matchedBackupCode = (user.totpBackupCodes || []).includes(token);
      if (!matchedBackupCode) {
        return res.status(400).json({ message: "Invalid authentication code" });
      }
    }

    await storage.updateUser(userId, {
      totp2faEnabled: false,
      totpSecret: null,
      totpTempSecret: null,
      totpBackupCodes: [],
    });

    return res.json({ message: "TOTP disabled successfully" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid request", errors: error.errors });
    }
    console.error("Error disabling TOTP:", error);
    return res.status(500).json({ message: "Failed to disable TOTP" });
  }
});

// ==================== OVERVIEW STATS ROUTES ====================]

// ── GET /api/spaces/:spaceId/overview/stats ──────────────────────────────────
app.get("/api/spaces/:spaceId/overview/stats", requireAuth, async (req, res) => {
  try {
    const { spaceId } = req.params;
    const days = parseInt(req.query.days as string) || 30;

    const now = new Date();
    const filterStart = new Date();
    filterStart.setDate(filterStart.getDate() - days);
    filterStart.setHours(0, 0, 0, 0);

    const allTasks = await storage.getAllTasks(spaceId);
    const statuses = await storage.getSpaceStatuses(spaceId);

    const sorted = [...statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const firstStatus = sorted[0] ?? null;
    const lastStatus = sorted[sorted.length - 1] ?? null;

    const completedStatusIds = new Set<string>(
      sorted
        .filter((s) => ["done", "completed", "complete"].includes(s.name.toLowerCase()))
        .map((s) => s.id)
    );
    if (lastStatus) completedStatusIds.add(lastStatus.id);

    const inProgressStatusIds = sorted
      .filter((s) =>
        ["in progress", "in-progress", "inprogress", "doing", "active"].includes(s.name.toLowerCase())
      )
      .map((s) => s.id);

    // ✅ Last N days mein create ya update hue tasks
    const filteredTasks = allTasks.filter((t: any) => {
      const activityDate = t.updatedAt
        ? new Date(t.updatedAt)
        : t.createdAt
        ? new Date(t.createdAt)
        : null;
      if (!activityDate) return false;
      return activityDate >= filterStart && activityDate <= now;
    });

    const total = filteredTasks.length;
    const completed = filteredTasks.filter((t: any) => completedStatusIds.has(t.statusId)).length;
    const inProgress = filteredTasks.filter((t: any) => inProgressStatusIds.includes(t.statusId)).length;
    const overdue = filteredTasks.filter((t: any) => {
      if (!t.dueDate) return false;
      if (completedStatusIds.has(t.statusId)) return false;
      return new Date(t.dueDate) < now;
    }).length;

    const statusBreakdown = sorted.map((s) => ({
      statusId: s.id,
      statusName: s.name,
      colorCode: s.colorCode,
      count: filteredTasks.filter((t: any) => t.statusId === s.id).length,
    }));

    const priorityBreakdown = {
      high: filteredTasks.filter((t: any) => t.priority === "high").length,
      normal: filteredTasks.filter((t: any) => t.priority === "normal").length,
      low: filteredTasks.filter((t: any) => t.priority === "low").length,
    };

    res.json({
      total, completed, inProgress, overdue,
      statusBreakdown, priorityBreakdown,
      firstStatus: firstStatus ? { id: firstStatus.id, name: firstStatus.name, colorCode: firstStatus.colorCode } : null,
      lastStatus: lastStatus ? { id: lastStatus.id, name: lastStatus.name, colorCode: lastStatus.colorCode } : null,
    });
  } catch (error) {
    console.error("Error fetching overview stats:", error);
    res.status(500).json({ message: "Failed to fetch overview stats" });
  }
});
app.get("/api/spaces/:spaceId/overview/first-vs-last", requireAuth, async (req, res) => {
  try {
    const { spaceId } = req.params;
    const days = parseInt(req.query.days as string) || 30;

    const allTasks = await storage.getAllTasks(spaceId);
    const statuses = await storage.getSpaceStatuses(spaceId);

    if (statuses.length === 0) {
      return res.json({ firstStatusName: "To Do", lastStatusName: "Completed", firstStatusColor: "#6366f1", lastStatusColor: "#22c55e", data: [] });
    }

    const sorted = [...statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const firstStatus = sorted[0];
    const lastStatus = sorted[sorted.length - 1];

    const labels: string[] = [];
    const dates: Date[] = [];
    const firstByDay: number[] = new Array(days).fill(0);
    const lastByDay: number[] = new Array(days).fill(0);

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      dates.push(new Date(d));
      labels.push(days <= 7
        ? d.toLocaleDateString("en-US", { weekday: "short" })
        : d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
      );
    }

    // ✅ Last N days activity wale tasks
    allTasks.forEach((task: any) => {
      const activityDate = task.updatedAt
        ? new Date(task.updatedAt)
        : task.createdAt
        ? new Date(task.createdAt)
        : null;

      if (!activityDate) return;

      // Har day slot se compare karo
      dates.forEach((slotDate, index) => {
        const slotStart = new Date(slotDate); slotStart.setHours(0, 0, 0, 0);
        const slotEnd = new Date(slotDate); slotEnd.setHours(23, 59, 59, 999);

        if (activityDate >= slotStart && activityDate <= slotEnd) {
          if (task.statusId === firstStatus.id) firstByDay[index]++;
          if (task.statusId === lastStatus.id) lastByDay[index]++;
        }
      });
    });

    const hasData = firstByDay.some((v) => v > 0) || lastByDay.some((v) => v > 0);

    const data = hasData
      ? labels.map((label, i) => ({ label, month: dates[i].getMonth(), first: firstByDay[i], last: lastByDay[i] }))
      : labels.map((label, i) => ({
          label, month: dates[i].getMonth(),
          first: i === days - 1 ? allTasks.filter((t: any) => t.statusId === firstStatus.id).length : 0,
          last: i === days - 1 ? allTasks.filter((t: any) => t.statusId === lastStatus.id).length : 0,
        }));

    res.json({
      firstStatusName: firstStatus.name,
      lastStatusName: lastStatus.name,
      firstStatusColor: firstStatus.colorCode || "#6366f1",
      lastStatusColor: lastStatus.colorCode || "#22c55e",
      data,
    });
  } catch (error) {
    console.error("Error fetching first vs last:", error);
    res.status(500).json({ message: "Failed to fetch first vs last status data" });
  }
});

// ── GET /api/spaces/:spaceId/overview/workload ───────────────────────────────

app.get("/api/spaces/:spaceId/overview/workload", requireAuth, async (req, res) => {
  try {
    const { spaceId } = req.params;
    const days = parseInt(req.query.days as string) || 30;

    const now = new Date();
    const filterStart = new Date();
    filterStart.setDate(filterStart.getDate() - days);
    filterStart.setHours(0, 0, 0, 0);

    const allTasks = await storage.getAllTasks(spaceId);
    const statuses = await storage.getSpaceStatuses(spaceId);
    const allUsers = await storage.getAllUsers();

    const sorted = [...statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const completedStatusIds = new Set<string>(
      sorted
        .filter((s) => ["done", "completed", "complete"].includes(s.name.toLowerCase()))
        .map((s) => s.id)
    );
    if (sorted.length > 0) completedStatusIds.add(sorted[sorted.length - 1].id);

    const userMap = new Map(allUsers.map((u: any) => [u.id, u.displayName]));

    // ✅ Last N days mein active (incomplete) tasks
    const filteredTasks = allTasks.filter((t: any) => {
      if (completedStatusIds.has(t.statusId)) return false; // sirf active
      const activityDate = t.updatedAt
        ? new Date(t.updatedAt)
        : t.createdAt
        ? new Date(t.createdAt)
        : null;
      if (!activityDate) return false;
      return activityDate >= filterStart && activityDate <= now;
    });

    const memberTaskMap = new Map<string, {
      displayName: string;
      allTasks: typeof filteredTasks;
      activeTasks: typeof filteredTasks;
    }>();

    filteredTasks.forEach((task: any) => {
      (task.assigneeIds ?? []).forEach((assigneeId: string) => {
        if (!memberTaskMap.has(assigneeId)) {
          memberTaskMap.set(assigneeId, {
            displayName: (userMap.get(assigneeId) as string) ?? assigneeId,
            allTasks: [],
            activeTasks: [],
          });
        }
        const entry = memberTaskMap.get(assigneeId)!;
        entry.allTasks.push(task);
        entry.activeTasks.push(task);
      });
    });

    if (memberTaskMap.size === 0) {
      return res.json({ members: [], statuses: sorted, spaceActiveTasks: 0 });
    }

    const spaceActiveTasks = filteredTasks.length;

    const parseHoursToMinutes = (str: string | null): number => {
      if (!str) return 60;
      const h = str.match(/(\d+)h/);
      const m = str.match(/(\d+)m/);
      const total = (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
      return total > 0 ? total : 60;
    };

    const members = Array.from(memberTaskMap.entries())
      .map(([userId, m]) => {
        const activeCount = m.activeTasks.length;
        const workloadShare = spaceActiveTasks > 0 ? Math.round((activeCount / spaceActiveTasks) * 100) : 0;
        const activeEffortMinutes = m.activeTasks.reduce((sum, t: any) => sum + parseHoursToMinutes(t.estimatedHours), 0);
        const activeStatusCounts: Record<string, number> = {};
        m.activeTasks.forEach((t: any) => {
          activeStatusCounts[t.statusId] = (activeStatusCounts[t.statusId] || 0) + 1;
        });
        const segments = Object.entries(activeStatusCounts).map(([statusId, count]) => {
          const status = sorted.find((s) => s.id === statusId);
          return {
            statusId,
            statusName: status?.name ?? statusId,
            colorCode: status?.colorCode ?? "#9ca3af",
            count,
            pct: activeCount > 0 ? Math.round((count / activeCount) * 100) : 0,
          };
        });
        if (segments.length > 0) {
          const barSum = segments.reduce((a, s) => a + s.pct, 0);
          segments[segments.length - 1].pct += 100 - barSum;
        }
        return { userId, displayName: m.displayName, totalTasks: m.allTasks.length, activeTasks: activeCount, workloadShare, activeEffortMinutes, hasEstimates: m.activeTasks.some((t: any) => !!t.estimatedHours), segments };
      })
      .sort((a, b) => b.activeTasks - a.activeTasks)
      .slice(0, 5);

    res.json({ members, statuses: sorted, spaceActiveTasks });
  } catch (error) {
    console.error("Error fetching workload data:", error);
    res.status(500).json({ message: "Failed to fetch workload data" });
  }
});
// ── GET /api/spaces/:spaceId/overview/completion-trend ───────────────────────

app.get("/api/spaces/:spaceId/overview/completion-trend", requireAuth, async (req, res) => {
  try {
    const { spaceId } = req.params;
    const days = parseInt(req.query.days as string) || 30;

    const allTasks = await storage.getAllTasks(spaceId);
    const statuses = await storage.getSpaceStatuses(spaceId);

    const sorted = [...statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    // ✅ Saare completed status IDs
    const completedStatusIds = new Set<string>(
      sorted
        .filter((s) => ["done", "completed", "complete"].includes(s.name.toLowerCase()))
        .map((s) => s.id)
    );
    if (sorted.length > 0) completedStatusIds.add(sorted[sorted.length - 1].id);

    const completedTasks = allTasks.filter((t: any) => completedStatusIds.has(t.statusId));

    // ✅ Day slots generate karo
    const daySlots: { label: string; dateStr: string }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = days <= 7
        ? d.toLocaleDateString("en-US", { weekday: "short" })
        : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      daySlots.push({ label, dateStr: d.toISOString().split("T")[0] });
    }

    const trend = daySlots.map(({ label, dateStr }) => {
      const startOfDay = new Date(dateStr + "T00:00:00.000Z");
      const endOfDay = new Date(dateStr + "T23:59:59.999Z");

      // ✅ updatedAt prefer, createdAt fallback
      const count = completedTasks.filter((t: any) => {
        const checkDate = t.updatedAt ?? t.createdAt;
        if (!checkDate) return false;
        const d = new Date(checkDate);
        return d >= startOfDay && d <= endOfDay;
      }).length;

      return { label, value: count };
    });

    res.json(trend);
  } catch (error) {
    console.error("Error fetching completion trend:", error);
    res.status(500).json({ message: "Failed to fetch completion trend" });
  }
});

// ── GET /api/project-activities-v2/:projectId ────────────────────────────────
app.get("/api/project-activities-v2/:projectId", requireAuth, async (req, res) => {
  try {
    const activities = await db
      .select({
        id: projectActivities.id,
        projectId: projectActivities.projectId,
        userId: projectActivities.userId,
        activityType: projectActivities.activityType,
        entityName: projectActivities.entityName,
        oldValue: projectActivities.oldValue,
        newValue: projectActivities.newValue,
        createdAt: projectActivities.createdAt,
        userDisplayName: users.displayName,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userProfilePicture: users.profilePicture,
      })
      .from(projectActivities)
      .leftJoin(users, eq(projectActivities.userId, users.id))
      .where(eq(projectActivities.projectId, req.params.projectId))
      .orderBy(desc(projectActivities.createdAt))
      .limit(50);

    const shaped = activities.map((a) => ({
      id: a.id,
      projectId: a.projectId,
      userId: a.userId,
      activityType: a.activityType,
      entityName: a.entityName,
      oldValue: a.oldValue,
      newValue: a.newValue,
      createdAt: a.createdAt,
      user: a.userDisplayName
        ? {
            id: a.userId,
            displayName: a.userDisplayName,
            firstName: a.userFirstName ?? undefined,
            lastName: a.userLastName ?? undefined,
            avatarUrl: a.userProfilePicture ?? undefined,
          }
        : undefined,
    }));

    res.json(shaped);
  } catch (error) {
    console.error("Error fetching project activities:", error);
    res.status(500).json({ message: "Failed to fetch project activities" });
  }
});

// ==================== TASKS CRUD ROUTES ====================

// GET all tasks for a space
app.get("/api/spaces/:spaceId/tasks", requireAuth, async (req, res) => {
  try {
    const tasks = await storage.getAllTasks(req.params.spaceId);
    res.json(tasks);
  } catch (error) {
    console.error("Error fetching tasks:", error);
    res.status(500).json({ message: "Failed to fetch tasks" });
  }
});

// GET single task by ID
app.get("/api/tasks/:id", requireAuth, async (req, res) => {
  try {
    const task = await storage.getTask(req.params.id);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }
    res.json(task);
  } catch (error) {
    console.error("Error fetching task:", error);
    res.status(500).json({ message: "Failed to fetch task" });
  }
});

// POST create new task
app.post("/api/spaces/:spaceId/tasks", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { spaceId } = req.params;
    const {
      name,
      description,
      statusId,
      priority,
      assigneeIds,
      dueDate,
      labels,
      estimatedHours,
      actualHours,
      attachments,
      ownerId,
    } = req.body;

    if (!name || !statusId) {
      return res.status(400).json({
        message: "Name and status are required"
      });
    }

    const task = await storage.createTask({
      spaceId,
      name,
      description: description || "",
      statusId,
      priority: priority || null,
      ownerId: ownerId || userId,
      assigneeIds: assigneeIds || [],
      dueDate: dueDate || null,
      labels: labels || [],
      estimatedHours: estimatedHours || null,
      actualHours: actualHours || null,
      attachments: [],
    });

    if (attachments && attachments.length > 0) {
      const finalUrls = await syncTaskAttachments(task.id, attachments, userId);
      await storage.updateTask(task.id, { attachments: finalUrls });
      task.attachments = finalUrls;
    }

    // Log activity
    await storage.logActivity({
      userId,
      action: 'task_created',
      details: JSON.stringify({ spaceId, taskId: task.id, taskName: task.name }),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Update recent activity for this space (non-blocking)
    upsertRecentActivity(db, userId, spaceId).catch(() => {});

    // Trigger workflows for task creation (fire-and-forget, migrated from Nexus)
    evaluateWorkflows("task.created", { task, userId, spaceId }).catch((err) =>
      console.error("[Workflow] task.created hook error:", err)
    );

    res.status(201).json(task);
  } catch (error) {
    console.error("Error creating task:", error);
    res.status(500).json({ message: "Failed to create task" });
  }
});

// PATCH update task
app.patch("/api/tasks/:id", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const taskId = req.params.id;

    const updates = req.body;
    // Capture the task before update so workflows can detect what changed
    const oldTask = await storage.getTask(taskId);
    if (updates.attachments !== undefined) {
      const finalUrls = await syncTaskAttachments(taskId, updates.attachments, userId);
      updates.attachments = finalUrls;
    }
    const updatedTask = await storage.updateTask(taskId, updates);

    if (!updatedTask) {
      return res.status(404).json({ message: "Task not found" });
    }

    // Log activity
    await storage.logActivity({
      userId,
      action: 'task_updated',
      details: JSON.stringify({ taskId, updates }),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Update recent activity for this space (non-blocking)
    if (updatedTask.spaceId) {
      upsertRecentActivity(db, userId, updatedTask.spaceId).catch(() => {});
    }

    // Trigger workflows for the specific change(s) (fire-and-forget, migrated from Nexus)
    const wfCtx = { task: updatedTask, userId, spaceId: updatedTask.spaceId, oldTask };
    const fireWf = (event: string) =>
      evaluateWorkflows(event, wfCtx).catch((err) =>
        console.error(`[Workflow] ${event} hook error:`, err)
      );
    if (oldTask) {
      if (updates.statusId !== undefined && oldTask.statusId !== updatedTask.statusId) fireWf("task.status_changed");
      if (updates.priority !== undefined && oldTask.priority !== updatedTask.priority) fireWf("task.priority_changed");
      const oldA = (oldTask.assigneeIds || []).join(",");
      const newA = (updatedTask.assigneeIds || []).join(",");
      if (updates.assigneeIds !== undefined && oldA !== newA) fireWf("task.assignee_changed");
    }

    res.json(updatedTask);
  } catch (error) {
    console.error("Error updating task:", error);
    res.status(500).json({ message: "Failed to update task" });
  }
});

// DELETE task
app.delete("/api/tasks/:id", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const taskId = req.params.id;

    const task = await storage.getTask(taskId);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    const success = await storage.deleteTask(taskId);

    if (!success) {
      return res.status(404).json({ message: "Task not found" });
    }

    // Log activity
    await storage.logActivity({
      userId,
      action: 'task_deleted',
      details: JSON.stringify({ taskId, taskName: task.name }),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (task.spaceId) upsertRecentActivity(db, userId, task.spaceId).catch(() => {});

    res.status(204).send();
  } catch (error) {
    console.error("Error deleting task:", error);
    res.status(500).json({ message: "Failed to delete task" });
  }
});

// PATCH /api/spaces/:spaceId/tasks/reorder
app.patch("/api/spaces/:spaceId/tasks/reorder", requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any)?.id;
    const { spaceId } = req.params;

    const { tasks: taskUpdates } = req.body as {
      tasks: Array<{ id: string; order: number; statusId: string }>;
    };

    // Validate body
    if (!Array.isArray(taskUpdates) || taskUpdates.length === 0) {
      return res.status(400).json({ message: "tasks array is required" });
    }

    // Validate each item has required fields
    for (const t of taskUpdates) {
      if (!t.id || typeof t.order !== "number" || !t.statusId) {
        return res.status(400).json({ message: "Each task must have id, order, and statusId" });
      }
    }

    // Update each task
    await Promise.all(
      taskUpdates.map((t) =>
        db
          .update(tasks)
          .set({
            order: t.order,
            statusId: t.statusId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tasks.id, t.id),
              eq(tasks.spaceId, spaceId)
            )
          )
      )
    );

    // Log activity
    await storage.logActivity({
      userId,
      action: "tasks_reordered",
      details: JSON.stringify({ spaceId, count: taskUpdates.length }),
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    upsertRecentActivity(db, userId, spaceId).catch(() => {});

    return res.json({ success: true });
  } catch (error) {
    console.error("Error reordering tasks:", error);
    return res.status(500).json({ message: "Failed to reorder tasks" });
  }
});

  // Workspace Projects Routes
  // app.get("/api/workspace-projects", requireAuth, async (req, res) => {
  //   try {
  //     const userId = (req.user as any)?.id;
  //     const projects = await storage.getWorkspaceProjectsForUser(userId);
  //     res.json(projects);
  //   } catch (error) {
  //     console.error("Error fetching workspace projects:", error);
  //     res.status(500).json({ message: "Failed to fetch projects" });
  //   }
  // });

  // app.get("/api/workspace-projects/:id", requireAuth, async (req, res) => {
  //   try {
  //     const project = await storage.getWorkspaceProject(req.params.id);
  //     if (!project) {
  //       res.status(404).json({ message: "Project not found" });
  //       return;
  //     }
  //     res.json(project);
  //   } catch (error) {
  //     console.error("Error fetching project:", error);
  //     res.status(500).json({ message: "Failed to fetch project" });
  //   }
  // });

  // app.post("/api/workspace-projects", requireAuth, async (req, res) => {
  //   try {
  //     const userId = (req.user as any)?.id;
  //     const { name, color, startDate, endDate, privacy, memberIds, defaultLayout } = req.body;

  //     const project = await storage.createWorkspaceProject({
  //       name,
  //       color,
  //       startDate,
  //       endDate,
  //       ownerId: userId,
  //       privacy,
  //       memberIds,
  //       defaultLayout
  //     });

  //     res.status(201).json(project);
  //   } catch (error) {
  //     console.error("Error creating project:", error);
  //     res.status(500).json({ message: "Failed to create project" });
  //   }
  // });

  // app.put("/api/workspace-projects/:id", requireAuth, async (req, res) => {
  //   try {
  //     const { name, color, startDate, endDate, privacy, memberIds, defaultLayout } = req.body;

  //     const project = await storage.updateWorkspaceProject(req.params.id, {
  //       name,
  //       color,
  //       startDate,
  //       endDate,
  //       privacy,
  //       memberIds,
  //       defaultLayout
  //     });

  //     if (!project) {
  //       res.status(404).json({ message: "Project not found" });
  //       return;
  //     }

  //     res.json(project);
  //   } catch (error) {
  //     console.error("Error updating project:", error);
  //     res.status(500).json({ message: "Failed to update project" });
  //   }
  // });

  // app.delete("/api/workspace-projects/:id", requireAuth, async (req, res) => {
  //   try {
  //     const success = await storage.deleteWorkspaceProject(req.params.id);
  //     if (!success) {
  //       res.status(404).json({ message: "Project not found" });
  //       return;
  //     }
  //     res.status(204).send();
  //   } catch (error) {
  //     console.error("Error deleting project:", error);
  //     res.status(500).json({ message: "Failed to delete project" });
  //   }
  // });

  // Project Sections Routes
  // app.get("/api/project-sections/:projectId", requireAuth, async (req, res) => {
  //   try {
  //     const sections = await storage.getProjectSections(req.params.projectId);
  //     res.json(sections);
  //   } catch (error) {
  //     console.error("Error fetching sections:", error);
  //     res.status(500).json({ message: "Failed to fetch sections" });
  //   }
  // });

  // app.post("/api/project-sections", requireAuth, async (req, res) => {
  //   try {
  //     const { projectId, name, order } = req.body;
  //     const section = await storage.createProjectSection({
  //       projectId,
  //       name,
  //       order: order ?? 0,
  //       isCollapsed: false,
  //     });
  //     res.status(201).json(section);
  //   } catch (error) {
  //     console.error("Error creating section:", error);
  //     res.status(500).json({ message: "Failed to create section" });
  //   }
  // });

  // app.patch("/api/project-sections/:id", requireAuth, async (req, res) => {
  //   try {
  //     const updates = req.body;
  //     const section = await storage.updateProjectSection(req.params.id, updates);
  //     if (!section) {
  //       res.status(404).json({ message: "Section not found" });
  //       return;
  //     }
  //     res.json(section);
  //   } catch (error) {
  //     console.error("Error updating section:", error);
  //     res.status(500).json({ message: "Failed to update section" });
  //   }
  // });

  // app.delete("/api/project-sections/:id", requireAuth, async (req, res) => {
  //   try {
  //     const success = await storage.deleteProjectSection(req.params.id);
  //     if (!success) {
  //       res.status(404).json({ message: "Section not found" });
  //       return;
  //     }
  //     res.status(204).send();
  //   } catch (error) {
  //     console.error("Error deleting section:", error);
  //     res.status(500).json({ message: "Failed to delete section" });
  //   }
  // });

  // Project Status Updates
  app.get("/api/project-status-updates/:projectId", requireAuth, async (req, res) => {
    try {
      const updates = await db
        .select({
          id: projectStatusUpdates.id,
          projectId: projectStatusUpdates.projectId,
          status: projectStatusUpdates.status,
          description: projectStatusUpdates.description,
          userId: projectStatusUpdates.userId,
          createdAt: projectStatusUpdates.createdAt,
          userName: users.displayName,
          userEmail: users.email,
        })
        .from(projectStatusUpdates)
        .leftJoin(users, eq(projectStatusUpdates.userId, users.id))
        .where(eq(projectStatusUpdates.projectId, req.params.projectId))
        .orderBy(desc(projectStatusUpdates.createdAt));
      res.json(updates);
    } catch (error) {
      console.error("Error fetching status updates:", error);
      res.status(500).json({ message: "Failed to fetch status updates" });
    }
  });

  app.post("/api/project-status-updates", requireAuth, async (req, res) => {
    try {
      const { projectId, status, description, userId } = req.body;
      const [statusUpdate] = await db
        .insert(projectStatusUpdates)
        .values({ projectId, status, description, userId })
        .returning();
      res.status(201).json(statusUpdate);
    } catch (error) {
      console.error("Error creating status update:", error);
      res.status(500).json({ message: "Failed to create status update" });
    }
  });

  // Project Budgets
  app.get("/api/project-budgets/:projectId", requireAuth, async (req, res) => {
    try {
      const budgets = await db
        .select()
        .from(projectBudgets)
        .where(eq(projectBudgets.projectId, req.params.projectId))
        .orderBy(desc(projectBudgets.createdAt));
      res.json(budgets);
    } catch (error) {
      console.error("Error fetching budgets:", error);
      res.status(500).json({ message: "Failed to fetch budgets" });
    }
  });

  app.post("/api/project-budgets", requireAuth, async (req, res) => {
    try {
      const { projectId, name, type, amount, currency, billDate, category, description } = req.body;
      const [budget] = await db
        .insert(projectBudgets)
        .values({ projectId, name, type, amount, currency: currency || "USD", billDate, category, description })
        .returning();
      res.status(201).json(budget);
    } catch (error) {
      console.error("Error creating budget:", error);
      res.status(500).json({ message: "Failed to create budget" });
    }
  });

  // Project Costs
  app.get("/api/project-costs/:projectId", requireAuth, async (req, res) => {
    try {
      const costs = await db
        .select()
        .from(projectCosts)
        .where(eq(projectCosts.projectId, req.params.projectId))
        .orderBy(desc(projectCosts.createdAt));
      res.json(costs);
    } catch (error) {
      console.error("Error fetching costs:", error);
      res.status(500).json({ message: "Failed to fetch costs" });
    }
  });

  app.post("/api/project-costs", requireAuth, async (req, res) => {
    try {
      const { projectId, name, type, amount, currency, date, category, description } = req.body;
      const [cost] = await db
        .insert(projectCosts)
        .values({ projectId, name, type, amount, currency: currency || "USD", date, category, description })
        .returning();
      res.status(201).json(cost);
    } catch (error) {
      console.error("Error creating cost:", error);
      res.status(500).json({ message: "Failed to create cost" });
    }
  });

  app.patch("/api/project-costs/:id", requireAuth, async (req, res) => {
    try {
      const { name, type, amount, currency, date, category, description } = req.body;
      const [cost] = await db
        .update(projectCosts)
        .set({ name, type, amount, currency, date, category, description })
        .where(eq(projectCosts.id, req.params.id))
        .returning();

      if (!cost) {
        res.status(404).json({ message: "Cost not found" });
        return;
      }

      res.json(cost);
    } catch (error) {
      console.error("Error updating cost:", error);
      res.status(500).json({ message: "Failed to update cost" });
    }
  });

  app.delete("/api/project-costs/:id", requireAuth, async (req, res) => {
    try {
      const [cost] = await db
        .delete(projectCosts)
        .where(eq(projectCosts.id, req.params.id))
        .returning();

      if (!cost) {
        res.status(404).json({ message: "Cost not found" });
        return;
      }

      res.status(204).send();
    } catch (error) {
      console.error("Error deleting cost:", error);
      res.status(500).json({ message: "Failed to delete cost" });
    }
  });

  // Project Activities
  app.get("/api/project-activities/:projectId", requireAuth, async (req, res) => {
    try {
      const activities = await db
        .select()
        .from(projectActivities)
        .where(eq(projectActivities.projectId, req.params.projectId))
        .orderBy(desc(projectActivities.createdAt));
      res.json(activities);
    } catch (error) {
      console.error("Error fetching project activities:", error);
      res.status(500).json({ message: "Failed to fetch project activities" });
    }
  });

  app.post("/api/project-activities", requireAuth, async (req, res) => {
    try {
      const { projectId, userId, activityType, entityName, oldValue, newValue } = req.body;
      const [activity] = await db
        .insert(projectActivities)
        .values({ projectId, userId, activityType, entityName, oldValue, newValue })
        .returning();
      res.status(201).json(activity);
    } catch (error) {
      console.error("Error creating project activity:", error);
      res.status(500).json({ message: "Failed to create project activity" });
    }
  });

  // PATCH route for updating workspace project
  app.patch("/api/workspace-projects/:id", requireAuth, async (req, res) => {
    try {
      const updates = req.body;
      const [project] = await db
        .update(workspaceProjects)
        .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(workspaceProjects.id, req.params.id))
        .returning();

      if (!project) {
        res.status(404).json({ message: "Project not found" });
        return;
      }

      res.json(project);
    } catch (error) {
      console.error("Error updating project:", error);
      res.status(500).json({ message: "Failed to update project" });
    }
  });

  // Workspace Project Tasks Routes
  app.get("/api/projects/:projectId/tasks", requireAuth, async (req, res) => {
    try {
      const tasks = await db
        .select()
        .from(projects)
        .where(eq(projects.workspaceProjectId, req.params.projectId))
        .orderBy(desc(projects.createdAt));
      res.json(tasks);
    } catch (error) {
      console.error("Error fetching project tasks:", error);
      res.status(500).json({ message: "Failed to fetch project tasks" });
    }
  });

  app.post("/api/projects/:projectId/tasks", requireAuth, async (req, res) => {
    try {
      const taskData = {
        ...req.body,
        workspaceProjectId: req.params.projectId,
      };
      const validatedData = insertProjectSchema.parse(taskData);
      const [task] = await db
        .insert(projects)
        .values(validatedData)
        .returning();
      res.status(201).json(task);
    } catch (error) {
      console.error("Error creating project task:", error);
      res.status(500).json({ message: "Failed to create project task" });
    }
  });

  app.patch("/api/projects/:projectId/tasks/:taskId", requireAuth, async (req, res) => {
    try {
      const updates = req.body;
      const [task] = await db
        .update(projects)
        .set({ ...updates, lastUpdated: sql`CURRENT_TIMESTAMP` })
        .where(eq(projects.id, req.params.taskId))
        .returning();

      if (!task) {
        res.status(404).json({ message: "Task not found" });
        return;
      }

      res.json(task);
    } catch (error) {
      console.error("Error updating project task:", error);
      res.status(500).json({ message: "Failed to update project task" });
    }
  });

  // Project Budgets Routes
  app.get("/api/projects/:projectId/budgets", requireAuth, async (req, res) => {
    try {
      const budgets = await db
        .select()
        .from(projectBudgets)
        .where(eq(projectBudgets.projectId, req.params.projectId))
        .orderBy(desc(projectBudgets.createdAt));
      res.json(budgets);
    } catch (error) {
      console.error("Error fetching budgets:", error);
      res.status(500).json({ message: "Failed to fetch budgets" });
    }
  });

  app.post("/api/projects/:projectId/budgets", requireAuth, async (req, res) => {
    try {
      const validatedData = insertProjectBudgetSchema.parse(req.body);
      const [budget] = await db
        .insert(projectBudgets)
        .values(validatedData)
        .returning();
      res.status(201).json(budget);
    } catch (error) {
      console.error("Error creating budget:", error);
      res.status(500).json({ message: "Failed to create budget" });
    }
  });

  app.delete("/api/projects/:projectId/budgets/:id", requireAuth, async (req, res) => {
    try {
      await db
        .delete(projectBudgets)
        .where(eq(projectBudgets.id, req.params.id));
      res.status(200).json({ message: "Budget deleted successfully" });
    } catch (error) {
      console.error("Error deleting budget:", error);
      res.status(500).json({ message: "Failed to delete budget" });
    }
  });

  // Project Costs Routes
  app.get("/api/projects/:projectId/costs", requireAuth, async (req, res) => {
    try {
      const costs = await db
        .select()
        .from(projectCosts)
        .where(eq(projectCosts.projectId, req.params.projectId))
        .orderBy(desc(projectCosts.createdAt));
      res.json(costs);
    } catch (error) {
      console.error("Error fetching costs:", error);
      res.status(500).json({ message: "Failed to fetch costs" });
    }
  });

  app.post("/api/projects/:projectId/costs", requireAuth, async (req, res) => {
    try {
      const validatedData = insertProjectCostSchema.parse(req.body);
      const [cost] = await db
        .insert(projectCosts)
        .values(validatedData)
        .returning();
      res.status(201).json(cost);
    } catch (error) {
      console.error("Error creating cost:", error);
      res.status(500).json({ message: "Failed to create cost" });
    }
  });

  app.delete("/api/projects/:projectId/costs/:id", requireAuth, async (req, res) => {
    try {
      await db
        .delete(projectCosts)
        .where(eq(projectCosts.id, req.params.id));
      res.status(200).json({ message: "Cost deleted successfully" });
    } catch (error) {
      console.error("Error deleting cost:", error);
      res.status(500).json({ message: "Failed to delete cost" });
    }
  });

  // Object Storage Routes
  app.get("/objects/:objectPath(*)", requireAuth, async (req, res) => {
    const userId = (req.user as any)?.id;
    const objectStorageService = new ObjectStorageService();
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      const canAccess = await objectStorageService.canAccessObjectEntity({
        objectFile,
        userId: userId,
      });
      if (!canAccess) {
        return res.sendStatus(401);
      }
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error("Error checking object access:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.sendStatus(404);
      }
      return res.sendStatus(500);
    }
  });

  app.post("/api/objects/upload", requireAuth, async (req, res) => {
    try {
      const objectStorageService = new ObjectStorageService();
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      res.json({ uploadURL });
    } catch (error) {
      console.error("Error getting upload URL:", error);
      res.status(500).json({ error: "Failed to get upload URL" });
    }
  });

  // Project Attachments
  app.get("/api/project-attachments/:projectId", requireAuth, async (req, res) => {
    try {
      const attachments = await db
        .select()
        .from(projectAttachments)
        .where(eq(projectAttachments.projectId, req.params.projectId))
        .orderBy(desc(projectAttachments.createdAt));
      res.json(attachments);
    } catch (error) {
      console.error("Error fetching attachments:", error);
      res.status(500).json({ message: "Failed to fetch attachments" });
    }
  });

  app.post("/api/project-attachments/:projectId/upload", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const { projectId } = req.params;
      const file = (req as any).file as Express.Multer.File | undefined;
      const userId = (req.user as any)?.id;

      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      // Upload file to AWS S3
      const s3Result = await uploadFileToS3(file, projectId);

      const [attachment] = await db
        .insert(projectAttachments)
        .values({
          projectId,
          fileName: file.originalname,
          fileUrl: s3Result.publicUrl,
          fileSize: file.size,
          uploadedBy: userId,
        })
        .returning();

      res.status(201).json(attachment);
    } catch (error: any) {
      console.error("Error uploading project attachment:", error);
      res.status(500).json({ message: "Failed to upload project attachment", error: error.message });
    }
  });

  app.post("/api/project-attachments", requireAuth, async (req, res) => {
    try {
      const { projectId, fileName, fileUrl, fileSize } = req.body;
      const userId = (req.user as any)?.id;

      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const objectStorageService = new ObjectStorageService();
      const objectPath = await objectStorageService.trySetObjectEntityAclPolicy(
        fileUrl,
        {
          owner: userId,
          visibility: "public",
        },
      );

      const [attachment] = await db
        .insert(projectAttachments)
        .values({ projectId, fileName, fileUrl: objectPath, fileSize, uploadedBy: userId })
        .returning();

      res.status(201).json(attachment);
    } catch (error) {
      console.error("Error creating attachment:", error);
      res.status(500).json({ message: "Failed to create attachment" });
    }
  });

  app.delete("/api/project-attachments/:id", requireAuth, async (req, res) => {
    try {
      await db
        .delete(projectAttachments)
        .where(eq(projectAttachments.id, req.params.id));

      res.status(200).json({ message: "Attachment deleted successfully" });
    } catch (error) {
      console.error("Error deleting attachment:", error);
      res.status(500).json({ message: "Failed to delete attachment" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Migrated from Nexus: Workflows + Docs + Integrations
  // ══════════════════════════════════════════════════════════════════════════
  // Workflows
  app.use('/api/workflows', workflowRoutes);
  // Docs (advanced) — registers /api/docs/*, /api/public/docs/:token, /api/users/search
  registerDocsRoutes(app);
  // Doc editor AI (writing assist + chat) — needs GROQ_API_KEY
  app.use('/api/ai', aiRoutes);
  // Integrations
  registerSlackRoutes(app);
  app.use('/api/auth', integrationAuthRoutes);
  app.use('/api/integrations/settings', integrationSettingsRoutes);
  app.use('/api/calendar', calendarRoutes);
  app.use('/api/drive', driveRoutes);
  app.use('/api/gmail', gmailRoutes);
  app.use('/api/zapier', zapierRoutes);
  app.use('/api/zapier-platform', zapierPlatformRoutes);
  app.use('/api/github', githubRoutes);
  app.use('/api/integrations/github', githubIntegrationRoutes);
  app.use('/api/webhooks', githubWebhooksRoutes);
  app.use('/api/jira', jiraRoutes);
  app.use('/api/integrations/jira', jiraIntegrationRoutes);
  app.use('/api/webhooks', jiraWebhooksRoutes);
  app.use('/api/figma', figmaRoutes);
  app.use('/api/integrations/figma', figmaIntegrationRoutes);
  app.use('/api/integrations/calendar', calendarIntegrationRoutes);
  app.use('/api/integrations/outlook', outlookIntegrationRoutes);
  app.use('/api/outlook-email', outlookEmailRoutes);
  app.use('/api/outlook-calendar', outlookCalendarRoutes);
  app.use('/api/integrations/teams', teamsIntegrationRoutes);
  app.use('/api/ms-teams', msTeamsRoutes);
  app.use('/api/integrations/slack', slackIntegrationRoutes);
  app.use('/api/onedrive', onedriveRoutes);
  app.use('/api/salesforce', salesforceRoutes);
  app.use('/api/integrations/files', fileAttachmentsRoutes);
  app.use('/api/tasks', taskSubtasksChecklistsRoutes);
  app.use('/api/notifications', notificationRoutes);
}

// Dev / local: register all routes, then wrap in an HTTP server (with .listen).
export async function registerRoutes(app: Express): Promise<Server> {
  await registerAllRoutes(app);
  const httpServer = createServer(app);
  return httpServer;
}

// Vercel serverless: register all routes on the app, no HTTP server (Vercel owns the HTTP layer).
export async function registerRoutesServerless(app: Express): Promise<void> {
  await registerAllRoutes(app);
}
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const departmentEnum = pgEnum("department", ["Product", "Design", "Dev", "Marketing & Sales", "Bug Hunting Campaign"]);
export const userRoleEnum = pgEnum("user_role", ["user", "admin", "sub-admin"]);
export const statusEnum = pgEnum("status", ["Not Started", "In Progress", "Completed", "Blocked", "Reviewing", "Design Approval Needed", "Temporary Hold"]);
export const riskEnum = pgEnum("risk", ["Low", "Medium", "High"]);
export const taskTypeEnum = pgEnum("task_type", ["Operational", "Technical", "Strategic", "Hiring", "Financial"]);

export const stageEnum = pgEnum("stage", ["Others", "Pre-Event", "Day Of", "Post-Event", "During Event"]);
export const sprintStatusEnum = pgEnum("sprint_status", ["Planning", "Active", "Completed", "Cancelled"]);
export const viewTypeEnum = pgEnum("view_type", ["table", "kanban"]);

export const permissionLevelEnum = pgEnum("permission_level", ["full_access", "comment", "read_only"]);
export const privacyEnum = pgEnum("privacy", ["private", "shared"]);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  password: text("password"),
  role: userRoleEnum("role").notNull().default("user"),
  profilePicture: text("profile_picture"),
  isOnline: boolean("is_online").default(false),
  lastActivity: timestamp("last_activity").default(sql`CURRENT_TIMESTAMP`),
  resetToken: text("reset_token"),
  resetTokenExpiry: timestamp("reset_token_expiry"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  lastLogin: timestamp("last_login").default(sql`CURRENT_TIMESTAMP`),
  firstName: text("first_name"),
  lastName: text("last_name"),
  country: text("country"),
  phone: text("phone"),
  birthday: text("birthday"),
  language: text("language").default("English"),
  timezone: text("timezone").default("(GMT+00:00) UTC"),
  theme: text("theme").default("Auto"),
  dateFormat: text("date_format").default("31 Dec 2025"),
  timeFormat: text("time_format").default("12"),
  weekFormat: text("week_format").default("Monday"),
  hasCompletedOnboarding: boolean("has_completed_onboarding").default(false),
  onboardingUseCase: text("onboarding_use_case"),
  onboardingManagementArea: text("onboarding_management_area"),
  onboardingHeardFrom: text("onboarding_heard_from"),
  onboardingWorkspaceName: text("onboarding_workspace_name"),
  onboardingInterestedFeatures: text("onboarding_interested_features").array().default(sql`ARRAY[]::text[]`),
  // Email verification (for local auth)
  isEmailVerified: boolean("is_email_verified").default(false),
  emailVerificationToken: text("email_verification_token"),
  emailVerificationExpiry: timestamp("email_verification_expiry"),
  authProvider: text("auth_provider").default("local"), // 'local', 'google', 'microsoft'
  googleId: text("google_id"),
  microsoftId: text("microsoft_id"),
  isSoftSignup: boolean("is_soft_signup").default(false),
  emailNotifications: boolean("email_notifications").default(true),
  inAppNotifications: boolean("in_app_notifications").default(false),
  notifyTaskAssigned: boolean("notify_task_assigned").default(false),
  notifyMentions: boolean("notify_mentions").default(true),
  notifyComments: boolean("notify_comments").default(false),
  notifyDueDateReminders: boolean("notify_due_date_reminders").default(true),

  email2faEnabled: boolean("email_2fa_enabled").default(false),
  email2faCode: text("email_2fa_code"),
  email2faCodeExpiry: timestamp("email_2fa_code_expiry"),
  email2faPendingAction: text("email_2fa_pending_action"),

  totp2faEnabled: boolean("totp_2fa_enabled").default(false),
  totpSecret: text("totp_secret"),
  totpTempSecret: text("totp_temp_secret"),
  totpBackupCodes: text("totp_backup_codes").array().default(sql`ARRAY[]::text[]`),

  // Company / organisation (set when onboarding completes)
  companyId: varchar("company_id"),
  // Integration: Slack DM/mention mapping (migrated from Nexus)
  slackUserId: text("slack_user_id"),
});

export const teamMembers = pgTable("team_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  initials: text("initials").notNull(),
  department: departmentEnum("department").notNull(),
  avatarColor: text("avatar_color").default("#3B82F6"),
});

// ── Companies ─────────────────────────────────────────────────────────────────
export const companies = pgTable("companies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  ownerUserId: varchar("owner_user_id").notNull(),
  workRole: text("work_role"),
  workFunction: text("work_function"),
  useCase: text("use_case"),
  heardFrom: text("heard_from"),
  defaultSpaceId: varchar("default_space_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const projects = pgTable("projects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  department: departmentEnum("department").notNull(),
  task: text("task").notNull(),
  status: statusEnum("status").notNull().default("Not Started"),
  owner: text("owner"),
  stage: text("stage").default("Others"),
  startDate: text("start_date"), // Start date for task
  dueDate: text("due_date"), // Using text to match YYYY-MM-DD format
  completionPercentage: integer("completion_percentage").default(0),
  risk: text("risk"),
  notes: text("notes"),
  description: text("description"), // Detailed task description
  labels: text("labels").array().default(sql`ARRAY[]::text[]`), // Array of label names
  dependencies: text("dependencies").array().default(sql`ARRAY[]::text[]`), // Array of task IDs this task depends on
  linkedGoalId: varchar("linked_goal_id"), // Reference to associated goal
  sprintId: varchar("sprint_id"), // Reference to assigned sprint
  scheduledDate: text("scheduled_date"), // Calendar scheduled date
  effortEstimate: integer("effort_estimate").default(1), // Story points or hours estimate in minutes
  taskType: taskTypeEnum("task_type"), // Task category (Operational, Technical, etc.)
  workspaceProjectId: varchar("workspace_project_id"), // Link to workspace project
  sectionId: varchar("section_id"), // Link to section/group in list view
  lastUpdated: timestamp("last_updated").default(sql`CURRENT_TIMESTAMP`),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const goals = pgTable("goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description"),
  owner: text("owner"),
  targetDate: text("target_date"), // Using text to match YYYY-MM-DD format
  taskIds: text("task_ids").array().default(sql`ARRAY[]::text[]`), // Array of linked task IDs
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const sprints = pgTable("sprints", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  startDate: text("start_date").notNull(), // Using text to match YYYY-MM-DD format
  endDate: text("end_date").notNull(), // Using text to match YYYY-MM-DD format
  status: sprintStatusEnum("status").notNull().default("Planning"),
  teamMembers: text("team_members").array().default(sql`ARRAY[]::text[]`), // Array of team member names
  taskIds: text("task_ids").array().default(sql`ARRAY[]::text[]`), // Array of assigned task IDs
  totalEffort: integer("total_effort").default(0), // Total story points/hours
  completedEffort: integer("completed_effort").default(0), // Completed story points/hours
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const userSessions = pgTable("user_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  sessionId: text("session_id").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  loginTime: timestamp("login_time").default(sql`CURRENT_TIMESTAMP`),
  lastActivity: timestamp("last_activity").default(sql`CURRENT_TIMESTAMP`),
  isActive: boolean("is_active").default(true),
});

export const activityLogs = pgTable("activity_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  action: text("action").notNull(), // 'login', 'logout', 'task_created', 'task_updated', etc.
  details: text("details"), // JSON string with additional details
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  timestamp: timestamp("timestamp").default(sql`CURRENT_TIMESTAMP`),
});

export const invitations = pgTable("invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  role: userRoleEnum("role").notNull().default("user"),
  invitedBy: varchar("invited_by").notNull(), // User ID of admin who sent invite
  status: text("status").default("pending"), // 'pending', 'accepted', 'expired'
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  expiresAt: timestamp("expires_at"), // Optional expiry date
});

export const spaceInvitations = pgTable("space_invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  spaceId: varchar("space_id").notNull(),
  invitedByUserId: varchar("invited_by_user_id").notNull(), // owner who invited
  invitedEmail: text("invited_email").notNull(),
  invitedUserId: varchar("invited_user_id"), // filled if user already exists OR after soft-signup
  token: text("token").notNull().unique(), // the accept-invite token in the email link
  status: text("status").notNull().default("pending"), // 'pending' | 'accepted' | 'expired'
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  expiresAt: timestamp("expires_at"),
});

export const teams = pgTable("teams", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  icon: text("icon").notNull().default("Users"),
  color: text("color").notNull().default("#3B82F6"),
  description: text("description"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const viewPreferences = pgTable("view_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  teamId: varchar("team_id").notNull(),
  viewType: viewTypeEnum("view_type").notNull().default("table"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const kanbanColumns = pgTable("kanban_columns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  teamId: varchar("team_id").notNull(),
  name: text("name").notNull(),
  color: text("color").notNull().default("#6B7280"),
  icon: text("icon").default("📋"), // Emoji or icon identifier for the column
  order: integer("order").notNull().default(0),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const commentStatusEnum = pgEnum("comment_status", ["open", "resolved"]);
export const docCategoryEnum = pgEnum("doc_category", ["blank", "meeting_notes", "project_overview"]);
export const docSharingPermissionEnum = pgEnum("doc_sharing_permission", ["view", "edit", "comment", "edit_comment"]);
export const projectPrivacyEnum = pgEnum("project_privacy", ["private", "everyone", "specific_people"]);
export const projectLayoutEnum = pgEnum("project_layout", ["list", "kanban", "gantt"]);
export const projectStatusEnum = pgEnum("project_status", ["at_risk", "on_track", "off_track", "on_hold", "completed"]);
export const budgetTypeEnum = pgEnum("budget_type", ["fixed", "hourly"]);
export const activityTypeEnum = pgEnum("activity_type", ["status_changed", "task_completed", "task_added", "task_updated", "task_deleted", "member_added", "member_removed", "description_updated"]);

export const documents = pgTable("documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  content: text("content").default(""), // JSON content from TipTap editor
  yjsState: text("yjs_state"), // Base64 Yjs state for real-time collaboration (migrated from Nexus)
  ownerId: varchar("owner_id").notNull(),
  category: docCategoryEnum("category").notNull().default("blank"),
  tags: text("tags").array().default(sql`ARRAY[]::text[]`),
  isFavorite: boolean("is_favorite").default(false),
  isPinned: boolean("is_pinned").default(false),
  // Page hierarchy support
  parentDocumentId: varchar("parent_document_id"),
  pageOrder: integer("page_order").default(0),
  // Page style preferences
  fontStyle: text("font_style").default("system"),
  fontSize: text("font_size").default("default"),
  pageWidth: text("page_width").default("default"),
  // Music's original display toggles (kept for backward compat)
  showCoverImage: boolean("show_cover_image").default(false),
  showPageIconAndTitle: boolean("show_page_icon_and_title").default(true),
  showAuthor: boolean("show_author").default(false),
  showContributors: boolean("show_contributors").default(false),
  showSubtitle: boolean("show_subtitle").default(false),
  showLastModified: boolean("show_last_modified").default(true),
  showPageOutline: boolean("show_page_outline").default(false),
  // Advanced color/style fields (migrated from Nexus)
  backgroundColor: text("background_color").default("#ffffff"),
  textColor: text("text_color").default("#1f2937"),
  headingColor: text("heading_color").default("#111827"),
  h1Color: text("h1_color").default("#111827"),
  h2Color: text("h2_color").default("#1f2937"),
  h3Color: text("h3_color").default("#374151"),
  h4Color: text("h4_color").default("#4b5563"),
  h5Color: text("h5_color").default("#6b7280"),
  h6Color: text("h6_color").default("#9ca3af"),
  linkColor: text("link_color").default("#3b82f6"),
  codeBlockBg: text("code_block_bg").default("#f3f4f6"),
  codeBlockText: text("code_block_text").default("#1f2937"),
  blockquoteBg: text("blockquote_bg").default("#f9fafb"),
  blockquoteText: text("blockquote_text").default("#4b5563"),
  tableBorderColor: text("table_border_color").default("#e5e7eb"),
  tableHeaderBg: text("table_header_bg").default("#f3f4f6"),
  // Advanced header display options (migrated from Nexus)
  showPageTitleIcon: boolean("show_page_title_icon").default(true),
  showOwner: boolean("show_owner").default(true),
  showContributor: boolean("show_contributor").default(false),
  showDateUpdated: boolean("show_date_updated").default(true),
  isShared: boolean("is_shared").default(false),
  isProtected: boolean("is_protected").default(false),
  // Public link sharing (migrated from Nexus)
  publicLinkEnabled: boolean("public_link_enabled").default(false),
  publicLinkToken: varchar("public_link_token").unique(),
  publicLinkPermission: docSharingPermissionEnum("public_link_permission").default("view"),
  publicLinkExpiresAt: timestamp("public_link_expires_at"),
  publicLinkCreatedAt: timestamp("public_link_created_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
  lastViewedAt: timestamp("last_viewed_at"),
  lastUpdatedBy: varchar("last_updated_by"),
  deletedAt: timestamp("deleted_at"), // soft-delete (trash)
});

export const documentComments = pgTable("document_comments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull(),
  userId: varchar("user_id").notNull(),
  content: text("content").notNull(),
  selectedText: text("selected_text"),
  parentId: varchar("parent_id"),
  status: commentStatusEnum("status").notNull().default("open"),
  mentionedUserIds: text("mentioned_user_ids").array().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});



//Spaces Schema
export const spaces = pgTable("spaces", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  iconUrl: text("icon_url").notNull(),
  description: text("description"),
  defaultPermission: permissionLevelEnum("default_permission").notNull().default("full_access"),
  privacy: privacyEnum("privacy").notNull().default("private"),
  memberIds: text("member_ids").array().default(sql`ARRAY[]::text[]`),
  teamIds: text("team_ids").array().default(sql`ARRAY[]::text[]`),
  ownerId: varchar("owner_id").notNull(),
  companyId: varchar("company_id"),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), // ✅ Add .notNull()
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`), // ✅ Add .notNull()
});

export const spaceStatuses = pgTable("space_statuses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  spaceId: varchar("space_id").notNull(),
  name: text("name").notNull(),
  colorCode: text("color_code").notNull(),
  order: integer("order").notNull().default(0), // ✅ ADD THIS LINE
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});


export const tasks = pgTable("tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  spaceId: varchar("space_id").notNull(),
  name: text("name").notNull(),
  description: text("description").default(""),
  statusId: varchar("status_id").notNull(),
  priority: text("priority"),
  ownerId: varchar("owner_id").notNull(),
  assigneeIds: text("assignee_ids").array().notNull().default(sql`ARRAY[]::text[]`),
  dueDate: text("due_date"),
  labels: text("labels").array().default(sql`ARRAY[]::text[]`),
  estimatedHours: text("estimated_hours"),
  actualHours: text("actual_hours"),
  attachments: text("attachments").array().default(sql`ARRAY[]::text[]`),
  order: integer("order").notNull().default(0),
  // Columns added for integrations (migrated from Nexus)
  shortId: integer("short_id"),
  startDate: text("start_date"),
  sprintPoints: integer("sprint_points"),
  trackedSeconds: integer("tracked_seconds").default(0),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

//Spaces Schema end

// ─── Task Comments ──────────────────────────────────────────────────────────
export const taskComments = pgTable("task_comments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  userId: varchar("user_id").notNull(),
  content: text("content").notNull(),
  mentionedUserIds: text("mentioned_user_ids").array().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export type TaskComment = typeof taskComments.$inferSelect;
export type InsertTaskComment = typeof taskComments.$inferInsert;


export const workspaceProjects = pgTable("workspace_projects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  color: text("color").notNull().default("#3B82F6"),
  startDate: text("start_date"), // YYYY-MM-DD format
  endDate: text("end_date"), // YYYY-MM-DD format
  ownerId: varchar("owner_id").notNull(), // User who created the project
  privacy: projectPrivacyEnum("privacy").notNull().default("private"),
  memberIds: text("member_ids").array().default(sql`ARRAY[]::text[]`), // Array of user IDs for specific_people privacy
  defaultLayout: projectLayoutEnum("default_layout").notNull().default("list"),
  description: text("description"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const projectSections = pgTable("project_sections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull(), // Workspace project this section belongs to
  name: text("name").notNull(),
  order: integer("order").notNull().default(0), // For drag-and-drop reordering
  isCollapsed: boolean("is_collapsed").default(false),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const projectStatusUpdates = pgTable("project_status_updates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull(),
  status: projectStatusEnum("status").notNull(),
  description: text("description"),
  userId: varchar("user_id").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const projectBudgets = pgTable("project_budgets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull(),
  name: text("name").notNull(),
  type: budgetTypeEnum("type").notNull(),
  amount: integer("amount").notNull(), // Amount in cents
  currency: text("currency").default("USD"),
  billDate: text("bill_date"), // YYYY-MM-DD format
  category: text("category"),
  description: text("description"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const projectCosts = pgTable("project_costs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull(),
  name: text("name").notNull(),
  type: budgetTypeEnum("type").notNull(),
  amount: integer("amount").notNull(), // Amount in cents
  currency: text("currency").default("USD"),
  date: text("date"), // YYYY-MM-DD format
  category: text("category"),
  description: text("description"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const projectAttachments = pgTable("project_attachments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull(),
  fileName: text("file_name").notNull(),
  fileUrl: text("file_url").notNull(),
  fileSize: integer("file_size"), // Size in bytes
  uploadedBy: varchar("uploaded_by").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const projectActivities = pgTable("project_activities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull(),
  userId: varchar("user_id").notNull(),
  activityType: activityTypeEnum("activity_type").notNull(),
  entityName: text("entity_name"), // Name of the task/entity that was affected
  oldValue: text("old_value"), // Previous value for changes
  newValue: text("new_value"), // New value for changes
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(userSessions),
  activityLogs: many(activityLogs),
}));

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, { fields: [userSessions.userId], references: [users.id] }),
}));

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  user: one(users, { fields: [activityLogs.userId], references: [users.id] }),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  inviter: one(users, { fields: [invitations.invitedBy], references: [users.id] }),
}));

// export const teamMembersRelations = relations(teamMembers, ({ many }) => ({
//   projects: many(projects),
// }));

export const viewPreferencesRelations = relations(viewPreferences, ({ one }) => ({
  user: one(users, { fields: [viewPreferences.userId], references: [users.id] }),
  team: one(teams, { fields: [viewPreferences.teamId], references: [teams.id] }),
}));

export const kanbanColumnsRelations = relations(kanbanColumns, ({ one }) => ({
  team: one(teams, { fields: [kanbanColumns.teamId], references: [teams.id] }),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  owner: one(users, { fields: [documents.ownerId], references: [users.id] }),
  comments: many(documentComments),
  parentDocument: one(documents, {
    fields: [documents.parentDocumentId],
    references: [documents.id],
    relationName: "parentChild",
  }),
  childPages: many(documents, { relationName: "parentChild" }),
}));

export const documentCommentsRelations = relations(documentComments, ({ one }) => ({
  document: one(documents, { fields: [documentComments.documentId], references: [documents.id] }),
  user: one(users, { fields: [documentComments.userId], references: [users.id] }),
}));

export const workspaceProjectsRelations = relations(workspaceProjects, ({ one }) => ({
  owner: one(users, { fields: [workspaceProjects.ownerId], references: [users.id] }),
}));

// ========== ADD THESE THREE NEW RELATIONS HERE ==========
export const spacesRelations = relations(spaces, ({ one, many }) => ({
  owner: one(users, { fields: [spaces.ownerId], references: [users.id] }),
  company: one(companies, { fields: [spaces.companyId], references: [companies.id] }),
  statuses: many(spaceStatuses),
  tasks: many(tasks),
}));

export const spaceStatusesRelations = relations(spaceStatuses, ({ one }) => ({
  space: one(spaces, { fields: [spaceStatuses.spaceId], references: [spaces.id] }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  space: one(spaces, { fields: [tasks.spaceId], references: [spaces.id] }),
  status: one(spaceStatuses, { fields: [tasks.statusId], references: [spaceStatuses.id] }),
  owner: one(users, { fields: [tasks.ownerId], references: [users.id] }),
}));

// ── Companies relations ───────────────────────────────────────────────────────
export const companiesRelations = relations(companies, ({ one, many }) => ({
  owner: one(users, { fields: [companies.ownerUserId], references: [users.id] }),
  defaultSpace: one(spaces, { fields: [companies.defaultSpaceId], references: [spaces.id] }),
}));

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  lastLogin: true,
  lastActivity: true,
  isOnline: true,
});

export const insertUserSessionSchema = createInsertSchema(userSessions).omit({
  id: true,
  loginTime: true,
  lastActivity: true,
});

export const insertActivityLogSchema = createInsertSchema(activityLogs).omit({
  id: true,
  timestamp: true,
});

export const insertInvitationSchema = createInsertSchema(invitations).omit({
  id: true,
  createdAt: true,
});

export const insertTeamSchema = createInsertSchema(teams).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateTeamSchema = insertTeamSchema.partial();

export const insertViewPreferenceSchema = createInsertSchema(viewPreferences).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertKanbanColumnSchema = createInsertSchema(kanbanColumns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateKanbanColumnSchema = insertKanbanColumnSchema.partial();

export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateDocumentSchema = insertDocumentSchema.partial();

export const insertDocumentCommentSchema = createInsertSchema(documentComments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateDocumentCommentSchema = insertDocumentCommentSchema.partial();

export const insertWorkspaceProjectSchema = createInsertSchema(workspaceProjects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateWorkspaceProjectSchema = insertWorkspaceProjectSchema.partial();

export const insertProjectSectionSchema = createInsertSchema(projectSections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateProjectSectionSchema = insertProjectSectionSchema.partial();

export const insertTeamMemberSchema = createInsertSchema(teamMembers).omit({
  id: true,
});

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  lastUpdated: true,
  createdAt: true,
});

export const updateProjectSchema = insertProjectSchema.partial();

export const insertGoalSchema = createInsertSchema(goals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateGoalSchema = insertGoalSchema.partial();

export const insertSprintSchema = createInsertSchema(sprints).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateSprintSchema = insertSprintSchema.partial();

export const updateUserSchema = insertUserSchema.partial();
export const updateUserRoleSchema = z.object({
  role: z.enum(["user", "admin", "sub-admin"]),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type TeamMember = typeof teamMembers.$inferSelect;
export type InsertTeamMember = z.infer<typeof insertTeamMemberSchema>;
export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type UpdateProject = z.infer<typeof updateProjectSchema>;
export type Goal = typeof goals.$inferSelect;
export type InsertGoal = z.infer<typeof insertGoalSchema>;
export type UpdateGoal = z.infer<typeof updateGoalSchema>;
export type Sprint = typeof sprints.$inferSelect;
export type InsertSprint = z.infer<typeof insertSprintSchema>;
export type UpdateSprint = z.infer<typeof updateSprintSchema>;
export type UpdateUser = z.infer<typeof updateUserSchema>;
export type InsertUserSession = z.infer<typeof insertUserSessionSchema>;
export type UserSession = typeof userSessions.$inferSelect;
export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type UpdateUserRole = z.infer<typeof updateUserRoleSchema>;
export type InsertInvitation = z.infer<typeof insertInvitationSchema>;
export type Invitation = typeof invitations.$inferSelect;
export type InsertTeam = z.infer<typeof insertTeamSchema>;
export type Team = typeof teams.$inferSelect;
export type UpdateTeam = z.infer<typeof updateTeamSchema>;
export type InsertViewPreference = z.infer<typeof insertViewPreferenceSchema>;
export type ViewPreference = typeof viewPreferences.$inferSelect;
export type InsertKanbanColumn = z.infer<typeof insertKanbanColumnSchema>;
export type KanbanColumn = typeof kanbanColumns.$inferSelect;
export type UpdateKanbanColumn = z.infer<typeof updateKanbanColumnSchema>;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documents.$inferSelect;
export type UpdateDocument = z.infer<typeof updateDocumentSchema>;
export type InsertDocumentComment = z.infer<typeof insertDocumentCommentSchema>;
export type DocumentComment = typeof documentComments.$inferSelect;
export type UpdateDocumentComment = z.infer<typeof updateDocumentCommentSchema>;
export type InsertWorkspaceProject = z.infer<typeof insertWorkspaceProjectSchema>;
export type WorkspaceProject = typeof workspaceProjects.$inferSelect;
export type UpdateWorkspaceProject = z.infer<typeof updateWorkspaceProjectSchema>;
export type InsertProjectSection = z.infer<typeof insertProjectSectionSchema>;
export type ProjectSection = typeof projectSections.$inferSelect;
export type UpdateProjectSection = z.infer<typeof updateProjectSectionSchema>;

export const insertProjectStatusUpdateSchema = createInsertSchema(projectStatusUpdates).omit({
  id: true,
  createdAt: true,
});

export const insertProjectBudgetSchema = createInsertSchema(projectBudgets).omit({
  id: true,
  createdAt: true,
});

export const insertProjectCostSchema = createInsertSchema(projectCosts).omit({
  id: true,
  createdAt: true,
});

export const insertProjectAttachmentSchema = createInsertSchema(projectAttachments).omit({
  id: true,
  createdAt: true,
});

export const insertProjectActivitySchema = createInsertSchema(projectActivities).omit({
  id: true,
  createdAt: true,
});

// ── Space Favourites ──────────────────────────────────────────────────────────
export const spaceFavourites = pgTable("space_favourites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  spaceId: varchar("space_id").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ── Space Recent Activity ─────────────────────────────────────────────────────
// Tracks the last time a user had activity in a space (task create/update)
export const spaceRecentActivity = pgTable("space_recent_activity", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  spaceId: varchar("space_id").notNull(),
  lastActivityAt: timestamp("last_activity_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ========== ADD THESE SCHEMAS HERE ==========
export const insertSpaceSchema = createInsertSchema(spaces).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  statuses: z.array(z.object({
    name: z.string().min(1),
    colorCode: z.string(),
    order: z.number().optional(), // ✅ ADD THIS LINE (optional since we'll auto-assign)
  })).min(1, "At least one status is required"),
});

export const updateSpaceSchema = insertSpaceSchema.partial();

export const insertSpaceStatusSchema = createInsertSchema(spaceStatuses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  order: z.number().optional(), // ✅ ADD THIS LINE
});

export const updateSpaceStatusSchema = insertSpaceStatusSchema.partial();

export const insertTaskSchema = createInsertSchema(tasks)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    name: z.string().min(1, "Task name is required"),
    description: z.string().optional(),
    priority: z.enum(["low", "normal", "high"]).nullable().optional(),
    ownerId: z.string().min(1, "Owner is required"),
    assigneeIds: z.array(z.string()).optional().default([]),
    dueDate: z.string().nullable().optional(),
    statusId: z.string().min(1, "Status is required"),
    spaceId: z.string().min(1, "Space is required"),
    estimatedHours: z.string().nullable().optional(),
    actualHours: z.string().nullable().optional(),
  });

export const updateTaskSchema = insertTaskSchema.partial();

export type InsertProjectStatusUpdate = z.infer<typeof insertProjectStatusUpdateSchema>;
export type ProjectStatusUpdate = typeof projectStatusUpdates.$inferSelect;
export type InsertProjectBudget = z.infer<typeof insertProjectBudgetSchema>;
export type ProjectBudget = typeof projectBudgets.$inferSelect;
export type InsertProjectCost = z.infer<typeof insertProjectCostSchema>;
export type ProjectCost = typeof projectCosts.$inferSelect;
export type InsertProjectAttachment = z.infer<typeof insertProjectAttachmentSchema>;
export type ProjectAttachment = typeof projectAttachments.$inferSelect;
export type InsertProjectActivity = z.infer<typeof insertProjectActivitySchema>;
export type ProjectActivity = typeof projectActivities.$inferSelect;
// ========== ADD THESE TYPES AT THE END ==========
export type InsertSpace = z.infer<typeof insertSpaceSchema>;
export type Space = typeof spaces.$inferSelect;
export type UpdateSpace = z.infer<typeof updateSpaceSchema>;

export type InsertSpaceStatus = z.infer<typeof insertSpaceStatusSchema>;
export type SpaceStatus = typeof spaceStatuses.$inferSelect;
export type UpdateSpaceStatus = z.infer<typeof updateSpaceStatusSchema>;

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;
export type UpdateTask = z.infer<typeof updateTaskSchema>;

export type SpaceInvitation = typeof spaceInvitations.$inferSelect;
export type InsertSpaceInvitation = typeof spaceInvitations.$inferInsert;

export type SpaceFavourite = typeof spaceFavourites.$inferSelect;
export type SpaceRecentActivity = typeof spaceRecentActivity.$inferSelect;

// ── Company schemas & types ───────────────────────────────────────────────────
export const insertCompanySchema = createInsertSchema(companies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateCompanySchema = insertCompanySchema.partial();

export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companies.$inferSelect;
export type UpdateCompany = z.infer<typeof updateCompanySchema>;

// ─── Workflows (migrated from Nexus) ──────────────────────────────────────────
export const workflowStatusEnum = pgEnum("workflow_status", ["draft", "live", "paused"]);

export const workflows = pgTable("workflows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  status: workflowStatusEnum("status").notNull().default("draft"),
  ownerId: varchar("owner_id").notNull(),
  isFavorite: boolean("is_favorite").default(false),
  steps: jsonb("steps").notNull().default([]),
  lastPublished: timestamp("last_published"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const insertWorkflowSchema = createInsertSchema(workflows).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const updateWorkflowSchema = insertWorkflowSchema.partial();

export type Workflow = typeof workflows.$inferSelect;
export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>;
export type UpdateWorkflow = z.infer<typeof updateWorkflowSchema>;

export const workflowLogs = pgTable("workflow_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workflowId: varchar("workflow_id").notNull(),
  trigger: text("trigger").notNull(),
  actionsTaken: jsonb("actions_taken").default([]),
  taskId: varchar("task_id"),
  status: text("status").notNull().default("success"),
  error: text("error"),
  executedAt: timestamp("executed_at").default(sql`CURRENT_TIMESTAMP`),
});

export const insertWorkflowLogSchema = createInsertSchema(workflowLogs).omit({
  id: true,
  executedAt: true,
});

export type WorkflowLog = typeof workflowLogs.$inferSelect;
export type InsertWorkflowLog = z.infer<typeof insertWorkflowLogSchema>;


// DOCS — advanced feature migrated from Nexus
// (documents + documentComments tables/enums were extended above; the basic
//  insertDocumentSchema / Document types already exist and auto-derive from the
//  now-extended tables. Below: the 6 NEW doc tables + relations + Zod + types.)
// ═══════════════════════════════════════════════════════════════════════════

export const documentShares = pgTable("document_shares", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull(),
  userId: varchar("user_id").notNull(),
  permission: docSharingPermissionEnum("permission").notNull().default("view"),
  sharedBy: varchar("shared_by").notNull(),
  sharedAt: timestamp("shared_at").default(sql`CURRENT_TIMESTAMP`),
  lastViewedAt: timestamp("last_viewed_at"),
});

export const documentInvites = pgTable("document_invites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull(),
  email: text("email").notNull(),
  permission: docSharingPermissionEnum("permission").notNull().default("view"),
  invitedBy: varchar("invited_by").notNull(),
  token: varchar("token").unique().notNull(),
  status: text("status").default("pending"), // 'pending', 'accepted', 'expired', 'revoked'
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  acceptedByUserId: varchar("accepted_by_user_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const documentTemplates = pgTable("document_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description"),
  content: text("content").default(""),
  category: text("category").notNull().default("general"),
  icon: text("icon"),
  iconColor: text("icon_color").default("#3B82F6"),
  isSystem: boolean("is_system").default(false),
  createdBy: varchar("created_by"),
  isPublic: boolean("is_public").default(true),
  usageCount: integer("usage_count").default(0),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const documentVersions = pgTable("document_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull(),
  title: text("title").notNull(),
  content: text("content").default(""),
  createdBy: varchar("created_by").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  versionNumber: integer("version_number").notNull().default(1),
  changeType: text("change_type").notNull().default("auto"), // "auto" | "manual" | "restore"
  wordCount: integer("word_count").default(0),
});

export const documentSpaces = pgTable("document_spaces", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  icon: text("icon").default("folder"),
  color: text("color").default("#3B82F6"),
  ownerId: varchar("owner_id").notNull(),
  parentSpaceId: varchar("parent_space_id"),
  sortOrder: integer("sort_order").default(0),
  isPrivate: boolean("is_private").default(false),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const documentSpaceMembers = pgTable("document_space_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  spaceId: varchar("space_id").notNull(),
  documentId: varchar("document_id").notNull(),
  addedAt: timestamp("added_at").default(sql`CURRENT_TIMESTAMP`),
});

// ── Doc relations (new) ──────────────────────────────────────────────────────
export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, { fields: [documentVersions.documentId], references: [documents.id] }),
  creator: one(users, { fields: [documentVersions.createdBy], references: [users.id] }),
}));

// ── Doc Zod schemas (new) ────────────────────────────────────────────────────
export const insertDocumentShareSchema = createInsertSchema(documentShares).omit({
  id: true,
  sharedAt: true,
});
export const updateDocumentShareSchema = insertDocumentShareSchema.partial();

export const insertDocumentInviteSchema = createInsertSchema(documentInvites).omit({
  id: true,
  createdAt: true,
  acceptedAt: true,
  acceptedByUserId: true,
});
export const updateDocumentInviteSchema = insertDocumentInviteSchema.partial();

export const inviteByEmailRequestSchema = z.object({
  email: z.string().email("Invalid email address"),
  permission: z.enum(["view", "edit", "comment", "edit_comment"], {
    errorMap: () => ({ message: "Permission must be one of: view, edit, comment, edit_comment" }),
  }),
});

export const shareDocumentRequestSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  permission: z.enum(["view", "edit", "comment", "edit_comment"], {
    errorMap: () => ({ message: "Permission must be one of: view, edit, comment, edit_comment" }),
  }),
});

export const updateSharePermissionRequestSchema = z.object({
  permission: z.enum(["view", "edit", "comment", "edit_comment"], {
    errorMap: () => ({ message: "Permission must be one of: view, edit, comment, edit_comment" }),
  }),
});

export const insertDocumentTemplateSchema = createInsertSchema(documentTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const updateDocumentTemplateSchema = insertDocumentTemplateSchema.partial();

export const insertDocumentSpaceSchema = createInsertSchema(documentSpaces).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const updateDocumentSpaceSchema = insertDocumentSpaceSchema.partial();

export const insertDocumentSpaceMemberSchema = createInsertSchema(documentSpaceMembers).omit({
  id: true,
  addedAt: true,
});

// ── Doc type exports (new) ───────────────────────────────────────────────────
export type InsertDocumentShare = z.infer<typeof insertDocumentShareSchema>;
export type DocumentShare = typeof documentShares.$inferSelect;
export type UpdateDocumentShare = z.infer<typeof updateDocumentShareSchema>;

export type InsertDocumentInvite = z.infer<typeof insertDocumentInviteSchema>;
export type DocumentInvite = typeof documentInvites.$inferSelect;
export type UpdateDocumentInvite = z.infer<typeof updateDocumentInviteSchema>;
export type InviteByEmailRequest = z.infer<typeof inviteByEmailRequestSchema>;
export type ShareDocumentRequest = z.infer<typeof shareDocumentRequestSchema>;
export type UpdateSharePermissionRequest = z.infer<typeof updateSharePermissionRequestSchema>;

export type InsertDocumentTemplate = z.infer<typeof insertDocumentTemplateSchema>;
export type DocumentTemplate = typeof documentTemplates.$inferSelect;
export type UpdateDocumentTemplate = z.infer<typeof updateDocumentTemplateSchema>;

export type InsertDocumentSpace = z.infer<typeof insertDocumentSpaceSchema>;
export type DocumentSpace = typeof documentSpaces.$inferSelect;
export type UpdateDocumentSpace = z.infer<typeof updateDocumentSpaceSchema>;

export type InsertDocumentSpaceMember = z.infer<typeof insertDocumentSpaceMemberSchema>;
export type DocumentSpaceMember = typeof documentSpaceMembers.$inferSelect;

export type DocumentVersion = typeof documentVersions.$inferSelect;

// ── Doc helper types (hand-written; used by storage modules) ──────────────────
export type SharedUserInfo = {
  id: string;
  displayName: string;
  email: string;
  profilePicture: string | null;
  permission: "view" | "edit" | "comment" | "edit_comment";
};

export type LastUpdaterInfo = {
  id: string;
  displayName: string;
  email: string;
  profilePicture: string | null;
};

export type DocumentWithOwner = Document & {
  owner: {
    id: string;
    displayName: string;
    email: string;
    profilePicture: string | null;
  } | null;
  sharedWith?: SharedUserInfo[];
  shareCount?: number;
  lastUpdater?: LastUpdaterInfo | null;
};

export type PageTreeNode = {
  id: string;
  title: string;
  pageOrder: number;
  parentDocumentId: string | null;
  children: PageTreeNode[];
};

export type DocumentSpaceWithMeta = DocumentSpace & {
  documentCount: number;
  children: DocumentSpaceWithMeta[];
};

export type DocumentVersionWithCreator = DocumentVersion & {
  creator: {
    id: string;
    displayName: string;
    profilePicture: string | null;
  } | null;
};

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATIONS — migrated from Nexus (Slack, Drive, Calendar, GitHub, Jira,
// Figma, Outlook/Gmail email, Zapier, file attachments, subtasks/checklists).
// Note: workflows + workflow_logs already exist in clicksHQ (added earlier),
// so those Nexus lines are intentionally NOT included here.
// ═══════════════════════════════════════════════════════════════════════════

// ── Zapier OAuth (codes + tokens) ────────────────────────────────────────────
export const zapierOAuthCodes = pgTable("zapier_oauth_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  userId: varchar("user_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").default(false),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// Zapier OAuth access tokens — long-lived tokens for Zapier to call our API
export const zapierOAuthTokens = pgTable("zapier_oauth_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accessToken: text("access_token").notNull().unique(),
  userId: varchar("user_id").notNull(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  lastUsedAt: timestamp("last_used_at"),
});


// ── Slack + generic user integrations + Zapier webhooks + API keys ───────────
export const slackNotificationStatusEnum = pgEnum("slack_notification_status", ["pending", "sent", "failed", "retrying"]);

export const slackIntegrations = pgTable("slack_integrations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  teamId: text("team_id").notNull().unique(),
  teamName: text("team_name").notNull(),
  accessToken: text("access_token").notNull(),
  botUserId: text("bot_user_id"),
  defaultChannelId: text("default_channel_id"),
  defaultChannelName: text("default_channel_name"),
  isEnabled: boolean("is_enabled").default(true),
  installedByUserId: varchar("installed_by_user_id").notNull(),
  webhookUrl: text("webhook_url"),
  scopes: text("scopes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const slackNotificationLogs = pgTable("slack_notification_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  slackIntegrationId: varchar("slack_integration_id").notNull(),
  channelId: text("channel_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull(),
  status: slackNotificationStatusEnum("status").notNull().default("pending"),
  retryCount: integer("retry_count").default(0),
  maxRetries: integer("max_retries").default(3),
  lastError: text("last_error"),
  entityId: varchar("entity_id"),
  triggeredByUserId: varchar("triggered_by_user_id"),
  sentAt: timestamp("sent_at"),
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const slackChannelMappings = pgTable("slack_channel_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  slackIntegrationId: varchar("slack_integration_id").notNull(),
  workspaceProjectId: varchar("workspace_project_id"),
  spaceId: varchar("space_id"),
  channelId: text("channel_id").notNull(),
  channelName: text("channel_name").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const slackUserNotificationPreferences = pgTable("slack_user_notification_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  channelTaskCreated: boolean("channel_task_created").default(true),
  channelStatusChanged: boolean("channel_status_changed").default(true),
  channelNewComment: boolean("channel_new_comment").default(true),
  channelAssigneesChanged: boolean("channel_assignees_changed").default(true),
  channelMentioned: boolean("channel_mentioned").default(true),
  dmTaskAssigned: boolean("dm_task_assigned").default(true),
  dmTaskCompleted: boolean("dm_task_completed").default(true),
  dmCommentOnMyTask: boolean("dm_comment_on_my_task").default(true),
  dmMentioned: boolean("dm_mentioned").default(true),
  dmStatusChangeOnMyTask: boolean("dm_status_change_on_my_task").default(true),
  dmDeadlineApproaching: boolean("dm_deadline_approaching").default(true),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

// Slack Zod schemas
export const insertSlackIntegrationSchema = createInsertSchema(slackIntegrations).omit({ id: true, createdAt: true, updatedAt: true });
export const updateSlackIntegrationSchema = insertSlackIntegrationSchema.partial();
export const insertSlackNotificationLogSchema = createInsertSchema(slackNotificationLogs).omit({ id: true, createdAt: true });
export const updateSlackNotificationLogSchema = insertSlackNotificationLogSchema.partial();
export const insertSlackChannelMappingSchema = createInsertSchema(slackChannelMappings).omit({ id: true, createdAt: true });
export const updateSlackNotificationPreferencesSchema = createInsertSchema(slackUserNotificationPreferences).omit({ id: true, userId: true, createdAt: true, updatedAt: true });

// ==================== INTEGRATION TABLES (Google Calendar, Google Drive, etc.) ====================

export const userIntegrations = pgTable('user_integrations', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar('user_id').notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  tokenExpiry: timestamp('token_expiry').notNull(),
  scope: text('scope'),
  providerUserId: text('provider_user_id'),
  providerEmail: text('provider_email'),
  metadata: text('metadata'),
  connectedAt: timestamp('connected_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const taskDriveAttachments = pgTable('task_drive_attachments', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar('task_id').notNull(),
  userId: varchar('user_id').notNull(),
  fileId: varchar('file_id').notNull(),
  fileName: varchar('file_name').notNull(),
  mimeType: varchar('mime_type'),
  webViewLink: text('web_view_link'),
  iconLink: text('icon_link'),
  thumbnailLink: text('thumbnail_link'),
  attachedAt: timestamp('attached_at', { withTimezone: true }).defaultNow(),
});

export const userIntegrationSettings = pgTable('user_integration_settings', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar('user_id').notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  settingKey: varchar('setting_key', { length: 100 }).notNull(),
  enabled: boolean('enabled').default(false),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Integration Zod schemas
export const insertUserIntegrationSchema = createInsertSchema(userIntegrations);
export const insertTaskDriveAttachmentSchema = createInsertSchema(taskDriveAttachments);
export const insertUserIntegrationSettingSchema = createInsertSchema(userIntegrationSettings);

// Integration types
export type UserIntegration = typeof userIntegrations.$inferSelect;
export type InsertUserIntegration = z.infer<typeof insertUserIntegrationSchema>;
export type TaskDriveAttachment = typeof taskDriveAttachments.$inferSelect;
export type InsertTaskDriveAttachment = z.infer<typeof insertTaskDriveAttachmentSchema>;
export type UserIntegrationSetting = typeof userIntegrationSettings.$inferSelect;
export type InsertUserIntegrationSetting = z.infer<typeof insertUserIntegrationSettingSchema>;

// Slack types
export type SlackIntegration = typeof slackIntegrations.$inferSelect;
export type InsertSlackIntegration = z.infer<typeof insertSlackIntegrationSchema>;
export type UpdateSlackIntegration = z.infer<typeof updateSlackIntegrationSchema>;
export type SlackNotificationLog = typeof slackNotificationLogs.$inferSelect;
export type InsertSlackNotificationLog = z.infer<typeof insertSlackNotificationLogSchema>;
export type UpdateSlackNotificationLog = z.infer<typeof updateSlackNotificationLogSchema>;
export type SlackChannelMapping = typeof slackChannelMappings.$inferSelect;
export type InsertSlackChannelMapping = z.infer<typeof insertSlackChannelMappingSchema>;
export type SlackNotificationPreferences = typeof slackUserNotificationPreferences.$inferSelect;
export type UpdateSlackNotificationPreferences = z.infer<typeof updateSlackNotificationPreferencesSchema>;

// ─── Zapier Webhook Integration ──────────────────────────────────────────────
export const zapierWebhooks = pgTable('zapier_webhooks', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar('user_id').notNull(),
  webhookUrl: text('webhook_url').notNull(),
  events: text('events').array().default(sql`ARRAY['task.created','task.updated','task.completed','task.assigned','comment.added']::text[]`),
  isActive: boolean('is_active').default(true),
  lastTriggeredAt: timestamp('last_triggered_at'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

export const insertZapierWebhookSchema = createInsertSchema(zapierWebhooks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastTriggeredAt: true,
});
export const updateZapierWebhookSchema = insertZapierWebhookSchema.partial();
export type InsertZapierWebhook = z.infer<typeof insertZapierWebhookSchema>;
export type ZapierWebhook = typeof zapierWebhooks.$inferSelect;
export type UpdateZapierWebhook = z.infer<typeof updateZapierWebhookSchema>;

// ─── API Keys (Zapier Platform Auth) ─────────────────────────────────────────
export const apiKeys = pgTable('api_keys', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar('user_id').notNull(),
  key: varchar('api_key', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 100 }).default('Zapier Integration'),
  isActive: boolean('is_active').default(true),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const insertApiKeySchema = createInsertSchema(apiKeys).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});
export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;

// ── Notifications + GitHub/Jira/Figma/Calendar/Email + Subtasks/Checklists ───
// ── Notifications ───────────────────────────────────────────────────────────

export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  type: text("type").notNull(), // task_created, task_assigned, workflow, status_changed, mention, etc
  title: text("title").notNull(),
  message: text("message"),
  link: text("link"), // e.g. /spaces/abc/tasks/xyz — click to navigate
  isRead: boolean("is_read").default(false),
  metadata: jsonb("metadata"), // extra: { taskId, spaceId, triggeredBy, workflowId, etc }
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
});

export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;

// ── GitHub Integration ──────────────────────────────────────────────────────

// Per-space counter for generating human-readable task IDs (TASK-1, TASK-2)
export const spaceTaskCounters = pgTable("space_task_counters", {
  spaceId: varchar("space_id").primaryKey(),
  lastValue: integer("last_value").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// GitHub repos connected to spaces — one row per (space, repo) link
export const spaceGithubRepos = pgTable("space_github_repos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  spaceId: varchar("space_id").notNull(),
  repoFullName: text("repo_full_name").notNull(), // "owner/repo"
  repoId: integer("repo_id").notNull(), // GitHub's internal repo ID
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch"),
  connectedBy: varchar("connected_by").notNull(), // userId who connected
  // Auto status config — which task status to set on PR open/close/merge
  autoStatusOnPrOpen: varchar("auto_status_on_pr_open"), // statusId or null
  autoStatusOnPrMerged: varchar("auto_status_on_pr_merged"),
  autoStatusOnPrClosed: varchar("auto_status_on_pr_closed"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Webhook subscriptions per connected repo
export const githubWebhooks = pgTable("github_webhooks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  spaceGithubRepoId: varchar("space_github_repo_id").notNull(),
  repoFullName: text("repo_full_name").notNull(),
  webhookId: integer("webhook_id").notNull(), // GitHub's webhook ID for unhooking
  secret: text("secret").notNull(), // HMAC-SHA256 secret (encrypted)
  events: text("events").array().notNull().default(sql`ARRAY[]::text[]`),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Links between tasks and GitHub entities (PRs, issues, commits, branches)
export const taskGithubLinks = pgTable("task_github_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  type: text("type").notNull(), // 'pr' | 'issue' | 'commit' | 'branch'
  repoFullName: text("repo_full_name").notNull(),
  externalId: text("external_id").notNull(), // PR/issue number as string, commit SHA, branch name
  externalUrl: text("external_url").notNull(),
  title: text("title"),
  state: text("state"), // open | closed | merged (for PRs/issues)
  authorLogin: text("author_login"),
  authorAvatar: text("author_avatar"),
  linkedBy: varchar("linked_by"), // userId who linked (null if auto-linked)
  autoLinked: boolean("auto_linked").notNull().default(false), // via commit/PR ref parsing
  metadata: jsonb("metadata"), // stats, files changed, labels, etc.
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Task activity timeline (system events + integration events)
export const taskActivities = pgTable("task_activities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  type: text("type").notNull(),
  // Types: 'github_pr_opened' | 'github_pr_merged' | 'github_pr_closed' | 'github_commit' |
  //        'github_review' | 'github_issue_opened' | 'github_issue_closed' | 'github_branch_created' |
  //        'task_created' | 'task_updated' | 'status_changed' | 'assignee_changed' | etc.
  actorUserId: varchar("actor_user_id"), // clicsHQ user (if internal action)
  actorExternalLogin: text("actor_external_login"), // GitHub login (if external action)
  actorExternalAvatar: text("actor_external_avatar"),
  payload: jsonb("payload"), // full event data for rendering
  createdAt: timestamp("created_at").defaultNow(),
});

// Webhook delivery log (idempotency + debugging)
export const githubWebhookDeliveries = pgTable("github_webhook_deliveries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deliveryId: text("delivery_id").notNull().unique(), // X-GitHub-Delivery header
  event: text("event").notNull(), // X-GitHub-Event header
  repoFullName: text("repo_full_name"),
  payload: jsonb("payload"),
  processedAt: timestamp("processed_at"),
  status: text("status").notNull().default("received"), // received | processed | failed | ignored
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSpaceGithubRepoSchema = createInsertSchema(spaceGithubRepos).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTaskGithubLinkSchema = createInsertSchema(taskGithubLinks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTaskActivitySchema = createInsertSchema(taskActivities).omit({
  id: true,
  createdAt: true,
});

export type SpaceGithubRepo = typeof spaceGithubRepos.$inferSelect;
export type InsertSpaceGithubRepo = z.infer<typeof insertSpaceGithubRepoSchema>;
export type GithubWebhook = typeof githubWebhooks.$inferSelect;
export type TaskGithubLink = typeof taskGithubLinks.$inferSelect;
export type InsertTaskGithubLink = z.infer<typeof insertTaskGithubLinkSchema>;
export type TaskActivity = typeof taskActivities.$inferSelect;
export type InsertTaskActivity = z.infer<typeof insertTaskActivitySchema>;
export type GithubWebhookDelivery = typeof githubWebhookDeliveries.$inferSelect;
export type SpaceTaskCounter = typeof spaceTaskCounters.$inferSelect;

// ── Jira Integration ────────────────────────────────────────────────────────

// Jira projects connected to spaces
export const spaceJiraProjects = pgTable("space_jira_projects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  spaceId: varchar("space_id").notNull(),
  cloudId: text("cloud_id").notNull(), // Atlassian site ID
  projectKey: text("project_key").notNull(), // e.g. "ENG"
  projectId: text("project_id").notNull(), // Jira's internal project ID
  projectName: text("project_name").notNull(),
  projectUrl: text("project_url"),
  connectedBy: varchar("connected_by").notNull(),
  // Auto status mapping — when Jira issue transitions, change clicsHQ task status
  autoStatusOnInProgress: varchar("auto_status_on_in_progress"),
  autoStatusOnDone: varchar("auto_status_on_done"),
  autoStatusOnBlocked: varchar("auto_status_on_blocked"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Task ↔ Jira issue links
export const taskJiraLinks = pgTable("task_jira_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  cloudId: text("cloud_id").notNull(),
  issueKey: text("issue_key").notNull(), // e.g. "ENG-42"
  issueId: text("issue_id").notNull(), // Jira's internal ID
  issueUrl: text("issue_url").notNull(),
  summary: text("summary"),
  status: text("status"), // current Jira status name
  issueType: text("issue_type"), // Bug, Story, Task, etc.
  priority: text("priority"),
  assigneeName: text("assignee_name"),
  assigneeAvatar: text("assignee_avatar"),
  linkedBy: varchar("linked_by"),
  autoLinked: boolean("auto_linked").notNull().default(false),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Jira webhook delivery log (idempotency)
export const jiraWebhookDeliveries = pgTable("jira_webhook_deliveries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Jira doesn't have a unique delivery ID like GitHub — we synthesize one
  // from event + issue key + timestamp.
  deliveryKey: text("delivery_key").notNull().unique(),
  event: text("event").notNull(), // jira:issue_created, jira:issue_updated, etc.
  issueKey: text("issue_key"),
  payload: jsonb("payload"),
  processedAt: timestamp("processed_at"),
  status: text("status").notNull().default("received"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSpaceJiraProjectSchema = createInsertSchema(spaceJiraProjects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTaskJiraLinkSchema = createInsertSchema(taskJiraLinks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SpaceJiraProject = typeof spaceJiraProjects.$inferSelect;
export type InsertSpaceJiraProject = z.infer<typeof insertSpaceJiraProjectSchema>;
export type TaskJiraLink = typeof taskJiraLinks.$inferSelect;
export type InsertTaskJiraLink = z.infer<typeof insertTaskJiraLinkSchema>;
export type JiraWebhookDelivery = typeof jiraWebhookDeliveries.$inferSelect;

// ── File Attachments (Drive / OneDrive / Dropbox) ───────────────────────────

/**
 * Unified file attachments table — supports all cloud-storage providers.
 * Older `task_drive_attachments` table stays for Drive-specific embed UI,
 * but new attachment flows write here.
 */
export const taskFileAttachments = pgTable("task_file_attachments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  provider: text("provider").notNull(), // 'google_drive' | 'onedrive' | 'dropbox'
  externalId: text("external_id").notNull(), // provider's file ID
  name: text("name").notNull(),
  mimeType: text("mime_type"),
  size: integer("size"), // bytes
  externalUrl: text("external_url"), // viewable URL in the provider's UI
  downloadUrl: text("download_url"),
  embedUrl: text("embed_url"), // for inline iframe preview
  thumbnailUrl: text("thumbnail_url"),
  iconUrl: text("icon_url"),
  ownerName: text("owner_name"),
  modifiedAt: timestamp("modified_at"),
  attachedBy: varchar("attached_by").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTaskFileAttachmentSchema = createInsertSchema(taskFileAttachments).omit({
  id: true,
  createdAt: true,
});

export type TaskFileAttachment = typeof taskFileAttachments.$inferSelect;
export type InsertTaskFileAttachment = z.infer<typeof insertTaskFileAttachmentSchema>;

// ── Figma Links ────────────────────────────────────────────────────────────

/**
 * Figma designs linked to tasks. Frame-level granularity supported via
 * nodeId — when present, embed shows the specific frame.
 */
export const taskFigmaLinks = pgTable("task_figma_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  fileKey: text("file_key").notNull(), // Figma file key (from URL)
  nodeId: text("node_id"), // Specific frame/component (optional)
  name: text("name").notNull(),
  fileUrl: text("file_url").notNull(),
  embedUrl: text("embed_url"),
  thumbnailUrl: text("thumbnail_url"),
  lastModified: timestamp("last_modified"),
  linkedBy: varchar("linked_by").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTaskFigmaLinkSchema = createInsertSchema(taskFigmaLinks).omit({
  id: true,
  createdAt: true,
});

export type TaskFigmaLink = typeof taskFigmaLinks.$inferSelect;
export type InsertTaskFigmaLink = z.infer<typeof insertTaskFigmaLinkSchema>;

// ── Calendar Event Links (Google Calendar) ─────────────────────────────────

/**
 * Links between clicsHQ tasks and calendar events.
 * Used for both:
 *   - Due-date sync (auto-created when a task has a due date)
 *   - Meeting events (manually scheduled from a task)
 */
export const taskCalendarEvents = pgTable("task_calendar_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  provider: text("provider").notNull(), // 'google_calendar' | 'outlook_calendar'
  externalEventId: text("external_event_id").notNull(),
  calendarId: text("calendar_id").notNull().default("primary"),
  summary: text("summary"),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  isAllDay: boolean("is_all_day").notNull().default(false),
  type: text("type").notNull(), // 'due_date_sync' | 'meeting'
  meetLink: text("meet_link"),
  eventUrl: text("event_url"),
  createdBy: varchar("created_by").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTaskCalendarEventSchema = createInsertSchema(taskCalendarEvents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type TaskCalendarEvent = typeof taskCalendarEvents.$inferSelect;
export type InsertTaskCalendarEvent = z.infer<typeof insertTaskCalendarEventSchema>;

// ── Email ↔ Task Links (Outlook + Gmail) ───────────────────────────────────

/**
 * Email messages linked to clicsHQ tasks. Supports:
 *   - Outlook email → task conversion
 *   - Email reply tracking
 *   - Email timeline on tasks
 */
export const taskEmailLinks = pgTable("task_email_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  provider: text("provider").notNull(), // 'outlook' | 'gmail'
  messageId: text("message_id").notNull(), // provider's internal id
  internetMessageId: text("internet_message_id"), // RFC 822 ID (cross-provider)
  conversationId: text("conversation_id"), // thread grouping
  subject: text("subject"),
  fromAddress: text("from_address"),
  fromName: text("from_name"),
  toAddresses: text("to_addresses").array(),
  snippet: text("snippet"),
  receivedAt: timestamp("received_at"),
  isReply: boolean("is_reply").notNull().default(false), // true if sent FROM clicsHQ
  webUrl: text("web_url"), // link to view in Outlook/Gmail
  linkedBy: varchar("linked_by").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTaskEmailLinkSchema = createInsertSchema(taskEmailLinks).omit({
  id: true,
  createdAt: true,
});

export type TaskEmailLink = typeof taskEmailLinks.$inferSelect;
export type InsertTaskEmailLink = z.infer<typeof insertTaskEmailLinkSchema>;

// ── Subtasks ───────────────────────────────────────────────────────────────
// Lightweight inline subtask rows shown in the task detail page.
// Separate from the full `tasks` table so subtasks don't pollute board/list views.
export const taskSubtasks = pgTable("task_subtasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(), // parent task
  name: text("name").notNull(),
  assigneeId: varchar("assignee_id"),
  priority: text("priority"), // urgent | high | normal | low | null
  dueDate: text("due_date"),
  completed: boolean("completed").notNull().default(false),
  order: integer("order").notNull().default(0),
  createdBy: varchar("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTaskSubtaskSchema = createInsertSchema(taskSubtasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type TaskSubtask = typeof taskSubtasks.$inferSelect;
export type InsertTaskSubtask = z.infer<typeof insertTaskSubtaskSchema>;

// ── Checklists ─────────────────────────────────────────────────────────────
// A task can have multiple named checklists, each with N items.
export const taskChecklists = pgTable("task_checklists", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  name: text("name").notNull().default("Checklist"),
  order: integer("order").notNull().default(0),
  createdBy: varchar("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTaskChecklistSchema = createInsertSchema(taskChecklists).omit({
  id: true,
  createdAt: true,
});

export type TaskChecklist = typeof taskChecklists.$inferSelect;
export type InsertTaskChecklist = z.infer<typeof insertTaskChecklistSchema>;

export const taskChecklistItems = pgTable("task_checklist_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  checklistId: varchar("checklist_id").notNull(),
  text: text("text").notNull(),
  completed: boolean("completed").notNull().default(false),
  assigneeId: varchar("assignee_id"),
  order: integer("order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTaskChecklistItemSchema = createInsertSchema(taskChecklistItems).omit({
  id: true,
  createdAt: true,
});

export type TaskChecklistItem = typeof taskChecklistItems.$inferSelect;
export type InsertTaskChecklistItem = z.infer<typeof insertTaskChecklistItemSchema>;

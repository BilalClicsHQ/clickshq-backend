import { pgTable, varchar, text, timestamp, boolean, integer, unique, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const activityType = pgEnum("activity_type", ['status_changed', 'task_completed', 'task_added', 'task_updated', 'task_deleted', 'member_added', 'member_removed', 'description_updated'])
export const budgetType = pgEnum("budget_type", ['fixed', 'hourly'])
export const commentStatus = pgEnum("comment_status", ['open', 'resolved'])
export const department = pgEnum("department", ['Product', 'Design', 'Dev', 'Marketing & Sales', 'Bug Hunting Campaign'])
export const docCategory = pgEnum("doc_category", ['blank', 'meeting_notes'])
export const permissionLevel = pgEnum("permission_level", ['full_access', 'comment', 'read_only'])
export const privacy = pgEnum("privacy", ['private', 'shared'])
export const projectLayout = pgEnum("project_layout", ['list', 'kanban', 'gantt'])
export const projectPrivacy = pgEnum("project_privacy", ['private', 'everyone', 'specific_people'])
export const projectStatus = pgEnum("project_status", ['at_risk', 'on_track', 'off_track', 'on_hold', 'completed'])
export const risk = pgEnum("risk", ['Low', 'Medium', 'High'])
export const sprintStatus = pgEnum("sprint_status", ['Planning', 'Active', 'Completed', 'Cancelled'])
export const stage = pgEnum("stage", ['Others', 'Pre-Event', 'Day Of', 'Post-Event', 'During Event'])
export const status = pgEnum("status", ['Not Started', 'In Progress', 'Completed', 'Blocked', 'Reviewing', 'Design Approval Needed', 'Temporary Hold'])
export const taskType = pgEnum("task_type", ['Operational', 'Technical', 'Strategic', 'Hiring', 'Financial'])
export const userRole = pgEnum("user_role", ['user', 'admin', 'sub-admin'])
export const viewType = pgEnum("view_type", ['table', 'kanban'])


export const activityLogs = pgTable("activity_logs", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	action: text().notNull(),
	details: text(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	timestamp: timestamp({ mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const documentComments = pgTable("document_comments", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	documentId: varchar("document_id").notNull(),
	userId: varchar("user_id").notNull(),
	content: text().notNull(),
	status: commentStatus().default('open').notNull(),
	mentionedUserIds: text("mentioned_user_ids").array().default(["RAY"]),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const documents = pgTable("documents", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	title: text().notNull(),
	content: text().default('),
	ownerId: varchar("owner_id").notNull(),
	category: docCategory().default('blank').notNull(),
	tags: text().array().default(["RAY"]),
	fontStyle: text("font_style").default('system'),
	fontSize: text("font_size").default('default'),
	pageWidth: text("page_width").default('default'),
	showCoverImage: boolean("show_cover_image").default(false),
	showPageIconAndTitle: boolean("show_page_icon_and_title").default(true),
	showAuthor: boolean("show_author").default(false),
	showContributors: boolean("show_contributors").default(false),
	showSubtitle: boolean("show_subtitle").default(false),
	showLastModified: boolean("show_last_modified").default(true),
	showPageOutline: boolean("show_page_outline").default(false),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const goals = pgTable("goals", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	title: text().notNull(),
	description: text(),
	owner: text(),
	targetDate: text("target_date"),
	taskIds: text("task_ids").array().default(["RAY"]),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const invitations = pgTable("invitations", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	email: text().notNull(),
	role: userRole().default('user').notNull(),
	invitedBy: varchar("invited_by").notNull(),
	status: text().default('pending'),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	expiresAt: timestamp("expires_at", { mode: 'string' }),
});

export const kanbanColumns = pgTable("kanban_columns", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	teamId: varchar("team_id").notNull(),
	name: text().notNull(),
	color: text().default('#6B7280').notNull(),
	icon: text().default('📋'),
	order: integer().default(0).notNull(),
	isDefault: boolean("is_default").default(false),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const projectActivities = pgTable("project_activities", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	projectId: varchar("project_id").notNull(),
	userId: varchar("user_id").notNull(),
	activityType: activityType("activity_type").notNull(),
	entityName: text("entity_name"),
	oldValue: text("old_value"),
	newValue: text("new_value"),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const projectAttachments = pgTable("project_attachments", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	projectId: varchar("project_id").notNull(),
	fileName: text("file_name").notNull(),
	fileUrl: text("file_url").notNull(),
	fileSize: integer("file_size"),
	uploadedBy: varchar("uploaded_by").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const projectBudgets = pgTable("project_budgets", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	projectId: varchar("project_id").notNull(),
	name: text().notNull(),
	type: budgetType().notNull(),
	amount: integer().notNull(),
	currency: text().default('USD'),
	billDate: text("bill_date"),
	category: text(),
	description: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const projectCosts = pgTable("project_costs", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	projectId: varchar("project_id").notNull(),
	name: text().notNull(),
	type: budgetType().notNull(),
	amount: integer().notNull(),
	currency: text().default('USD'),
	date: text(),
	category: text(),
	description: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const projectSections = pgTable("project_sections", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	projectId: varchar("project_id").notNull(),
	name: text().notNull(),
	order: integer().default(0).notNull(),
	isCollapsed: boolean("is_collapsed").default(false),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const projectStatusUpdates = pgTable("project_status_updates", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	projectId: varchar("project_id").notNull(),
	status: projectStatus().notNull(),
	description: text(),
	userId: varchar("user_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const projects = pgTable("projects", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	department: department().notNull(),
	task: text().notNull(),
	status: status().default('Not Started').notNull(),
	owner: text(),
	stage: text().default('Others'),
	startDate: text("start_date"),
	dueDate: text("due_date"),
	completionPercentage: integer("completion_percentage").default(0),
	risk: text(),
	notes: text(),
	description: text(),
	labels: text().array().default(["RAY"]),
	dependencies: text().array().default(["RAY"]),
	linkedGoalId: varchar("linked_goal_id"),
	sprintId: varchar("sprint_id"),
	scheduledDate: text("scheduled_date"),
	effortEstimate: integer("effort_estimate").default(1),
	taskType: taskType("task_type"),
	workspaceProjectId: varchar("workspace_project_id"),
	sectionId: varchar("section_id"),
	lastUpdated: timestamp("last_updated", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const sprints = pgTable("sprints", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	startDate: text("start_date").notNull(),
	endDate: text("end_date").notNull(),
	status: sprintStatus().default('Planning').notNull(),
	teamMembers: text("team_members").array().default(["RAY"]),
	taskIds: text("task_ids").array().default(["RAY"]),
	totalEffort: integer("total_effort").default(0),
	completedEffort: integer("completed_effort").default(0),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const teamMembers = pgTable("team_members", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	name: text().notNull(),
	initials: text().notNull(),
	department: department().notNull(),
	avatarColor: text("avatar_color").default('#3B82F6'),
});

export const teams = pgTable("teams", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	name: text().notNull(),
	icon: text().default('Users').notNull(),
	color: text().default('#3B82F6').notNull(),
	description: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const userSessions = pgTable("user_sessions", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	sessionId: text("session_id").notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	loginTime: timestamp("login_time", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	lastActivity: timestamp("last_activity", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	isActive: boolean("is_active").default(true),
});

export const viewPreferences = pgTable("view_preferences", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	teamId: varchar("team_id").notNull(),
	viewType: viewType("view_type").default('table').notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const workspaceProjects = pgTable("workspace_projects", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	name: text().notNull(),
	color: text().default('#3B82F6').notNull(),
	startDate: text("start_date"),
	endDate: text("end_date"),
	ownerId: varchar("owner_id").notNull(),
	privacy: projectPrivacy().default('private').notNull(),
	memberIds: text("member_ids").array().default(["RAY"]),
	defaultLayout: projectLayout("default_layout").default('list').notNull(),
	description: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const users = pgTable("users", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	email: text().notNull(),
	displayName: text("display_name").notNull(),
	password: text(),
	role: userRole().default('user').notNull(),
	profilePicture: text("profile_picture"),
	isOnline: boolean("is_online").default(false),
	lastActivity: timestamp("last_activity", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	resetToken: text("reset_token"),
	resetTokenExpiry: timestamp("reset_token_expiry", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	lastLogin: timestamp("last_login", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	firstName: text("first_name"),
	lastName: text("last_name"),
	country: text(),
	phone: text(),
	birthday: text(),
	language: text().default('English'),
	timezone: text().default('(GMT+00:00) UTC'),
	theme: text().default('Auto'),
	dateFormat: text("date_format").default('31 Dec 2025'),
	timeFormat: text("time_format").default('12'),
	weekFormat: text("week_format").default('Monday'),
	hasCompletedOnboarding: boolean("has_completed_onboarding").default(false),
	onboardingUseCase: text("onboarding_use_case"),
	onboardingManagementArea: text("onboarding_management_area"),
	onboardingHeardFrom: text("onboarding_heard_from"),
	onboardingWorkspaceName: text("onboarding_workspace_name"),
	onboardingInterestedFeatures: text("onboarding_interested_features").array().default(["RAY"]),
	isEmailVerified: boolean("is_email_verified").default(false),
	emailVerificationToken: text("email_verification_token"),
	emailVerificationExpiry: timestamp("email_verification_expiry", { mode: 'string' }),
	authProvider: text("auth_provider").default('local'),
	googleId: text("google_id"),
	microsoftId: text("microsoft_id"),
	isSoftSignup: boolean("is_soft_signup").default(false),
	emailNotifications: boolean("email_notifications").default(true),
	inAppNotifications: boolean("in_app_notifications").default(false),
	notifyTaskAssigned: boolean("notify_task_assigned").default(false),
	notifyMentions: boolean("notify_mentions").default(true),
	notifyComments: boolean("notify_comments").default(false),
	notifyDueDateReminders: boolean("notify_due_date_reminders").default(true),
	email2FaEnabled: boolean("email_2fa_enabled").default(false),
	email2FaCode: text("email_2fa_code"),
	email2FaCodeExpiry: timestamp("email_2fa_code_expiry", { mode: 'string' }),
	email2FaPendingAction: text("email_2fa_pending_action"),
	totp2FaEnabled: boolean("totp_2fa_enabled").default(false),
	totpSecret: text("totp_secret"),
	totpTempSecret: text("totp_temp_secret"),
	totpBackupCodes: text("totp_backup_codes").array().default(["RAY"]),
}, (table) => [
	unique("users_email_unique").on(table.email),
]);

export const spaceStatuses = pgTable("space_statuses", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	spaceId: varchar("space_id").notNull(),
	name: text().notNull(),
	colorCode: text("color_code").notNull(),
	order: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const spaces = pgTable("spaces", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	name: text().notNull(),
	iconUrl: text("icon_url").notNull(),
	description: text(),
	defaultPermission: permissionLevel("default_permission").default('full_access').notNull(),
	privacy: privacy().default('private').notNull(),
	memberIds: text("member_ids").array().default(["RAY"]),
	teamIds: text("team_ids").array().default(["RAY"]),
	ownerId: varchar("owner_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const tasks = pgTable("tasks", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	spaceId: varchar("space_id").notNull(),
	name: text().notNull(),
	description: text().default('),
	statusId: varchar("status_id").notNull(),
	priority: text(),
	ownerId: varchar("owner_id").notNull(),
	assigneeIds: text("assignee_ids").array().default(["RAY"]).notNull(),
	dueDate: text("due_date"),
	labels: text().array().default(["RAY"]),
	estimatedHours: text("estimated_hours"),
	actualHours: text("actual_hours"),
	attachments: text().array().default(["RAY"]),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	order: integer().default(0).notNull(),
});

export const spaceInvitations = pgTable("space_invitations", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	spaceId: varchar("space_id").notNull(),
	invitedByUserId: varchar("invited_by_user_id").notNull(),
	invitedEmail: text("invited_email").notNull(),
	invitedUserId: varchar("invited_user_id"),
	token: text().notNull(),
	status: text().default('pending').notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	expiresAt: timestamp("expires_at", { mode: 'string' }),
}, (table) => [
	unique("space_invitations_token_unique").on(table.token),
]);

export const spaceFavourites = pgTable("space_favourites", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	spaceId: varchar("space_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const spaceRecentActivity = pgTable("space_recent_activity", {
	id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	spaceId: varchar("space_id").notNull(),
	lastActivityAt: timestamp("last_activity_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

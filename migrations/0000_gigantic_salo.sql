-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TYPE "public"."activity_type" AS ENUM('status_changed', 'task_completed', 'task_added', 'task_updated', 'task_deleted', 'member_added', 'member_removed', 'description_updated');--> statement-breakpoint
CREATE TYPE "public"."budget_type" AS ENUM('fixed', 'hourly');--> statement-breakpoint
CREATE TYPE "public"."comment_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."department" AS ENUM('Product', 'Design', 'Dev', 'Marketing & Sales', 'Bug Hunting Campaign');--> statement-breakpoint
CREATE TYPE "public"."doc_category" AS ENUM('blank', 'meeting_notes');--> statement-breakpoint
CREATE TYPE "public"."permission_level" AS ENUM('full_access', 'comment', 'read_only');--> statement-breakpoint
CREATE TYPE "public"."privacy" AS ENUM('private', 'shared');--> statement-breakpoint
CREATE TYPE "public"."project_layout" AS ENUM('list', 'kanban', 'gantt');--> statement-breakpoint
CREATE TYPE "public"."project_privacy" AS ENUM('private', 'everyone', 'specific_people');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('at_risk', 'on_track', 'off_track', 'on_hold', 'completed');--> statement-breakpoint
CREATE TYPE "public"."risk" AS ENUM('Low', 'Medium', 'High');--> statement-breakpoint
CREATE TYPE "public"."sprint_status" AS ENUM('Planning', 'Active', 'Completed', 'Cancelled');--> statement-breakpoint
CREATE TYPE "public"."stage" AS ENUM('Others', 'Pre-Event', 'Day Of', 'Post-Event', 'During Event');--> statement-breakpoint
CREATE TYPE "public"."status" AS ENUM('Not Started', 'In Progress', 'Completed', 'Blocked', 'Reviewing', 'Design Approval Needed', 'Temporary Hold');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('Operational', 'Technical', 'Strategic', 'Hiring', 'Financial');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin', 'sub-admin');--> statement-breakpoint
CREATE TYPE "public"."view_type" AS ENUM('table', 'kanban');--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"action" text NOT NULL,
	"details" text,
	"ip_address" text,
	"user_agent" text,
	"timestamp" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "document_comments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"content" text NOT NULL,
	"status" "comment_status" DEFAULT 'open' NOT NULL,
	"mentioned_user_ids" text[] DEFAULT '{"RAY"}',
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '',
	"owner_id" varchar NOT NULL,
	"category" "doc_category" DEFAULT 'blank' NOT NULL,
	"tags" text[] DEFAULT '{"RAY"}',
	"font_style" text DEFAULT 'system',
	"font_size" text DEFAULT 'default',
	"page_width" text DEFAULT 'default',
	"show_cover_image" boolean DEFAULT false,
	"show_page_icon_and_title" boolean DEFAULT true,
	"show_author" boolean DEFAULT false,
	"show_contributors" boolean DEFAULT false,
	"show_subtitle" boolean DEFAULT false,
	"show_last_modified" boolean DEFAULT true,
	"show_page_outline" boolean DEFAULT false,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"owner" text,
	"target_date" text,
	"task_ids" text[] DEFAULT '{"RAY"}',
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"invited_by" varchar NOT NULL,
	"status" text DEFAULT 'pending',
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "kanban_columns" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" varchar NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6B7280' NOT NULL,
	"icon" text DEFAULT '📋',
	"order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "project_activities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"activity_type" "activity_type" NOT NULL,
	"entity_name" text,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "project_attachments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" varchar NOT NULL,
	"file_name" text NOT NULL,
	"file_url" text NOT NULL,
	"file_size" integer,
	"uploaded_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "project_budgets" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" varchar NOT NULL,
	"name" text NOT NULL,
	"type" "budget_type" NOT NULL,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'USD',
	"bill_date" text,
	"category" text,
	"description" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "project_costs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" varchar NOT NULL,
	"name" text NOT NULL,
	"type" "budget_type" NOT NULL,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'USD',
	"date" text,
	"category" text,
	"description" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "project_sections" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" varchar NOT NULL,
	"name" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"is_collapsed" boolean DEFAULT false,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "project_status_updates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" varchar NOT NULL,
	"status" "project_status" NOT NULL,
	"description" text,
	"user_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department" "department" NOT NULL,
	"task" text NOT NULL,
	"status" "status" DEFAULT 'Not Started' NOT NULL,
	"owner" text,
	"stage" text DEFAULT 'Others',
	"start_date" text,
	"due_date" text,
	"completion_percentage" integer DEFAULT 0,
	"risk" text,
	"notes" text,
	"description" text,
	"labels" text[] DEFAULT '{"RAY"}',
	"dependencies" text[] DEFAULT '{"RAY"}',
	"linked_goal_id" varchar,
	"sprint_id" varchar,
	"scheduled_date" text,
	"effort_estimate" integer DEFAULT 1,
	"task_type" "task_type",
	"workspace_project_id" varchar,
	"section_id" varchar,
	"last_updated" timestamp DEFAULT CURRENT_TIMESTAMP,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "sprints" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"status" "sprint_status" DEFAULT 'Planning' NOT NULL,
	"team_members" text[] DEFAULT '{"RAY"}',
	"task_ids" text[] DEFAULT '{"RAY"}',
	"total_effort" integer DEFAULT 0,
	"completed_effort" integer DEFAULT 0,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"initials" text NOT NULL,
	"department" "department" NOT NULL,
	"avatar_color" text DEFAULT '#3B82F6'
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"icon" text DEFAULT 'Users' NOT NULL,
	"color" text DEFAULT '#3B82F6' NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"session_id" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"login_time" timestamp DEFAULT CURRENT_TIMESTAMP,
	"last_activity" timestamp DEFAULT CURRENT_TIMESTAMP,
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "view_preferences" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"team_id" varchar NOT NULL,
	"view_type" "view_type" DEFAULT 'table' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "workspace_projects" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#3B82F6' NOT NULL,
	"start_date" text,
	"end_date" text,
	"owner_id" varchar NOT NULL,
	"privacy" "project_privacy" DEFAULT 'private' NOT NULL,
	"member_ids" text[] DEFAULT '{"RAY"}',
	"default_layout" "project_layout" DEFAULT 'list' NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"profile_picture" text,
	"is_online" boolean DEFAULT false,
	"last_activity" timestamp DEFAULT CURRENT_TIMESTAMP,
	"reset_token" text,
	"reset_token_expiry" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"last_login" timestamp DEFAULT CURRENT_TIMESTAMP,
	"first_name" text,
	"last_name" text,
	"country" text,
	"phone" text,
	"birthday" text,
	"language" text DEFAULT 'English',
	"timezone" text DEFAULT '(GMT+00:00) UTC',
	"theme" text DEFAULT 'Auto',
	"date_format" text DEFAULT '31 Dec 2025',
	"time_format" text DEFAULT '12',
	"week_format" text DEFAULT 'Monday',
	"has_completed_onboarding" boolean DEFAULT false,
	"onboarding_use_case" text,
	"onboarding_management_area" text,
	"onboarding_heard_from" text,
	"onboarding_workspace_name" text,
	"onboarding_interested_features" text[] DEFAULT '{"RAY"}',
	"is_email_verified" boolean DEFAULT false,
	"email_verification_token" text,
	"email_verification_expiry" timestamp,
	"auth_provider" text DEFAULT 'local',
	"google_id" text,
	"microsoft_id" text,
	"is_soft_signup" boolean DEFAULT false,
	"email_notifications" boolean DEFAULT true,
	"in_app_notifications" boolean DEFAULT false,
	"notify_task_assigned" boolean DEFAULT false,
	"notify_mentions" boolean DEFAULT true,
	"notify_comments" boolean DEFAULT false,
	"notify_due_date_reminders" boolean DEFAULT true,
	"email_2fa_enabled" boolean DEFAULT false,
	"email_2fa_code" text,
	"email_2fa_code_expiry" timestamp,
	"email_2fa_pending_action" text,
	"totp_2fa_enabled" boolean DEFAULT false,
	"totp_secret" text,
	"totp_temp_secret" text,
	"totp_backup_codes" text[] DEFAULT '{"RAY"}',
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "space_statuses" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" varchar NOT NULL,
	"name" text NOT NULL,
	"color_code" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"icon_url" text NOT NULL,
	"description" text,
	"default_permission" "permission_level" DEFAULT 'full_access' NOT NULL,
	"privacy" "privacy" DEFAULT 'private' NOT NULL,
	"member_ids" text[] DEFAULT '{"RAY"}',
	"team_ids" text[] DEFAULT '{"RAY"}',
	"owner_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" varchar NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '',
	"status_id" varchar NOT NULL,
	"priority" text,
	"owner_id" varchar NOT NULL,
	"assignee_ids" text[] DEFAULT '{"RAY"}' NOT NULL,
	"due_date" text,
	"labels" text[] DEFAULT '{"RAY"}',
	"estimated_hours" text,
	"actual_hours" text,
	"attachments" text[] DEFAULT '{"RAY"}',
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_invitations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" varchar NOT NULL,
	"invited_by_user_id" varchar NOT NULL,
	"invited_email" text NOT NULL,
	"invited_user_id" varchar,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"expires_at" timestamp,
	CONSTRAINT "space_invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "space_favourites" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"space_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_recent_activity" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"space_id" varchar NOT NULL,
	"last_activity_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);

*/
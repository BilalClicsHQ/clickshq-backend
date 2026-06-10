  import {
    projects,
    teamMembers,
    companies,
    users,
    userSessions,
    activityLogs,
    goals,
    sprints,
    invitations,
    teams,
    viewPreferences,
    kanbanColumns,
    documents,
    documentComments,
    spaces,
    spaceStatuses,
    tasks,
    type User,
    type InsertUser,
    type TeamMember,
    type InsertTeamMember,
    type Project,
    type InsertProject,
    type UpdateProject,
    type Goal,
    type InsertGoal,
    type UpdateGoal,
    type Sprint,
    type InsertSprint,
    type UpdateSprint,
    type UpdateUser,
    type UserSession,
    type InsertUserSession,
    type ActivityLog,
    type InsertActivityLog,
    type UpdateUserRole,
    type Invitation,
    type InsertInvitation,
    type Team,
    type InsertTeam,
    type UpdateTeam,
    type ViewPreference,
    type InsertViewPreference,
    type KanbanColumn,
    type InsertKanbanColumn,
    type UpdateKanbanColumn,
    type Document,
    type InsertDocument,
    type UpdateDocument,
    type DocumentComment,
    type InsertDocumentComment,
    type UpdateDocumentComment,
    type Space,
    type InsertSpace,
    type UpdateSpace,
    type SpaceStatus,
    type InsertSpaceStatus,
    type Task,
    type InsertTask,
    type UpdateTask,
    type Company,
    type InsertCompany,
    type UpdateCompany,
    // Workflows (migrated from Nexus)
    workflows,
    workflowLogs,
    type Workflow,
    type InsertWorkflow,
    type UpdateWorkflow,
    type WorkflowLog,
    type InsertWorkflowLog,
    // Integrations (migrated from Nexus)
    taskActivities,
    spaceGithubRepos,
    githubWebhooks,
    taskGithubLinks,
    githubWebhookDeliveries,
    spaceJiraProjects,
    taskJiraLinks,
    jiraWebhookDeliveries,
    taskFileAttachments,
    taskFigmaLinks,
    taskCalendarEvents,
    taskEmailLinks,
    taskSubtasks,
    taskChecklists,
    taskChecklistItems,
    spaceTaskCounters,
    type TaskActivity,
    type InsertTaskActivity,
    type SpaceGithubRepo,
    type InsertSpaceGithubRepo,
    type GithubWebhook,
    type TaskGithubLink,
    type InsertTaskGithubLink,
    type GithubWebhookDelivery,
    type SpaceJiraProject,
    type InsertSpaceJiraProject,
    type TaskJiraLink,
    type InsertTaskJiraLink,
    type JiraWebhookDelivery,
    type TaskFileAttachment,
    type InsertTaskFileAttachment,
    type TaskFigmaLink,
    type InsertTaskFigmaLink,
    type TaskCalendarEvent,
    type InsertTaskCalendarEvent,
    type TaskEmailLink,
    type InsertTaskEmailLink,
    type TaskSubtask,
    type InsertTaskSubtask,
    type TaskChecklist,
    type InsertTaskChecklist,
    type TaskChecklistItem,
    type InsertTaskChecklistItem,
  } from "@shared/schema";
  import { db } from "./db";
  import { eq, and, gte, lte, ilike, desc, sql, isNull } from "drizzle-orm";

  export interface IStorage {
    getUser(id: string): Promise<User | undefined>;
    getUserByEmail(email: string): Promise<User | undefined>;

    getUserByGoogleId(googleId: string): Promise<User | undefined>;
    getUserByMicrosoftId(microsoftId: string): Promise<User | undefined>;

    createUser(user: InsertUser): Promise<User>;
    updateUser(id: string, updates: UpdateUser): Promise<User | undefined>;
    updateUserLastLogin(id: string): Promise<User>;
    updateUserResetToken(id: string, token: string, expiry: Date): Promise<User | undefined>;
    getUserByResetToken(token: string): Promise<User | undefined>;
    clearResetToken(id: string): Promise<User | undefined>;

    //new
    verifyEmail(token: string): Promise<User | undefined>;
    getUserByVerificationToken(token: string): Promise<User | undefined>;

    // Admin functionality
    updateUserRole(id: string, role: 'user' | 'admin' | 'sub-admin'): Promise<User | undefined>;
    updateUserOnlineStatus(id: string, isOnline: boolean): Promise<User | undefined>;
    updateUserActivity(id: string): Promise<User | undefined>;
    getOnlineUsers(): Promise<User[]>;
    getUsersByRole(role: 'user' | 'admin' | 'sub-admin'): Promise<User[]>;
    getAllUsers(): Promise<User[]>;

    // User Sessions
    createUserSession(session: InsertUserSession): Promise<UserSession>;
    updateSessionActivity(sessionId: string): Promise<UserSession | undefined>;
    deactivateUserSessions(userId: string): Promise<void>;
    getActiveUserSessions(): Promise<UserSession[]>;

    // Activity Logs
    logActivity(log: InsertActivityLog): Promise<ActivityLog>;
    getActivityLogs(options?: { userId?: string; action?: string; limit?: number; offset?: number }): Promise<ActivityLog[]>;
    getUserLoginStats(): Promise<{ userId: string; displayName: string; email: string; lastLogin: Date; loginCount: number; }[]>;

    // Team Members
    getAllTeamMembers(): Promise<TeamMember[]>;
    getTeamMember(id: string): Promise<TeamMember | undefined>;
    createTeamMember(member: InsertTeamMember): Promise<TeamMember>;

    // Projects
    getAllProjects(): Promise<Project[]>;
    getProject(id: string): Promise<Project | undefined>;
    createProject(project: InsertProject): Promise<Project>;
    updateProject(id: string, updates: UpdateProject): Promise<Project | undefined>;
    deleteProject(id: string): Promise<boolean>;
    getProjectsByDepartment(department: string): Promise<Project[]>;
    getProjectsByStatus(status: string): Promise<Project[]>;
    getProjectsByOwner(owner: string): Promise<Project[]>;
    searchProjects(query: string): Promise<Project[]>;
    getProjectMetrics(): Promise<{
      totalTasks: number;
      completed: number;
      inProgress: number;
      notStarted: number;
      blocked: number;
      reviewing: number;
      overdue: number;
      temporaryHold: number;
      completionPercentage: number;
    }>;

    // Dependency Management
    resolveDependencies(completedTaskId: string): Promise<void>;
    areAllDependenciesCompleted(dependencyIds: string[]): Promise<boolean>;
    validateAndBlockIfNeeded(projectId: string, dependencies: string[]): Promise<void>;
    getDependencyInfo(projectId: string): Promise<{
      dependencies: Project[];
      dependents: Project[];
      blockedBy: Project[];
    }>;

    // Goals
    getAllGoals(): Promise<Goal[]>;
    getGoal(id: string): Promise<Goal | undefined>;
    createGoal(goal: InsertGoal): Promise<Goal>;
    updateGoal(id: string, updates: UpdateGoal): Promise<Goal | undefined>;
    deleteGoal(id: string): Promise<boolean>;
    getGoalProgress(id: string): Promise<{
      totalTasks: number;
      completedTasks: number;
      progressPercentage: number;
    }>;
    updateGoalProgress(goalId: string): Promise<void>;

    // Sprints
    getAllSprints(): Promise<Sprint[]>;
    getSprint(id: string): Promise<Sprint | undefined>;
    createSprint(sprint: InsertSprint): Promise<Sprint>;
    updateSprint(id: string, updates: UpdateSprint): Promise<Sprint | undefined>;
    deleteSprint(id: string): Promise<boolean>;
    getSprintProgress(id: string): Promise<{
      totalTasks: number;
      completedTasks: number;
      totalEffort: number;
      completedEffort: number;
      progressPercentage: number;
    }>;
    assignTasksToSprint(sprintId: string, taskIds: string[]): Promise<void>;
    autoAssignTasksToSprint(sprintId: string, criteria: {
      departments?: string[];
      maxEffort?: number;
      prioritizeBy?: 'risk' | 'dueDate' | 'effort';
    }): Promise<string[]>; // Returns assigned task IDs
    updateSprintProgress(sprintId: string): Promise<void>;

    // Invitations
    createInvitation(invitation: InsertInvitation): Promise<Invitation>;
    getInvitations(): Promise<Invitation[]>;
    getInvitationByEmail(email: string): Promise<Invitation | undefined>;

    // Teams
    getAllTeams(): Promise<Team[]>;
    getTeam(id: string): Promise<Team | undefined>;
    createTeam(team: InsertTeam): Promise<Team>;
    updateTeam(id: string, updates: UpdateTeam): Promise<Team | undefined>;
    deleteTeam(id: string): Promise<boolean>;

    // View Preferences
    getViewPreference(userId: string, teamId: string): Promise<ViewPreference | undefined>;
    setViewPreference(userId: string, teamId: string, viewType: 'table' | 'kanban'): Promise<ViewPreference>;

    // Kanban Columns
    getKanbanColumns(teamId: string): Promise<KanbanColumn[]>;
    createKanbanColumn(column: InsertKanbanColumn): Promise<KanbanColumn>;
    updateKanbanColumn(id: string, updates: UpdateKanbanColumn): Promise<KanbanColumn | undefined>;
    deleteKanbanColumn(id: string): Promise<boolean>;
    updateProjectColumn(projectId: string, columnName: string): Promise<void>;

    // Documents
    getAllDocuments(): Promise<Document[]>;
    getDocument(id: string): Promise<Document | undefined>;
    getDocumentsByOwner(ownerId: string): Promise<Document[]>;
    getDocumentsByCategory(category: 'blank' | 'meeting_notes'): Promise<Document[]>;
    createDocument(doc: InsertDocument): Promise<Document>;
    updateDocument(id: string, updates: UpdateDocument): Promise<Document | undefined>;
    deleteDocument(id: string): Promise<boolean>;

    // Document Comments
    getDocumentComments(documentId: string): Promise<DocumentComment[]>;
    createDocumentComment(comment: InsertDocumentComment): Promise<DocumentComment>;
    updateDocumentComment(id: string, updates: UpdateDocumentComment): Promise<DocumentComment | undefined>;
    deleteDocumentComment(id: string): Promise<boolean>;

      // Spaces
      getAllSpaces(): Promise<Space[]>;
      getSpace(id: string): Promise<Space | undefined>;
      getSpacesByOwner(ownerId: string): Promise<Space[]>;
      getSpacesForUser(userId: string, companyId: string | null): Promise<Space[]>;
      createSpace(space: InsertSpace): Promise<Space>;
      updateSpace(id: string, updates: UpdateSpace): Promise<Space | undefined>;
      deleteSpace(id: string): Promise<boolean>;

      // Space Statuses
      getSpaceStatuses(spaceId: string): Promise<SpaceStatus[]>;
      createSpaceStatus(status: InsertSpaceStatus): Promise<SpaceStatus>;
      updateSpaceStatus(id: string, updates: { name?: string; colorCode?: string }): Promise<SpaceStatus | undefined>;
      deleteSpaceStatus(id: string): Promise<boolean>;
      deleteAllSpaceStatuses(spaceId: string): Promise<boolean>;

      // Tasks
      getAllTasks(spaceId: string): Promise<Task[]>;
      getTask(id: string): Promise<Task | undefined>;
      createTask(task: InsertTask): Promise<Task>;
      updateTask(id: string, updates: UpdateTask): Promise<Task | undefined>;
      deleteTask(id: string): Promise<boolean>;

      // Companies
      createCompany(company: InsertCompany): Promise<Company>;
      getCompanyById(id: string): Promise<Company | undefined>;
      getCompanyByOwner(ownerUserId: string): Promise<Company | undefined>;
      updateCompany(id: string, updates: UpdateCompany): Promise<Company | undefined>;

    // Project Status Updates
    getProjectStatusUpdates(projectId: string): Promise<any[]>;
    createProjectStatusUpdate(update: any): Promise<any>;

    // Project Budgets
    getProjectBudgets(projectId: string): Promise<any[]>;
    createProjectBudget(budget: any): Promise<any>;

    // Project Costs
    getProjectCosts(projectId: string): Promise<any[]>;
    createProjectCost(cost: any): Promise<any>;

    // Project Attachments
    getProjectAttachments(projectId: string): Promise<any[]>;
    createProjectAttachment(attachment: any): Promise<any>;
  }

  export class DatabaseStorage implements IStorage {
    getProjectStatusUpdates(projectId: string): Promise<any[]> {
      throw new Error("Method not implemented.");
    }
    createProjectStatusUpdate(update: any): Promise<any> {
      throw new Error("Method not implemented.");
    }
    getProjectBudgets(projectId: string): Promise<any[]> {
      throw new Error("Method not implemented.");
    }
    createProjectBudget(budget: any): Promise<any> {
      throw new Error("Method not implemented.");
    }
    getProjectCosts(projectId: string): Promise<any[]> {
      throw new Error("Method not implemented.");
    }
    createProjectCost(cost: any): Promise<any> {
      throw new Error("Method not implemented.");
    }
    getProjectAttachments(projectId: string): Promise<any[]> {
      throw new Error("Method not implemented.");
    }
    createProjectAttachment(attachment: any): Promise<any> {
      throw new Error("Method not implemented.");
    }
    async getUser(id: string): Promise<User | undefined> {
      const [user] = await db.select().from(users).where(eq(users.id, id));
      return user || undefined;
    }

    async getUserByEmail(email: string): Promise<User | undefined> {
      const [user] = await db.select().from(users).where(eq(users.email, email));
      return user || undefined;
    }

    async getUserByGoogleId(googleId: string): Promise<User | undefined> {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.googleId, googleId));
      return user;
    }

    async getUserByMicrosoftId(microsoftId: string): Promise<User | undefined> {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.microsoftId, microsoftId));
      return user;
    }

    async getUserByVerificationToken(token: string): Promise<User | undefined> {
      const [user] = await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.emailVerificationToken, token),
            sql`${users.emailVerificationExpiry} > NOW()`
          )
        );
      return user;
    }

    async verifyEmail(token: string): Promise<User | undefined> {
      const user = await this.getUserByVerificationToken(token);

      if (!user) {
        return undefined;
      }

      const [updatedUser] = await db
        .update(users)
        .set({
          isEmailVerified: true,
          emailVerificationToken: null,
          emailVerificationExpiry: null,
        })
        .where(eq(users.id, user.id))
        .returning();

      return updatedUser;
    }

    async updateUserLastLogin(id: string): Promise<User> {
      const [user] = await db
        .update(users)
        .set({
          lastLogin: sql`CURRENT_TIMESTAMP`,
          isOnline: true,
          lastActivity: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(users.id, id))
        .returning();
      return user;
    }

    async updateUserResetToken(id: string, token: string, expiry: Date): Promise<User | undefined> {
      const [user] = await db
        .update(users)
        .set({
          resetToken: token,
          resetTokenExpiry: expiry
        })
        .where(eq(users.id, id))
        .returning();
      return user || undefined;
    }

    async getUserByResetToken(token: string): Promise<User | undefined> {
      const [user] = await db
        .select()
        .from(users)
        .where(and(
          eq(users.resetToken, token),
          sql`${users.resetTokenExpiry} > NOW()`
        ));
      return user || undefined;
    }

    async clearResetToken(id: string): Promise<User | undefined> {
      const [user] = await db
        .update(users)
        .set({
          resetToken: null,
          resetTokenExpiry: null
        })
        .where(eq(users.id, id))
        .returning();
      return user || undefined;
    }

    async createUser(insertUser: InsertUser): Promise<User> {
      const [user] = await db
        .insert(users)
        .values(insertUser)
        .returning();
      return user;
    }

    async updateUser(id: string, updates: UpdateUser): Promise<User | undefined> {
      const [user] = await db
        .update(users)
        .set(updates)
        .where(eq(users.id, id))
        .returning();
      return user || undefined;
    }

    // Admin functionality
    async updateUserRole(id: string, role: 'user' | 'admin' | 'sub-admin'): Promise<User | undefined> {
      const [user] = await db
        .update(users)
        .set({ role })
        .where(eq(users.id, id))
        .returning();
      return user || undefined;
    }

    async updateUserOnlineStatus(id: string, isOnline: boolean): Promise<User | undefined> {
      const [user] = await db
        .update(users)
        .set({
          isOnline,
          lastActivity: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(users.id, id))
        .returning();
      return user || undefined;
    }

    async updateUserActivity(id: string): Promise<User | undefined> {
      const [user] = await db
        .update(users)
        .set({ lastActivity: sql`CURRENT_TIMESTAMP` })
        .where(eq(users.id, id))
        .returning();
      return user || undefined;
    }

    async getOnlineUsers(): Promise<User[]> {
      return await db
        .select()
        .from(users)
        .where(eq(users.isOnline, true))
        .orderBy(desc(users.lastActivity));
    }

    async getUsersByRole(role: 'user' | 'admin' | 'sub-admin'): Promise<User[]> {
      return await db
        .select()
        .from(users)
        .where(eq(users.role, role))
        .orderBy(desc(users.createdAt));
    }

    async getAllUsers(): Promise<User[]> {
      return await db
        .select()
        .from(users)
        .orderBy(desc(users.createdAt));
    }

    // User Sessions
    async createUserSession(insertSession: InsertUserSession): Promise<UserSession> {
      const [session] = await db
        .insert(userSessions)
        .values(insertSession)
        .returning();
      return session;
    }

    async updateSessionActivity(sessionId: string): Promise<UserSession | undefined> {
      const [session] = await db
        .update(userSessions)
        .set({ lastActivity: sql`CURRENT_TIMESTAMP` })
        .where(eq(userSessions.sessionId, sessionId))
        .returning();
      return session || undefined;
    }

    async deactivateUserSessions(userId: string): Promise<void> {
      await db
        .update(userSessions)
        .set({ isActive: false })
        .where(eq(userSessions.userId, userId));
    }

    async getActiveUserSessions(): Promise<UserSession[]> {
      return await db
        .select()
        .from(userSessions)
        .where(eq(userSessions.isActive, true))
        .orderBy(desc(userSessions.lastActivity));
    }

    // Activity Logs
    async logActivity(insertLog: InsertActivityLog): Promise<ActivityLog> {
      const [log] = await db
        .insert(activityLogs)
        .values(insertLog)
        .returning();
      return log;
    }

    async getActivityLogs(options: { userId?: string; action?: string; limit?: number; offset?: number } = {}): Promise<ActivityLog[]> {
      const whereConditions = [];

      if (options.userId) {
        whereConditions.push(eq(activityLogs.userId, options.userId));
      }

      if (options.action) {
        whereConditions.push(eq(activityLogs.action, options.action));
      }

      const baseQuery = db.select().from(activityLogs);

      const queryWithWhere = whereConditions.length > 0
        ? baseQuery.where(whereConditions.length === 1 ? whereConditions[0] : and(...whereConditions))
        : baseQuery;

      const queryWithOrder = queryWithWhere.orderBy(desc(activityLogs.timestamp));

      const queryWithLimit = options.limit
        ? queryWithOrder.limit(options.limit)
        : queryWithOrder;

      const finalQuery = options.offset
        ? queryWithLimit.offset(options.offset)
        : queryWithLimit;

      return await finalQuery;
    }

    async getUserLoginStats(): Promise<{ userId: string; displayName: string; email: string; lastLogin: Date; loginCount: number; }[]> {
      const result = await db
        .select({
          userId: users.id,
          displayName: users.displayName,
          email: users.email,
          lastLogin: users.lastLogin,
          loginCount: sql<number>`COUNT(${activityLogs.id})`.as('loginCount')
        })
        .from(users)
        .leftJoin(activityLogs, and(
          eq(users.id, activityLogs.userId),
          eq(activityLogs.action, 'login')
        ))
        .groupBy(users.id, users.displayName, users.email, users.lastLogin)
        .orderBy(desc(users.lastLogin));

      return result.map(row => ({
        ...row,
        lastLogin: row.lastLogin || new Date(),
        loginCount: row.loginCount || 0
      }));
    }

    async getAllTeamMembers(): Promise<TeamMember[]> {
      return await db.select().from(teamMembers);
    }

    async getTeamMember(id: string): Promise<TeamMember | undefined> {
      const [member] = await db.select().from(teamMembers).where(eq(teamMembers.id, id));
      return member || undefined;
    }

    async createTeamMember(member: InsertTeamMember): Promise<TeamMember> {
      const [newMember] = await db
        .insert(teamMembers)
        .values(member)
        .returning();
      return newMember;
    }

    async getAllProjects(): Promise<Project[]> {
      const result = await db
        .select()
        .from(projects)
        .orderBy(desc(projects.lastUpdated));

      return result;
    }

    async getProject(id: string): Promise<Project | undefined> {
      const [result] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, id));

      return result || undefined;
    }

    async createProject(project: InsertProject): Promise<Project> {
      const [newProject] = await db
        .insert(projects)
        .values(project)
        .returning();

      return newProject;
    }

    async updateProject(id: string, updates: UpdateProject): Promise<Project | undefined> {
      const oldProject = await this.getProject(id);

      const [updatedProject] = await db
        .update(projects)
        .set({ ...updates, lastUpdated: sql`CURRENT_TIMESTAMP` })
        .where(eq(projects.id, id))
        .returning();

      if (updatedProject) {
        // Check if this update affects dependency resolution
        if (updates.status === 'Completed' && oldProject?.status !== 'Completed') {
          // This task was just completed, check for dependent tasks
          await this.resolveDependencies(id);
        }

        // Handle goal progress update if the task is linked to a goal
        if (updatedProject.linkedGoalId) {
          await this.updateGoalProgress(updatedProject.linkedGoalId);
        }

        // If dependencies were updated, validate blocking status
        if (updates.dependencies) {
          await this.validateAndBlockIfNeeded(id, updates.dependencies);
        }
      }

      return updatedProject || undefined;
    }

    async deleteProject(id: string): Promise<boolean> {
      const result = await db.delete(projects).where(eq(projects.id, id));
      return (result.rowCount || 0) > 0;
    }

    async getProjectsByDepartment(department: string): Promise<Project[]> {
      const result = await db
        .select()
        .from(projects)
        .where(eq(projects.department, department as any))
        .orderBy(desc(projects.lastUpdated));

      return result;
    }

    async getProjectsByStatus(status: string): Promise<Project[]> {
      const result = await db
        .select()
        .from(projects)
        .where(eq(projects.status, status as any))
        .orderBy(desc(projects.lastUpdated));

      return result;
    }

    async getProjectsByOwner(owner: string): Promise<Project[]> {
      const result = await db
        .select()
        .from(projects)
        .where(eq(projects.owner, owner))
        .orderBy(desc(projects.lastUpdated));

      return result;
    }

    async searchProjects(query: string): Promise<Project[]> {
      const result = await db
        .select()
        .from(projects)
        .where(ilike(projects.task, `%${query}%`))
        .orderBy(desc(projects.lastUpdated));

      return result;
    }

    async getProjectMetrics() {
      const allProjects = await db.select().from(projects);

      const metrics = {
        totalTasks: allProjects.length,
        completed: allProjects.filter(p => p.status === 'Completed').length,
        inProgress: allProjects.filter(p => p.status === 'In Progress').length,
        notStarted: allProjects.filter(p => p.status === 'Not Started').length,
        blocked: allProjects.filter(p => p.status === 'Blocked').length,
        reviewing: allProjects.filter(p => p.status === 'Reviewing' || p.status === 'Design Approval Needed').length,
        overdue: 0, // Will implement date checking later
        temporaryHold: allProjects.filter(p => p.status === 'Temporary Hold').length,
        completionPercentage: allProjects.length > 0
          ? Math.round((allProjects.filter(p => p.status === 'Completed').length / allProjects.length) * 100)
          : 0,
      };

      return metrics;
    }

    // Dependency Management Methods
    async resolveDependencies(completedTaskId: string): Promise<void> {
      // Find all projects that depend on this completed task
      const dependentProjects = await db
        .select()
        .from(projects)
        .where(sql`${completedTaskId} = ANY(${projects.dependencies})`);

      for (const project of dependentProjects) {
        // Check if all dependencies are now completed
        const allDependenciesCompleted = await this.areAllDependenciesCompleted(project.dependencies || []);

        if (allDependenciesCompleted && project.status === 'Blocked') {
          // Unblock the project
          await db
            .update(projects)
            .set({ status: 'Not Started', lastUpdated: sql`CURRENT_TIMESTAMP` })
            .where(eq(projects.id, project.id));
        }
      }
    }

    async areAllDependenciesCompleted(dependencyIds: string[]): Promise<boolean> {
      if (!dependencyIds || dependencyIds.length === 0) return true;

      const dependencies = await db
        .select()
        .from(projects)
        .where(sql`${projects.id} = ANY(${dependencyIds})`);

      return dependencies.every(dep => dep.status === 'Completed');
    }

    async validateAndBlockIfNeeded(projectId: string, dependencies: string[] = []): Promise<void> {
      if (!dependencies || dependencies.length === 0) return;

      const allDependenciesCompleted = await this.areAllDependenciesCompleted(dependencies);

      if (!allDependenciesCompleted) {
        await db
          .update(projects)
          .set({ status: 'Blocked', lastUpdated: sql`CURRENT_TIMESTAMP` })
          .where(eq(projects.id, projectId));
      }
    }

    async getDependencyInfo(projectId: string): Promise<{
      dependencies: Project[];
      dependents: Project[];
      blockedBy: Project[];
    }> {
      const project = await this.getProject(projectId);
      if (!project) {
        return { dependencies: [], dependents: [], blockedBy: [] };
      }

      // Get tasks this project depends on
      const dependencies = project.dependencies && project.dependencies.length > 0
        ? await db
            .select()
            .from(projects)
            .where(sql`${projects.id} = ANY(${project.dependencies})`)
        : [];

      // Get tasks that depend on this project
      const dependents = await db
        .select()
        .from(projects)
        .where(sql`${projectId} = ANY(${projects.dependencies})`);

      // Get incomplete dependencies (blocking this task)
      const blockedBy = dependencies.filter(dep => dep.status !== 'Completed');

      return { dependencies, dependents, blockedBy };
    }

    // Goal Management Methods
    async getAllGoals(): Promise<Goal[]> {
      return await db
        .select()
        .from(goals)
        .orderBy(desc(goals.createdAt));
    }

    async getGoal(id: string): Promise<Goal | undefined> {
      const [goal] = await db.select().from(goals).where(eq(goals.id, id));
      return goal || undefined;
    }

    async createGoal(insertGoal: InsertGoal): Promise<Goal> {
      const [goal] = await db
        .insert(goals)
        .values(insertGoal)
        .returning();
      return goal;
    }

    async updateGoal(id: string, updates: UpdateGoal): Promise<Goal | undefined> {
      const [goal] = await db
        .update(goals)
        .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(goals.id, id))
        .returning();
      return goal || undefined;
    }

    async deleteGoal(id: string): Promise<boolean> {
      const result = await db.delete(goals).where(eq(goals.id, id));
      return result.rowCount !== null && result.rowCount > 0;
    }

    async getGoalProgress(id: string): Promise<{
      totalTasks: number;
      completedTasks: number;
      progressPercentage: number;
    }> {
      const goal = await this.getGoal(id);
      if (!goal || !goal.taskIds || goal.taskIds.length === 0) {
        return { totalTasks: 0, completedTasks: 0, progressPercentage: 0 };
      }

      const linkedTasks = await db
        .select()
        .from(projects)
        .where(sql`${projects.id} = ANY(${goal.taskIds})`);

      const totalTasks = linkedTasks.length;
      const completedTasks = linkedTasks.filter(task => task.status === 'Completed').length;
      const progressPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      return { totalTasks, completedTasks, progressPercentage };
    }

    async updateGoalProgress(goalId: string): Promise<void> {
      // This method is called when a task status changes
      // The progress calculation is done dynamically in getGoalProgress
      // We just update the goal's updatedAt timestamp to indicate recent activity
      await db
        .update(goals)
        .set({ updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(goals.id, goalId));
    }

    // Sprint Management Methods
    async getAllSprints(): Promise<Sprint[]> {
      return await db
        .select()
        .from(sprints)
        .orderBy(desc(sprints.createdAt));
    }

    async getSprint(id: string): Promise<Sprint | undefined> {
      const [sprint] = await db.select().from(sprints).where(eq(sprints.id, id));
      return sprint || undefined;
    }

    async createSprint(insertSprint: InsertSprint): Promise<Sprint> {
      const [sprint] = await db
        .insert(sprints)
        .values(insertSprint)
        .returning();
      return sprint;
    }

    async updateSprint(id: string, updates: UpdateSprint): Promise<Sprint | undefined> {
      const [sprint] = await db
        .update(sprints)
        .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(sprints.id, id))
        .returning();
      return sprint || undefined;
    }

    async deleteSprint(id: string): Promise<boolean> {
      // Remove sprint assignments from tasks first
      await db
        .update(projects)
        .set({ sprintId: null })
        .where(eq(projects.sprintId, id));

      const result = await db.delete(sprints).where(eq(sprints.id, id));
      return result.rowCount !== null && result.rowCount > 0;
    }

    async getSprintProgress(id: string): Promise<{
      totalTasks: number;
      completedTasks: number;
      totalEffort: number;
      completedEffort: number;
      progressPercentage: number;
    }> {
      const sprint = await this.getSprint(id);
      if (!sprint || !sprint.taskIds || sprint.taskIds.length === 0) {
        return {
          totalTasks: 0,
          completedTasks: 0,
          totalEffort: 0,
          completedEffort: 0,
          progressPercentage: 0
        };
      }

      const sprintTasks = await db
        .select()
        .from(projects)
        .where(sql`${projects.id} = ANY(${sprint.taskIds})`);

      const totalTasks = sprintTasks.length;
      const completedTasks = sprintTasks.filter(task => task.status === 'Completed').length;
      const totalEffort = sprintTasks.reduce((sum, task) => sum + (task.effortEstimate || 1), 0);
      const completedEffort = sprintTasks
        .filter(task => task.status === 'Completed')
        .reduce((sum, task) => sum + (task.effortEstimate || 1), 0);

      const progressPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      return { totalTasks, completedTasks, totalEffort, completedEffort, progressPercentage };
    }

    async assignTasksToSprint(sprintId: string, taskIds: string[]): Promise<void> {
      // Update tasks to assign them to the sprint
      await db
        .update(projects)
        .set({ sprintId })
        .where(sql`${projects.id} = ANY(${taskIds})`);

      // Update sprint to include these task IDs
      const sprint = await this.getSprint(sprintId);
      if (sprint) {
        const existingTaskIds = sprint.taskIds || [];
        const allTaskIds = [...existingTaskIds, ...taskIds];
        const updatedTaskIds = Array.from(new Set(allTaskIds));
        await this.updateSprint(sprintId, { taskIds: updatedTaskIds });
      }
    }

    async autoAssignTasksToSprint(sprintId: string, criteria: {
      departments?: string[];
      maxEffort?: number;
      prioritizeBy?: 'risk' | 'dueDate' | 'effort';
    }): Promise<string[]> {
      const sprint = await this.getSprint(sprintId);
      if (!sprint) return [];

      // Build query conditions
      let whereConditions = sql`${projects.sprintId} IS NULL AND ${projects.status} != 'Completed'`;

      if (criteria.departments && criteria.departments.length > 0) {
        whereConditions = sql`${whereConditions} AND ${projects.department} = ANY(${criteria.departments})`;
      }

      // Get available tasks
      let availableTasks = await db
        .select()
        .from(projects)
        .where(whereConditions);

      // Sort by priority criteria
      switch (criteria.prioritizeBy) {
        case 'risk':
          availableTasks = availableTasks.sort((a, b) => {
            const riskOrder = { 'High': 3, 'Medium': 2, 'Low': 1, '': 0 };
            return (riskOrder[b.risk as keyof typeof riskOrder] || 0) - (riskOrder[a.risk as keyof typeof riskOrder] || 0);
          });
          break;
        case 'dueDate':
          availableTasks = availableTasks.sort((a, b) => {
            if (!a.dueDate && !b.dueDate) return 0;
            if (!a.dueDate) return 1;
            if (!b.dueDate) return -1;
            return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
          });
          break;
        case 'effort':
          availableTasks = availableTasks.sort((a, b) => (a.effortEstimate || 1) - (b.effortEstimate || 1));
          break;
      }

      // Select tasks within effort limit
      const selectedTasks: string[] = [];
      let totalEffort = 0;
      const maxEffortLimit = criteria.maxEffort || 50; // Default sprint capacity

      for (const task of availableTasks) {
        const taskEffort = task.effortEstimate || 1;
        if (totalEffort + taskEffort <= maxEffortLimit) {
          selectedTasks.push(task.id);
          totalEffort += taskEffort;
        }
      }

      // Assign selected tasks to sprint
      if (selectedTasks.length > 0) {
        await this.assignTasksToSprint(sprintId, selectedTasks);
      }

      return selectedTasks;
    }

    async updateSprintProgress(sprintId: string): Promise<void> {
      const progress = await this.getSprintProgress(sprintId);

      // Update sprint with calculated progress
      await db
        .update(sprints)
        .set({
          totalEffort: progress.totalEffort,
          completedEffort: progress.completedEffort,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(sprints.id, sprintId));
    }

    // Invitation methods
    async createInvitation(invitation: InsertInvitation): Promise<Invitation> {
      const [newInvitation] = await db.insert(invitations).values(invitation).returning();
      return newInvitation;
    }

    async getInvitations(): Promise<Invitation[]> {
      return await db.select().from(invitations).orderBy(desc(invitations.createdAt));
    }

    async getInvitationByEmail(email: string): Promise<Invitation | undefined> {
      const [invitation] = await db.select().from(invitations).where(eq(invitations.email, email));
      return invitation || undefined;
    }

    // Teams methods
    async getAllTeams(): Promise<Team[]> {
      return await db.select().from(teams).orderBy(teams.createdAt);
    }

    async getTeam(id: string): Promise<Team | undefined> {
      const [team] = await db.select().from(teams).where(eq(teams.id, id));
      return team || undefined;
    }

    async createTeam(team: InsertTeam): Promise<Team> {
      const [newTeam] = await db.insert(teams).values(team).returning();
      return newTeam;
    }

    async updateTeam(id: string, updates: UpdateTeam): Promise<Team | undefined> {
      const [updatedTeam] = await db
        .update(teams)
        .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(teams.id, id))
        .returning();
      return updatedTeam || undefined;
    }

    async deleteTeam(id: string): Promise<boolean> {
      const result = await db.delete(teams).where(eq(teams.id, id));
      return result.rowCount !== null && result.rowCount > 0;
    }

    // View Preferences Implementation
    async getViewPreference(userId: string, teamId: string): Promise<ViewPreference | undefined> {
      const [preference] = await db
        .select()
        .from(viewPreferences)
        .where(and(
          eq(viewPreferences.userId, userId),
          eq(viewPreferences.teamId, teamId)
        ));
      return preference || undefined;
    }

    async setViewPreference(userId: string, teamId: string, viewType: 'table' | 'kanban'): Promise<ViewPreference> {
      // Check if preference exists
      const existing = await this.getViewPreference(userId, teamId);

      if (existing) {
        // Update existing preference
        const [updated] = await db
          .update(viewPreferences)
          .set({ viewType, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(and(
            eq(viewPreferences.userId, userId),
            eq(viewPreferences.teamId, teamId)
          ))
          .returning();
        return updated;
      } else {
        // Create new preference
        const [created] = await db
          .insert(viewPreferences)
          .values({ userId, teamId, viewType })
          .returning();
        return created;
      }
    }

    // Kanban Columns Implementation
    async getKanbanColumns(teamId: string): Promise<KanbanColumn[]> {
      // Fetch existing columns
      const columns = await db
        .select()
        .from(kanbanColumns)
        .where(eq(kanbanColumns.teamId, teamId))
        .orderBy(kanbanColumns.order);

      // Lazy create default columns if none exist
      if (columns.length === 0) {
        const defaultColumns = [
          { teamId, name: 'New task', color: '#8B5CF6', icon: '📋', order: 0, isDefault: true },
          { teamId, name: 'Scheduled', color: '#3B82F6', icon: '📅', order: 1, isDefault: true },
          { teamId, name: 'In Progress', color: '#F59E0B', icon: '🔨', order: 2, isDefault: true },
          { teamId, name: 'Completed', color: '#10B981', icon: '✅', order: 3, isDefault: true },
        ];

        for (const column of defaultColumns) {
          await db.insert(kanbanColumns).values(column);
        }

        // Fetch and return the newly created columns
        const newColumns = await db
          .select()
          .from(kanbanColumns)
          .where(eq(kanbanColumns.teamId, teamId))
          .orderBy(kanbanColumns.order);

        return newColumns;
      }

      return columns;
    }

    async createKanbanColumn(column: InsertKanbanColumn): Promise<KanbanColumn> {
      const [newColumn] = await db
        .insert(kanbanColumns)
        .values(column)
        .returning();
      return newColumn;
    }

    async updateKanbanColumn(id: string, updates: UpdateKanbanColumn): Promise<KanbanColumn | undefined> {
      const [updated] = await db
        .update(kanbanColumns)
        .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(kanbanColumns.id, id))
        .returning();
      return updated || undefined;
    }

    async deleteKanbanColumn(id: string): Promise<boolean> {
      const result = await db.delete(kanbanColumns).where(eq(kanbanColumns.id, id));
      return result.rowCount !== null && result.rowCount > 0;
    }

    async updateProjectColumn(projectId: string, columnName: string): Promise<void> {
      // This method updates the project's status or notes to reflect its kanban column
      // For now, we'll just update the project to mark it as updated
      await db
        .update(projects)
        .set({ lastUpdated: sql`CURRENT_TIMESTAMP` })
        .where(eq(projects.id, projectId));
    }

    // Documents Implementation
    async getAllDocuments(): Promise<Document[]> {
      const docs = await db
        .select()
        .from(documents)
        .orderBy(desc(documents.updatedAt));
      return docs;
    }

    async getDocument(id: string): Promise<Document | undefined> {
      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, id));
      return doc || undefined;
    }

    async getDocumentsByOwner(ownerId: string): Promise<Document[]> {
      const docs = await db
        .select()
        .from(documents)
        .where(eq(documents.ownerId, ownerId))
        .orderBy(desc(documents.updatedAt));
      return docs;
    }

    async getDocumentsByCategory(category: 'blank' | 'meeting_notes'): Promise<Document[]> {
      const docs = await db
        .select()
        .from(documents)
        .where(eq(documents.category, category))
        .orderBy(desc(documents.updatedAt));
      return docs;
    }

    async createDocument(doc: InsertDocument): Promise<Document> {
      const [newDoc] = await db
        .insert(documents)
        .values(doc)
        .returning();
      return newDoc;
    }

    async updateDocument(id: string, updates: UpdateDocument): Promise<Document | undefined> {
      const [updated] = await db
        .update(documents)
        .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(documents.id, id))
        .returning();
      return updated || undefined;
    }

    async deleteDocument(id: string): Promise<boolean> {
      // Delete all comments first
      await db.delete(documentComments).where(eq(documentComments.documentId, id));
      // Then delete the document
      const result = await db.delete(documents).where(eq(documents.id, id));
      return result.rowCount !== null && result.rowCount > 0;
    }

    // Document Comments Implementation
    async getDocumentComments(documentId: string): Promise<DocumentComment[]> {
      const comments = await db
        .select()
        .from(documentComments)
        .where(eq(documentComments.documentId, documentId))
        .orderBy(documentComments.createdAt);
      return comments;
    }

    async createDocumentComment(comment: InsertDocumentComment): Promise<DocumentComment> {
      const [newComment] = await db
        .insert(documentComments)
        .values(comment)
        .returning();
      return newComment;
    }

    async updateDocumentComment(id: string, updates: UpdateDocumentComment): Promise<DocumentComment | undefined> {
      const [updated] = await db
        .update(documentComments)
        .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(documentComments.id, id))
        .returning();
      return updated || undefined;
    }

    async deleteDocumentComment(id: string): Promise<boolean> {
      const result = await db.delete(documentComments).where(eq(documentComments.id, id));
      return result.rowCount !== null && result.rowCount > 0;
    }

 // ========== SPACES IMPLEMENTATION ==========
 async getAllSpaces(): Promise<Space[]> {
  const allSpaces = await db
    .select()
    .from(spaces)
    .orderBy(desc(spaces.updatedAt));
  return allSpaces;
}

async getSpace(id: string): Promise<Space | undefined> {
  const [space] = await db
    .select()
    .from(spaces)
    .where(eq(spaces.id, id));
  return space || undefined;
}

async getSpacesByOwner(ownerId: string): Promise<Space[]> {
  const spaceList = await db
    .select()
    .from(spaces)
    .where(eq(spaces.ownerId, ownerId))
    .orderBy(desc(spaces.updatedAt));
  return spaceList;
}

async getSpacesForUser(userId: string, companyId: string | null): Promise<Space[]> {
  let companySpaces: Space[] = [];

  if (!companyId) {
    companySpaces = await db
      .select()
      .from(spaces)
      .where(and(
        eq(spaces.ownerId, userId),
        isNull(spaces.companyId)
      ))
      .orderBy(desc(spaces.updatedAt));
  } else {
    companySpaces = await db
      .select()
      .from(spaces)
      .where(eq(spaces.companyId, companyId))
      .orderBy(desc(spaces.updatedAt));
  }

  const accessibleSpaces = companySpaces.filter(space => {
    if (space.ownerId === userId) return true;
    if (space.privacy === 'shared') return true;
    if (space.privacy === 'private' && space.memberIds) {
      return space.memberIds.includes(userId);
    }
    return false;
  });

  return accessibleSpaces;
}

async createSpace(spaceData: InsertSpace): Promise<Space> {
  return await db.transaction(async (tx) => {
    // 1. Extract statuses before inserting space
    const { statuses, ...spaceWithoutStatuses } = spaceData;

    // 2. Create the space (without statuses field)
    const [newSpace] = await tx
      .insert(spaces)
      .values(spaceWithoutStatuses)
      .returning();

    // 3. Create statuses with order preserved
    if (statuses && statuses.length > 0) {
      const statusValues = statuses.map((status, index) => ({
        spaceId: newSpace.id,
        name: status.name,
        colorCode: status.colorCode,
        order: status.order ?? index,
      }));

      await tx.insert(spaceStatuses).values(statusValues);
    }

    return newSpace;
  });
}


async updateSpace(id: string, updates: UpdateSpace): Promise<Space | undefined> {
  const [updated] = await db
    .update(spaces)
    .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(spaces.id, id))
    .returning();
  return updated || undefined;
}

async deleteSpace(id: string): Promise<boolean> {
  // Delete all tasks in this space
  await db.delete(tasks).where(eq(tasks.spaceId, id));

  // Delete all statuses in this space
  await db.delete(spaceStatuses).where(eq(spaceStatuses.spaceId, id));

  // Delete the space
  const result = await db.delete(spaces).where(eq(spaces.id, id));
  return result.rowCount !== null && result.rowCount > 0;
}

// ========== SPACE STATUSES IMPLEMENTATION ==========
async getSpaceStatuses(spaceId: string): Promise<SpaceStatus[]> {
  const statusList = await db
    .select()
    .from(spaceStatuses)
    .where(eq(spaceStatuses.spaceId, spaceId))
    .orderBy(spaceStatuses.order, spaceStatuses.createdAt);
  return statusList;
}


async createSpaceStatus(status: InsertSpaceStatus): Promise<SpaceStatus> {
  const [newStatus] = await db
    .insert(spaceStatuses)
    .values(status)
    .returning();
  return newStatus;
}

async updateSpaceStatus(id: string, updates: { name?: string; colorCode?: string }): Promise<SpaceStatus | undefined> {
  const [updated] = await db
    .update(spaceStatuses)
    .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(spaceStatuses.id, id))
    .returning();
  return updated || undefined;
}

async deleteSpaceStatus(id: string): Promise<boolean> {
  const result = await db
    .delete(spaceStatuses)
    .where(eq(spaceStatuses.id, id));
  return result.rowCount !== null && result.rowCount > 0;
}

async deleteAllSpaceStatuses(spaceId: string): Promise<boolean> {
  const result = await db
    .delete(spaceStatuses)
    .where(eq(spaceStatuses.spaceId, spaceId));
  return result.rowCount !== null && result.rowCount > 0;
}

// ========== TASKS IMPLEMENTATION ==========
async getAllTasks(spaceId: string): Promise<Task[]> {
  const taskList = await db
    .select()
    .from(tasks)
    .where(eq(tasks.spaceId, spaceId))
    .orderBy(desc(tasks.updatedAt));
  return taskList;
}

async getTask(id: string): Promise<Task | undefined> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, id));
  return task || undefined;
}

async createTask(task: InsertTask): Promise<Task> {
  const [newTask] = await db
    .insert(tasks)
    .values(task)
    .returning();
  return newTask;
}

async updateTask(id: string, updates: UpdateTask): Promise<Task | undefined> {
  const [updated] = await db
    .update(tasks)
    .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(tasks.id, id))
    .returning();
  return updated || undefined;
}

async deleteTask(id: string): Promise<boolean> {
  const result = await db.delete(tasks).where(eq(tasks.id, id));
  return result.rowCount !== null && result.rowCount > 0;
 }

// ========== COMPANIES IMPLEMENTATION ==========
async createCompany(companyData: InsertCompany): Promise<Company> {
  const [company] = await db.insert(companies).values(companyData).returning();
  return company;
}

async getCompanyById(id: string): Promise<Company | undefined> {
  const [company] = await db.select().from(companies).where(eq(companies.id, id));
  return company || undefined;
}

async getCompanyByOwner(ownerUserId: string): Promise<Company | undefined> {
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.ownerUserId, ownerUserId));
  return company || undefined;
}

async updateCompany(id: string, updates: UpdateCompany): Promise<Company | undefined> {
  const [updated] = await db
    .update(companies)
    .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(companies.id, id))
    .returning();
  return updated || undefined;
}

// ── Workflows (migrated from Nexus) ──────────────────────────────────────────
async getWorkflow(id: string): Promise<Workflow | undefined> {
  const [wf] = await db.select().from(workflows).where(eq(workflows.id, id));
  return wf || undefined;
}

async getWorkflowsByOwner(ownerId: string): Promise<Workflow[]> {
  return db.select().from(workflows).where(eq(workflows.ownerId, ownerId)).orderBy(desc(workflows.createdAt));
}

async createWorkflow(wf: InsertWorkflow): Promise<Workflow> {
  const [created] = await db.insert(workflows).values(wf).returning();
  return created;
}

async updateWorkflow(id: string, updates: UpdateWorkflow): Promise<Workflow | undefined> {
  // Use raw SQL via the pg pool to ensure JSONB is handled correctly
  const { pool } = await import("./db");

  const setClauses: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (updates.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(updates.name); }
  if (updates.status !== undefined) { setClauses.push(`status = $${idx++}::workflow_status`); params.push(updates.status); }
  if (updates.ownerId !== undefined) { setClauses.push(`owner_id = $${idx++}`); params.push(updates.ownerId); }
  if (updates.isFavorite !== undefined) { setClauses.push(`is_favorite = $${idx++}`); params.push(updates.isFavorite); }
  if ((updates as any).lastPublished !== undefined) { setClauses.push(`last_published = $${idx++}`); params.push((updates as any).lastPublished); }
  if (updates.steps !== undefined) { setClauses.push(`steps = $${idx++}::jsonb`); params.push(JSON.stringify(updates.steps)); }

  setClauses.push("updated_at = CURRENT_TIMESTAMP");
  params.push(id);

  const query = `UPDATE workflows SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`;

  const result = await pool.query(query, params);
  if (result.rows.length === 0) return undefined;

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    ownerId: row.owner_id,
    isFavorite: row.is_favorite,
    steps: typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps,
    lastPublished: row.last_published,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as Workflow;
}

async deleteWorkflow(id: string): Promise<boolean> {
  // Delete logs first, then the workflow
  await db.delete(workflowLogs).where(eq(workflowLogs.workflowId, id));
  const result = await db.delete(workflows).where(eq(workflows.id, id));
  return result.rowCount !== null && result.rowCount > 0;
}

async getActiveWorkflowsByTrigger(triggerLabel: string): Promise<Workflow[]> {
  // Get all live workflows, then filter in-memory for matching trigger in steps JSON
  const liveWorkflows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.status, "live"));
  return liveWorkflows.filter((wf) => {
    const steps = (wf.steps as any[]) || [];
    return steps.some((s: any) => s.type === "when" && s.label === triggerLabel);
  });
}

async createWorkflowLog(log: InsertWorkflowLog): Promise<WorkflowLog> {
  const [created] = await db.insert(workflowLogs).values(log).returning();
  return created;
}

async getWorkflowLogs(workflowId: string): Promise<WorkflowLog[]> {
  return db
    .select()
    .from(workflowLogs)
    .where(eq(workflowLogs.workflowId, workflowId))
    .orderBy(desc(workflowLogs.executedAt));
}

// ── Slack user mapping (migrated from Nexus) ─────────────────────────────────
async updateUserSlackId(userId: string, slackUserId: string): Promise<void> {
  await db.update(users).set({ slackUserId: slackUserId || null }).where(eq(users.id, userId));
}

// ── Integration storage methods (migrated from Nexus) ────────────────────────
// ── Task Activities ────────────────────────────────────────────────────────
async createTaskActivity(activity: InsertTaskActivity): Promise<TaskActivity> {
  const [created] = await db.insert(taskActivities).values(activity).returning();
  return created;
}

async getTaskActivities(taskId: string, limit = 100): Promise<TaskActivity[]> {
  return db
    .select()
    .from(taskActivities)
    .where(eq(taskActivities.taskId, taskId))
    .orderBy(desc(taskActivities.createdAt))
    .limit(limit);
}

// ── GitHub Repo Connections ────────────────────────────────────────────────
async getSpaceGithubRepos(spaceId: string): Promise<SpaceGithubRepo[]> {
  return db
    .select()
    .from(spaceGithubRepos)
    .where(eq(spaceGithubRepos.spaceId, spaceId))
    .orderBy(desc(spaceGithubRepos.createdAt));
}

async getSpaceGithubRepoByFullName(spaceId: string, repoFullName: string): Promise<SpaceGithubRepo | undefined> {
  const [repo] = await db
    .select()
    .from(spaceGithubRepos)
    .where(and(eq(spaceGithubRepos.spaceId, spaceId), eq(spaceGithubRepos.repoFullName, repoFullName)));
  return repo || undefined;
}

async getSpaceGithubRepoById(id: string): Promise<SpaceGithubRepo | undefined> {
  const [repo] = await db.select().from(spaceGithubRepos).where(eq(spaceGithubRepos.id, id));
  return repo || undefined;
}

async createSpaceGithubRepo(repo: InsertSpaceGithubRepo): Promise<SpaceGithubRepo> {
  const [created] = await db.insert(spaceGithubRepos).values(repo).returning();
  return created;
}

async updateSpaceGithubRepo(id: string, updates: Partial<InsertSpaceGithubRepo>): Promise<SpaceGithubRepo | undefined> {
  const [updated] = await db
    .update(spaceGithubRepos)
    .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(spaceGithubRepos.id, id))
    .returning();
  return updated || undefined;
}

async deleteSpaceGithubRepo(id: string): Promise<boolean> {
  const result = await db.delete(spaceGithubRepos).where(eq(spaceGithubRepos.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ── GitHub Webhooks ────────────────────────────────────────────────────────
async createGithubWebhook(data: {
  spaceGithubRepoId: string;
  repoFullName: string;
  webhookId: number;
  secret: string;
  events: string[];
}): Promise<GithubWebhook> {
  const [created] = await db
    .insert(githubWebhooks)
    .values({ ...data, active: true })
    .returning();
  return created;
}

async getGithubWebhooksByRepo(repoFullName: string): Promise<GithubWebhook[]> {
  return db
    .select()
    .from(githubWebhooks)
    .where(and(eq(githubWebhooks.repoFullName, repoFullName), eq(githubWebhooks.active, true)));
}

async deleteGithubWebhook(id: string): Promise<boolean> {
  const result = await db.delete(githubWebhooks).where(eq(githubWebhooks.id, id));
  return (result.rowCount ?? 0) > 0;
}

async deleteGithubWebhooksByRepo(spaceGithubRepoId: string): Promise<void> {
  await db.delete(githubWebhooks).where(eq(githubWebhooks.spaceGithubRepoId, spaceGithubRepoId));
}

// ── Task ↔ GitHub Links ────────────────────────────────────────────────────
async createTaskGithubLink(link: InsertTaskGithubLink): Promise<TaskGithubLink> {
  const [created] = await db.insert(taskGithubLinks).values(link).returning();
  return created;
}

async getTaskGithubLinks(taskId: string): Promise<TaskGithubLink[]> {
  return db
    .select()
    .from(taskGithubLinks)
    .where(eq(taskGithubLinks.taskId, taskId))
    .orderBy(desc(taskGithubLinks.createdAt));
}

async findTaskGithubLink(
  taskId: string,
  type: string,
  repoFullName: string,
  externalId: string,
): Promise<TaskGithubLink | undefined> {
  const [link] = await db
    .select()
    .from(taskGithubLinks)
    .where(
      and(
        eq(taskGithubLinks.taskId, taskId),
        eq(taskGithubLinks.type, type),
        eq(taskGithubLinks.repoFullName, repoFullName),
        eq(taskGithubLinks.externalId, externalId),
      ),
    );
  return link || undefined;
}

async updateTaskGithubLink(id: string, updates: Partial<InsertTaskGithubLink>): Promise<TaskGithubLink | undefined> {
  const [updated] = await db
    .update(taskGithubLinks)
    .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(taskGithubLinks.id, id))
    .returning();
  return updated || undefined;
}

async deleteTaskGithubLink(id: string): Promise<boolean> {
  const result = await db.delete(taskGithubLinks).where(eq(taskGithubLinks.id, id));
  return (result.rowCount ?? 0) > 0;
}

async findLinksByExternal(
  type: string,
  repoFullName: string,
  externalId: string,
): Promise<TaskGithubLink[]> {
  return db
    .select()
    .from(taskGithubLinks)
    .where(
      and(
        eq(taskGithubLinks.type, type),
        eq(taskGithubLinks.repoFullName, repoFullName),
        eq(taskGithubLinks.externalId, externalId),
      ),
    );
}

// ── Webhook Delivery Log (idempotency) ─────────────────────────────────────
async getWebhookDelivery(deliveryId: string): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: githubWebhookDeliveries.id })
    .from(githubWebhookDeliveries)
    .where(eq(githubWebhookDeliveries.deliveryId, deliveryId));
  return row || undefined;
}

async recordWebhookDelivery(data: {
  deliveryId: string;
  event: string;
  repoFullName?: string;
  payload: any;
  status: string;
  error?: string;
}): Promise<void> {
  await db.insert(githubWebhookDeliveries).values({
    deliveryId: data.deliveryId,
    event: data.event,
    repoFullName: data.repoFullName,
    payload: data.payload,
    status: data.status,
    error: data.error,
    processedAt: sql`CURRENT_TIMESTAMP`,
  });
}

// ── Lookup task by shortId within a space ──────────────────────────────────
async getTaskByShortId(spaceId: string, shortId: number): Promise<Task | undefined> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.spaceId, spaceId), eq(tasks.shortId, shortId)));
  return task || undefined;
}

// ── Jira: Space ↔ Project connections ──────────────────────────────────────
async getSpaceJiraProjects(spaceId: string): Promise<SpaceJiraProject[]> {
  return db
    .select()
    .from(spaceJiraProjects)
    .where(eq(spaceJiraProjects.spaceId, spaceId))
    .orderBy(desc(spaceJiraProjects.createdAt));
}

async getSpaceJiraProjectById(id: string): Promise<SpaceJiraProject | undefined> {
  const [row] = await db.select().from(spaceJiraProjects).where(eq(spaceJiraProjects.id, id));
  return row || undefined;
}

async getSpaceJiraProjectByKey(spaceId: string, cloudId: string, projectKey: string): Promise<SpaceJiraProject | undefined> {
  const [row] = await db
    .select()
    .from(spaceJiraProjects)
    .where(
      and(
        eq(spaceJiraProjects.spaceId, spaceId),
        eq(spaceJiraProjects.cloudId, cloudId),
        eq(spaceJiraProjects.projectKey, projectKey),
      ),
    );
  return row || undefined;
}

/**
 * Lookup connected Jira projects by cloudId + projectKey.
 * Used by webhook handler to figure out which space(s) to route events to.
 */
async getJiraProjectsByKey(cloudId: string, projectKey: string): Promise<SpaceJiraProject[]> {
  return db
    .select()
    .from(spaceJiraProjects)
    .where(and(eq(spaceJiraProjects.cloudId, cloudId), eq(spaceJiraProjects.projectKey, projectKey)));
}

async createSpaceJiraProject(data: InsertSpaceJiraProject): Promise<SpaceJiraProject> {
  const [created] = await db.insert(spaceJiraProjects).values(data).returning();
  return created;
}

async updateSpaceJiraProject(id: string, updates: Partial<InsertSpaceJiraProject>): Promise<SpaceJiraProject | undefined> {
  const [updated] = await db
    .update(spaceJiraProjects)
    .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(spaceJiraProjects.id, id))
    .returning();
  return updated || undefined;
}

async deleteSpaceJiraProject(id: string): Promise<boolean> {
  const result = await db.delete(spaceJiraProjects).where(eq(spaceJiraProjects.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ── Jira: Task links ───────────────────────────────────────────────────────
async createTaskJiraLink(link: InsertTaskJiraLink): Promise<TaskJiraLink> {
  const [created] = await db.insert(taskJiraLinks).values(link).returning();
  return created;
}

async getTaskJiraLinks(taskId: string): Promise<TaskJiraLink[]> {
  return db
    .select()
    .from(taskJiraLinks)
    .where(eq(taskJiraLinks.taskId, taskId))
    .orderBy(desc(taskJiraLinks.createdAt));
}

async findTaskJiraLink(taskId: string, cloudId: string, issueKey: string): Promise<TaskJiraLink | undefined> {
  const [link] = await db
    .select()
    .from(taskJiraLinks)
    .where(
      and(
        eq(taskJiraLinks.taskId, taskId),
        eq(taskJiraLinks.cloudId, cloudId),
        eq(taskJiraLinks.issueKey, issueKey),
      ),
    );
  return link || undefined;
}

async findLinksByJiraIssue(cloudId: string, issueKey: string): Promise<TaskJiraLink[]> {
  return db
    .select()
    .from(taskJiraLinks)
    .where(and(eq(taskJiraLinks.cloudId, cloudId), eq(taskJiraLinks.issueKey, issueKey)));
}

async updateTaskJiraLink(id: string, updates: Partial<InsertTaskJiraLink>): Promise<TaskJiraLink | undefined> {
  const [updated] = await db
    .update(taskJiraLinks)
    .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(taskJiraLinks.id, id))
    .returning();
  return updated || undefined;
}

async deleteTaskJiraLink(id: string): Promise<boolean> {
  const result = await db.delete(taskJiraLinks).where(eq(taskJiraLinks.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ── Jira: Webhook delivery log ─────────────────────────────────────────────
async getJiraWebhookDelivery(deliveryKey: string): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: jiraWebhookDeliveries.id })
    .from(jiraWebhookDeliveries)
    .where(eq(jiraWebhookDeliveries.deliveryKey, deliveryKey));
  return row || undefined;
}

async recordJiraWebhookDelivery(data: {
  deliveryKey: string;
  event: string;
  issueKey?: string;
  payload: any;
  status: string;
  error?: string;
}): Promise<void> {
  await db.insert(jiraWebhookDeliveries).values({
    deliveryKey: data.deliveryKey,
    event: data.event,
    issueKey: data.issueKey,
    payload: data.payload,
    status: data.status,
    error: data.error,
    processedAt: sql`CURRENT_TIMESTAMP`,
  });
}

// ── File Attachments (Drive / OneDrive / Dropbox) ──────────────────────────
async createFileAttachment(att: InsertTaskFileAttachment): Promise<TaskFileAttachment> {
  const [created] = await db.insert(taskFileAttachments).values(att).returning();
  return created;
}

async getTaskFileAttachments(taskId: string): Promise<TaskFileAttachment[]> {
  return db
    .select()
    .from(taskFileAttachments)
    .where(eq(taskFileAttachments.taskId, taskId))
    .orderBy(desc(taskFileAttachments.createdAt));
}

async findFileAttachment(taskId: string, provider: string, externalId: string): Promise<TaskFileAttachment | undefined> {
  const [row] = await db
    .select()
    .from(taskFileAttachments)
    .where(
      and(
        eq(taskFileAttachments.taskId, taskId),
        eq(taskFileAttachments.provider, provider),
        eq(taskFileAttachments.externalId, externalId),
      ),
    );
  return row || undefined;
}

async deleteFileAttachment(id: string): Promise<boolean> {
  const result = await db.delete(taskFileAttachments).where(eq(taskFileAttachments.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ── Figma Links ────────────────────────────────────────────────────────────
async createTaskFigmaLink(link: InsertTaskFigmaLink): Promise<TaskFigmaLink> {
  const [created] = await db.insert(taskFigmaLinks).values(link).returning();
  return created;
}

async getTaskFigmaLinks(taskId: string): Promise<TaskFigmaLink[]> {
  return db
    .select()
    .from(taskFigmaLinks)
    .where(eq(taskFigmaLinks.taskId, taskId))
    .orderBy(desc(taskFigmaLinks.createdAt));
}

async findTaskFigmaLink(taskId: string, fileKey: string, nodeId: string | null): Promise<TaskFigmaLink | undefined> {
  const conds = [
    eq(taskFigmaLinks.taskId, taskId),
    eq(taskFigmaLinks.fileKey, fileKey),
  ];
  // nodeId is nullable — drizzle isNull helper
  const rows = await db.select().from(taskFigmaLinks).where(and(...conds));
  return rows.find((r) => (r.nodeId ?? null) === (nodeId ?? null));
}

async deleteTaskFigmaLink(id: string): Promise<boolean> {
  const result = await db.delete(taskFigmaLinks).where(eq(taskFigmaLinks.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ── Calendar Event Links ───────────────────────────────────────────────────
async createTaskCalendarEvent(data: InsertTaskCalendarEvent): Promise<TaskCalendarEvent> {
  const [created] = await db.insert(taskCalendarEvents).values(data).returning();
  return created;
}

async getTaskCalendarEvents(taskId: string): Promise<TaskCalendarEvent[]> {
  return db
    .select()
    .from(taskCalendarEvents)
    .where(eq(taskCalendarEvents.taskId, taskId))
    .orderBy(desc(taskCalendarEvents.createdAt));
}

async findTaskCalendarEventByType(taskId: string, type: string): Promise<TaskCalendarEvent | undefined> {
  const [row] = await db
    .select()
    .from(taskCalendarEvents)
    .where(and(eq(taskCalendarEvents.taskId, taskId), eq(taskCalendarEvents.type, type)));
  return row || undefined;
}

async updateTaskCalendarEvent(id: string, updates: Partial<InsertTaskCalendarEvent>): Promise<TaskCalendarEvent | undefined> {
  const [updated] = await db
    .update(taskCalendarEvents)
    .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(taskCalendarEvents.id, id))
    .returning();
  return updated || undefined;
}

async deleteTaskCalendarEvent(id: string): Promise<boolean> {
  const result = await db.delete(taskCalendarEvents).where(eq(taskCalendarEvents.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ── Email Links ────────────────────────────────────────────────────────────
async createTaskEmailLink(data: InsertTaskEmailLink): Promise<TaskEmailLink> {
  const [created] = await db.insert(taskEmailLinks).values(data).returning();
  return created;
}

async getTaskEmailLinks(taskId: string): Promise<TaskEmailLink[]> {
  return db
    .select()
    .from(taskEmailLinks)
    .where(eq(taskEmailLinks.taskId, taskId))
    .orderBy(desc(taskEmailLinks.receivedAt));
}

async findTaskEmailLink(taskId: string, provider: string, messageId: string): Promise<TaskEmailLink | undefined> {
  const [row] = await db
    .select()
    .from(taskEmailLinks)
    .where(
      and(
        eq(taskEmailLinks.taskId, taskId),
        eq(taskEmailLinks.provider, provider),
        eq(taskEmailLinks.messageId, messageId),
      ),
    );
  return row || undefined;
}

async deleteTaskEmailLink(id: string): Promise<boolean> {
  const result = await db.delete(taskEmailLinks).where(eq(taskEmailLinks.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ── Subtasks ─────────────────────────────────────────────────────────────
async createTaskSubtask(data: InsertTaskSubtask): Promise<TaskSubtask> {
  const [created] = await db.insert(taskSubtasks).values(data).returning();
  return created;
}

async getTaskSubtasks(taskId: string): Promise<TaskSubtask[]> {
  return db
    .select()
    .from(taskSubtasks)
    .where(eq(taskSubtasks.taskId, taskId))
    .orderBy(taskSubtasks.order, taskSubtasks.createdAt);
}

async updateTaskSubtask(id: string, updates: Partial<InsertTaskSubtask>): Promise<TaskSubtask | undefined> {
  const [updated] = await db
    .update(taskSubtasks)
    .set({ ...updates, updatedAt: new Date() } as any)
    .where(eq(taskSubtasks.id, id))
    .returning();
  return updated || undefined;
}

async deleteTaskSubtask(id: string): Promise<boolean> {
  const result = await db.delete(taskSubtasks).where(eq(taskSubtasks.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ── Checklists ───────────────────────────────────────────────────────────
async createTaskChecklist(data: InsertTaskChecklist): Promise<TaskChecklist> {
  const [created] = await db.insert(taskChecklists).values(data).returning();
  return created;
}

async getTaskChecklists(taskId: string): Promise<TaskChecklist[]> {
  return db
    .select()
    .from(taskChecklists)
    .where(eq(taskChecklists.taskId, taskId))
    .orderBy(taskChecklists.order, taskChecklists.createdAt);
}

async updateTaskChecklist(id: string, updates: Partial<InsertTaskChecklist>): Promise<TaskChecklist | undefined> {
  const [updated] = await db
    .update(taskChecklists)
    .set(updates as any)
    .where(eq(taskChecklists.id, id))
    .returning();
  return updated || undefined;
}

async deleteTaskChecklist(id: string): Promise<boolean> {
  // also delete items
  await db.delete(taskChecklistItems).where(eq(taskChecklistItems.checklistId, id));
  const result = await db.delete(taskChecklists).where(eq(taskChecklists.id, id));
  return (result.rowCount ?? 0) > 0;
}

// ── Checklist items ──────────────────────────────────────────────────────
async createTaskChecklistItem(data: InsertTaskChecklistItem): Promise<TaskChecklistItem> {
  const [created] = await db.insert(taskChecklistItems).values(data).returning();
  return created;
}

async getTaskChecklistItems(checklistId: string): Promise<TaskChecklistItem[]> {
  return db
    .select()
    .from(taskChecklistItems)
    .where(eq(taskChecklistItems.checklistId, checklistId))
    .orderBy(taskChecklistItems.order, taskChecklistItems.createdAt);
}

async updateTaskChecklistItem(id: string, updates: Partial<InsertTaskChecklistItem>): Promise<TaskChecklistItem | undefined> {
  const [updated] = await db
    .update(taskChecklistItems)
    .set(updates as any)
    .where(eq(taskChecklistItems.id, id))
    .returning();
  return updated || undefined;
}

async deleteTaskChecklistItem(id: string): Promise<boolean> {
  const result = await db.delete(taskChecklistItems).where(eq(taskChecklistItems.id, id));
  return (result.rowCount ?? 0) > 0;
}
}


export const storage = new DatabaseStorage();

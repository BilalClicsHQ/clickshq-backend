/**
 * Helper functions for managing contextId (unified identifier for departments and teams)
 * 
 * ContextId format:
 * - Department pages: "dept:<DepartmentName>" (e.g., "dept:Product", "dept:Design")
 * - Custom team pages: "team:<uuid>" (e.g., "team:abc-123-def")
 */

export type ContextType = 'dept' | 'team';

export interface ContextIdParams {
  type: ContextType;
  id: string;
}

/**
 * Generate a contextId from type and id
 */
export function getContextId({ type, id }: ContextIdParams): string {
  return `${type}:${id}`;
}

/**
 * Parse a contextId into its components
 * Returns null if invalid format
 */
export function parseContextId(contextId: string): ContextIdParams | null {
  const parts = contextId.split(':');
  if (parts.length !== 2) return null;
  
  const [type, id] = parts;
  if (type !== 'dept' && type !== 'team') return null;
  if (!id || id.trim() === '') return null;
  
  return { type: type as ContextType, id };
}

/**
 * Validate a contextId
 */
export function isValidContextId(contextId: string): boolean {
  return parseContextId(contextId) !== null;
}

/**
 * Get contextId for a department page
 */
export function getDepartmentContextId(department: string): string {
  return getContextId({ type: 'dept', id: department });
}

/**
 * Get contextId for a custom team page
 */
export function getTeamContextId(teamId: string): string {
  return getContextId({ type: 'team', id: teamId });
}

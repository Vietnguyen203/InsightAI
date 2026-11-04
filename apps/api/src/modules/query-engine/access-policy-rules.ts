import type { PolicyRules } from './query-planner';

export interface StoredPolicy {
  name: string;
  roles: string[];
  enabled: boolean;
  memberAccess: { include?: string[]; exclude?: string[] } | null;
  rowFilter: { entity: string; expr: string } | null;
}

/** `entity.*` and `metric:*` match by prefix; anything else exactly. */
const matches = (pattern: string, member: string) =>
  pattern.endsWith('*') ? member.startsWith(pattern.slice(0, -1)) : pattern === member;

/**
 * Combines the policies that apply to a role (docs/SEMANTIC_LAYER_DESIGN.md §8):
 * - no applicable policy → full access (small organizations configure nothing);
 * - members: a member is visible when ANY applicable policy grants it (include, default all,
 *   minus that policy's excludes);
 * - rows: ANY applicable policy's filter may match (OR); a policy without a row filter grants
 *   every row.
 */
export function policyRules(policies: StoredPolicy[], role: string): PolicyRules {
  const applicable = policies.filter((p) => p.enabled && p.roles.includes(role));
  if (applicable.length === 0) return { names: [], allows: () => true, rowFilters: null };

  const allows = (member: string) =>
    applicable.some((p) => {
      const include = p.memberAccess?.include;
      const exclude = p.memberAccess?.exclude ?? [];
      const included = !include || include.some((pattern) => matches(pattern, member));
      return included && !exclude.some((pattern) => matches(pattern, member));
    });
  const rowFilters = applicable.some((p) => !p.rowFilter)
    ? null
    : applicable.map((p) => p.rowFilter!);
  return { names: applicable.map((p) => p.name).sort(), allows, rowFilters };
}

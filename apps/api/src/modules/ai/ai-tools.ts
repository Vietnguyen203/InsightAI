import {
  type Catalog,
  dateRangeSchema,
  semanticKeySchema,
  semanticQueryFilterSchema,
  timeGranularitySchema,
} from '@insightai/contracts';
import { z } from 'zod';
import { normalizePhrase } from '../semantic/semantic-metric.service';
import type { ToolDefinition } from './llm-provider';

/**
 * Tools the model may call (docs/SEMANTIC_LAYER_DESIGN.md §9.1). Arguments are validated with Zod
 * before anything runs; the model can only choose members of the catalog it was given.
 */

const memberRef = z.string().regex(/^[a-z][a-z0-9_]{0,62}\.[a-z][a-z0-9_]{0,62}$/);

/** The IR the model may produce: metrics only (raw measures are not exposed to the AI). */
export const aiQuerySchema = z.strictObject({
  metrics: z.array(semanticKeySchema).min(1).max(5),
  dimensions: z.array(memberRef).max(3).default([]),
  timeDimension: z
    .strictObject({
      granularity: timeGranularitySchema.optional(),
      dateRange: dateRangeSchema.optional(),
      compareTo: z.enum(['previous_period', 'same_period_last_year']).optional(),
    })
    .optional(),
  filters: z.array(semanticQueryFilterSchema).max(10).default([]),
  orderBy: z
    .array(
      z.object({ member: z.union([semanticKeySchema, memberRef]), dir: z.enum(['asc', 'desc']) }),
    )
    .max(3)
    .default([]),
  limit: z.number().int().min(1).max(200).default(50),
});

export const toolArgs = {
  search_catalog: z.strictObject({ query: z.string().min(1).max(200) }),
  get_dimension_values: z.strictObject({
    dimension: memberRef,
    search: z.string().max(100).optional(),
  }),
  run_semantic_query: aiQuerySchema,
  ask_clarification: z.strictObject({
    question: z.string().min(1).max(500),
    options: z.array(z.string().max(200)).max(6).default([]),
  }),
  cannot_answer: z.strictObject({ reason: z.string().min(1).max(500) }),
} as const;
export type ToolName = keyof typeof toolArgs;

const describe: Record<ToolName, string> = {
  search_catalog:
    'Find metrics and dimensions by words or synonyms (Vietnamese or English). Returns keys you may use.',
  get_dimension_values:
    'List real values of a categorical dimension (most frequent first), optionally containing `search`. Use it to map words like "miền Bắc" to stored values before filtering.',
  run_semantic_query:
    'Run the query that answers the question. Use only metric and dimension keys from the catalog. Prefer date presets; explicit dates are inclusive yyyy-MM-dd.',
  ask_clarification:
    'Ask the user a question when the request is ambiguous or misses required information. Do not guess.',
  cannot_answer: 'Say the question cannot be answered with the available metrics.',
};

export const TOOL_DEFINITIONS: ToolDefinition[] = (Object.keys(toolArgs) as ToolName[]).map(
  (name) => ({
    name,
    description: describe[name],
    parameters: z.toJSONSchema(toolArgs[name], { io: 'input', unrepresentable: 'any' }),
  }),
);

/** Members matching words of the query in their key, label, description or synonyms. */
export function searchCatalog(catalog: Catalog, query: string) {
  const words = normalizePhrase(query)
    .split(' ')
    .filter((w) => w.length > 1);
  const score = (texts: (string | null)[]) => {
    const haystack = normalizePhrase(texts.filter(Boolean).join(' '));
    return words.filter((w) => haystack.includes(w)).length;
  };
  const metrics = catalog.metrics
    .map((m) => ({
      m,
      s: score([m.key.replaceAll('_', ' '), m.label, m.businessDefinition, ...m.synonyms]),
    }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map(({ m }) => ({
      key: m.key,
      label: m.label,
      definition: m.businessDefinition,
      synonyms: m.synonyms,
    }));
  const dimensions = catalog.dimensions
    .map((d) => ({
      d,
      s: score([d.key.replaceAll(/[._]/g, ' '), d.name, d.description, ...d.synonyms]),
    }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map(({ d }) => ({ key: d.key, name: d.name, type: d.type, synonyms: d.synonyms }));
  return { metrics, dimensions };
}

/** Compact catalog for the system prompt (metadata only, never table data). */
export function catalogForPrompt(catalog: Catalog) {
  return {
    metrics: catalog.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      definition: m.businessDefinition,
      unit: m.unit,
      time_dimension: m.timeDimension,
      synonyms: m.synonyms,
    })),
    dimensions: catalog.dimensions.map((d) => ({
      key: d.key,
      name: d.name,
      type: d.type,
      ...(d.type === 'TIME' ? { granularities: d.granularities } : {}),
      synonyms: d.synonyms,
    })),
  };
}

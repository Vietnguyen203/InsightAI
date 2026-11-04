import {
  createRuleRequestSchema,
  type DatasetColumn,
  type QualityRule,
  type Severity,
} from '@insightai/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { orgKey, useActiveOrganization } from '../organizations/use-organization';
import { datasetsApi } from '../datasets/datasets-api';
import { qualityApi } from './quality-api';

/** Rule types users can create (duplicate rows and type conversion are system rules). */
const USER_TYPES = [
  'not_null',
  'unique',
  'regex',
  'allowed_values',
  'range',
  'length',
  'expression',
  'foreign_key',
] as const;
type UserType = (typeof USER_TYPES)[number];

interface Draft {
  name: string;
  type: UserType;
  column: string;
  columns: string[];
  pattern: string;
  values: string;
  caseSensitive: boolean;
  min: string;
  max: string;
  expr: string;
  refDatasetId: string;
  refColumn: string;
  severity: Severity;
  weight: string;
  /** Percentage 0–100 in the form; the API takes 0–1. */
  threshold: string;
}

function draftFrom(rule: QualityRule | null, firstColumn: string): Draft {
  const d = rule?.definition;
  const base: Draft = {
    name: rule?.name ?? '',
    type:
      d && (USER_TYPES as readonly string[]).includes(d.type) ? (d.type as UserType) : 'not_null',
    column: firstColumn,
    columns: [firstColumn],
    pattern: '',
    values: '',
    caseSensitive: true,
    min: '',
    max: '',
    expr: '',
    refDatasetId: '',
    refColumn: '',
    severity: rule?.severity ?? 'warning',
    weight: String(rule?.weight ?? 1),
    threshold: String(Math.round((rule?.threshold ?? 1) * 10000) / 100),
  };
  if (!d) return base;
  if ('column' in d) base.column = d.column;
  switch (d.type) {
    case 'unique':
      base.columns = d.columns;
      break;
    case 'regex':
      base.pattern = d.pattern;
      break;
    case 'allowed_values':
      base.values = d.values.join('\n');
      base.caseSensitive = d.caseSensitive;
      break;
    case 'range':
      base.min = d.min ?? '';
      base.max = d.max ?? '';
      break;
    case 'length':
      base.min = d.min === undefined ? '' : String(d.min);
      base.max = d.max === undefined ? '' : String(d.max);
      break;
    case 'expression':
      base.expr = d.expr;
      break;
    case 'foreign_key':
      base.refDatasetId = d.refDatasetId;
      base.refColumn = d.refColumn;
      break;
    default:
      break;
  }
  return base;
}

function definitionOf(draft: Draft): unknown {
  const opt = (v: string) => (v.trim() === '' ? undefined : v.trim());
  const int = (v: string) => (v.trim() === '' ? undefined : Number(v));
  switch (draft.type) {
    case 'not_null':
      return { type: 'not_null', column: draft.column };
    case 'unique':
      return { type: 'unique', columns: draft.columns };
    case 'regex':
      return { type: 'regex', column: draft.column, pattern: draft.pattern };
    case 'allowed_values':
      return {
        type: 'allowed_values',
        column: draft.column,
        values: draft.values
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean),
        caseSensitive: draft.caseSensitive,
      };
    case 'range':
      return { type: 'range', column: draft.column, min: opt(draft.min), max: opt(draft.max) };
    case 'length':
      return { type: 'length', column: draft.column, min: int(draft.min), max: int(draft.max) };
    case 'expression':
      return { type: 'expression', expr: draft.expr };
    case 'foreign_key':
      return {
        type: 'foreign_key',
        column: draft.column,
        refDatasetId: draft.refDatasetId,
        refColumn: draft.refColumn,
      };
  }
}

/**
 * Create or edit a rule. System rules keep their definition: only name, severity, weight and
 * threshold can change.
 */
export function RuleEditor({
  datasetId,
  columns,
  rule,
  onDone,
  onCancel,
}: {
  datasetId: string;
  columns: DatasetColumn[];
  rule: QualityRule | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(rule, columns[0]?.name ?? ''));
  const [formError, setFormError] = useState<string | null>(null);
  const isSystem = rule?.origin === 'system';
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof createRuleRequestSchema.parse>) =>
      rule
        ? qualityApi.updateRule(
            rule.id,
            isSystem
              ? {
                  name: body.name,
                  severity: body.severity,
                  weight: body.weight,
                  threshold: body.threshold,
                }
              : body,
          )
        : qualityApi.createRule(datasetId, body),
    onSuccess: onDone,
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const parsed = createRuleRequestSchema.safeParse({
      name: draft.name,
      definition: isSystem ? rule.definition : definitionOf(draft),
      severity: draft.severity,
      weight: Number(draft.weight),
      threshold: Number(draft.threshold.replace(',', '.')) / 100,
      enabled: rule?.enabled ?? true,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setFormError(
        issue ? `${issue.path.join('.') || t('quality.editor.rule')}: ${issue.message}` : null,
      );
      return;
    }
    save.mutate(parsed.data);
  };

  const columnSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <Field label={label}>
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} ({t(`datasets.types.${c.dataType}`)})
          </option>
        ))}
      </NativeSelect>
    </Field>
  );

  return (
    <form
      onSubmit={submit}
      className="bg-card space-y-4 rounded-xl border p-4"
      aria-label={rule ? t('quality.editor.editTitle') : t('quality.editor.newTitle')}
    >
      <h3 className="font-medium">
        {rule ? t('quality.editor.editTitle') : t('quality.editor.newTitle')}
      </h3>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('quality.editor.name')}>
          <Input value={draft.name} onChange={(e) => set('name', e.target.value)} maxLength={120} />
        </Field>
        {!isSystem && (
          <Field label={t('quality.editor.type')} hint={t(`quality.ruleHint.${draft.type}`)}>
            <NativeSelect
              value={draft.type}
              onChange={(e) => set('type', e.target.value as UserType)}
            >
              {USER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`quality.ruleType.${type}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
      </div>

      {!isSystem && (
        <div className="grid gap-4 md:grid-cols-2">
          {draft.type === 'unique' ? (
            <fieldset className="grid gap-1.5 md:col-span-2">
              <legend className="mb-1.5 text-sm font-medium">
                {t('quality.editor.keyColumns')}
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {columns.map((c) => (
                  <label key={c.name} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.columns.includes(c.name)}
                      onChange={(e) =>
                        set(
                          'columns',
                          e.target.checked
                            ? [...draft.columns, c.name]
                            : draft.columns.filter((n) => n !== c.name),
                        )
                      }
                    />
                    <span className="font-mono text-xs">{c.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : draft.type === 'expression' ? (
            <div className="md:col-span-2">
              <ExpressionField
                datasetId={datasetId}
                value={draft.expr}
                onChange={(v) => set('expr', v)}
              />
            </div>
          ) : (
            columnSelect(draft.column, (v) => set('column', v), t('quality.editor.column'))
          )}

          {draft.type === 'regex' && (
            <Field label={t('quality.editor.pattern')} hint={t('quality.editor.patternHint')}>
              <Input
                className="font-mono"
                value={draft.pattern}
                onChange={(e) => set('pattern', e.target.value)}
                placeholder="^DH[0-9]+$"
              />
            </Field>
          )}
          {draft.type === 'allowed_values' && (
            <div className="grid gap-2">
              <Field label={t('quality.editor.values')} hint={t('quality.editor.valuesHint')}>
                <textarea
                  className="border-input bg-background min-h-24 rounded-md border px-3 py-2 text-sm"
                  value={draft.values}
                  onChange={(e) => set('values', e.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.caseSensitive}
                  onChange={(e) => set('caseSensitive', e.target.checked)}
                />
                {t('quality.editor.caseSensitive')}
              </label>
            </div>
          )}
          {(draft.type === 'range' || draft.type === 'length') && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('quality.editor.min')}>
                <Input
                  inputMode={draft.type === 'length' ? 'numeric' : undefined}
                  value={draft.min}
                  onChange={(e) => set('min', e.target.value)}
                />
              </Field>
              <Field label={t('quality.editor.max')}>
                <Input
                  inputMode={draft.type === 'length' ? 'numeric' : undefined}
                  value={draft.max}
                  onChange={(e) => set('max', e.target.value)}
                />
              </Field>
              <p className="text-muted-foreground col-span-2 text-xs">
                {t(
                  draft.type === 'range' ? 'quality.editor.rangeHint' : 'quality.editor.lengthHint',
                )}
              </p>
            </div>
          )}
          {draft.type === 'foreign_key' && (
            <ForeignKeyFields
              datasetId={datasetId}
              refDatasetId={draft.refDatasetId}
              refColumn={draft.refColumn}
              onChange={(refDatasetId, refColumn) =>
                setDraft((current) => ({ ...current, refDatasetId, refColumn }))
              }
            />
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('quality.editor.severity')}>
          <NativeSelect
            value={draft.severity}
            onChange={(e) => set('severity', e.target.value as Severity)}
          >
            {(['info', 'warning', 'error'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`quality.severity.${s}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('quality.editor.weight')} hint={t('quality.editor.weightHint')}>
          <Input
            type="number"
            min={1}
            max={10}
            value={draft.weight}
            onChange={(e) => set('weight', e.target.value)}
          />
        </Field>
        <Field label={t('quality.editor.threshold')} hint={t('quality.editor.thresholdHint')}>
          <Input
            inputMode="decimal"
            value={draft.threshold}
            onChange={(e) => set('threshold', e.target.value)}
          />
        </Field>
      </div>

      {(formError || save.isError) && (
        <Alert variant="destructive">{formError ?? errorMessage(t, save.error)}</Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** Expression input validated live against the dataset columns. */
function ExpressionField({
  datasetId,
  value,
  onChange,
}: {
  datasetId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), 400);
    return () => clearTimeout(timer);
  }, [value]);
  const validation = useQuery({
    queryKey: orgKey(organizationId, 'dataset', datasetId, 'expression', debounced),
    queryFn: () => qualityApi.validateExpression(datasetId, debounced),
    enabled: debounced.trim() !== '',
    staleTime: Infinity,
  });
  const result = validation.data;
  const status = !debounced.trim()
    ? undefined
    : result?.valid
      ? result.type === 'boolean'
        ? t('quality.editor.exprValid', { columns: (result.columns ?? []).join(', ') })
        : undefined
      : undefined;
  const error =
    result && !result.valid
      ? result.error?.position !== undefined
        ? t('quality.editor.exprErrorAt', {
            message: result.error.message,
            position: result.error.position + 1,
          })
        : result.error?.message
      : result?.valid && result.type !== 'boolean'
        ? t('quality.editor.exprNotBoolean', { type: result.type })
        : undefined;

  return (
    <Field
      label={t('quality.editor.expression')}
      hint={status ?? t('quality.editor.exprHint')}
      error={error}
    >
      <textarea
        className="border-input bg-background min-h-20 rounded-md border px-3 py-2 font-mono text-sm"
        value={value}
        spellCheck={false}
        placeholder="thanh_tien = so_luong * don_gia"
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function ForeignKeyFields({
  datasetId,
  refDatasetId,
  refColumn,
  onChange,
}: {
  datasetId: string;
  refDatasetId: string;
  refColumn: string;
  onChange: (refDatasetId: string, refColumn: string) => void;
}) {
  const { t } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const datasets = useQuery({
    queryKey: orgKey(organizationId, 'datasets'),
    queryFn: datasetsApi.list,
  });
  const target = useQuery({
    queryKey: orgKey(organizationId, 'dataset', refDatasetId),
    queryFn: () => datasetsApi.get(refDatasetId),
    enabled: refDatasetId !== '',
  });
  const others = (datasets.data ?? []).filter((d) => d.id !== datasetId && d.activeVersion);

  return (
    <>
      <Field label={t('quality.editor.refDataset')}>
        <NativeSelect value={refDatasetId} onChange={(e) => onChange(e.target.value, '')}>
          <option value="">{t('quality.editor.choose')}</option>
          {others.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t('quality.editor.refColumn')}>
        <NativeSelect
          value={refColumn}
          disabled={!target.data}
          onChange={(e) => onChange(refDatasetId, e.target.value)}
        >
          <option value="">{t('quality.editor.choose')}</option>
          {(target.data?.columns ?? []).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </>
  );
}

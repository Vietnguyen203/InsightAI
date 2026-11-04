import {
  createMetricVersionRequestSchema,
  FILTER_OPERATORS,
  type Metric,
  type MetricDefinitionInput,
  type MetricVersion,
  type SemanticModelDetail,
  SEMANTIC_KEY_PATTERN,
} from '@insightai/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';

type Op = (typeof FILTER_OPERATORS)[number];
interface FilterDraft {
  member: string;
  op: Op;
  values: string;
}

export interface MetricFormValue {
  key?: string;
  label: string;
  businessDefinition: string | null;
  unit: string | null;
  format: 'number' | 'currency' | 'percent';
  definition: MetricDefinitionInput;
}

/** Values typed as text: numbers and booleans are converted for the IR. */
const parseValues = (text: string, op: Op) => {
  if (op === 'is_null' || op === 'not_null') return undefined;
  const parts =
    op === 'in' || op === 'not_in' ? text.split(',').map((v) => v.trim()) : [text.trim()];
  return parts.filter((v) => v !== '');
};

/**
 * Form for a metric draft: label and presentation, then the definition by type. Members come from
 * the model draft (measures, dimensions) and the other metrics (ratio/derived).
 */
export function MetricEditor({
  model,
  metrics,
  initial,
  withKey,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  model: SemanticModelDetail;
  metrics: Metric[];
  initial: MetricVersion | null;
  withKey: boolean;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (value: MetricFormValue) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const def = initial?.definition;
  const [key, setKey] = useState('');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [businessDefinition, setBusinessDefinition] = useState(initial?.businessDefinition ?? '');
  const [unit, setUnit] = useState(initial?.unit ?? '');
  const [format, setFormat] = useState<MetricFormValue['format']>(initial?.format ?? 'number');
  const [type, setType] = useState<'SIMPLE' | 'RATIO' | 'DERIVED'>(def?.type ?? 'SIMPLE');
  const [measure, setMeasure] = useState(def?.type === 'SIMPLE' ? def.measure : '');
  const [timeDimension, setTimeDimension] = useState(
    def?.type === 'SIMPLE' ? (def.timeDimension ?? '') : '',
  );
  const [filters, setFilters] = useState<FilterDraft[]>(
    def?.type === 'SIMPLE'
      ? def.filters.map((f) => ({
          member: f.member,
          op: f.op,
          values: (f.values ?? []).join(', '),
        }))
      : [],
  );
  const [numerator, setNumerator] = useState(def?.type === 'RATIO' ? def.numerator : '');
  const [denominator, setDenominator] = useState(def?.type === 'RATIO' ? def.denominator : '');
  const [expr, setExpr] = useState(def?.type === 'DERIVED' ? def.expr : '');
  const [formError, setFormError] = useState<string | null>(null);

  const measures = model.entities.flatMap((e) =>
    e.measures.map((m) => ({ ref: `${e.key}.${m.key}`, name: `${e.name} · ${m.name}` })),
  );
  const dimensions = model.entities.flatMap((e) =>
    e.dimensions.map((d) => ({
      ref: `${e.key}.${d.key}`,
      name: `${e.name} · ${d.name}`,
      time: d.type === 'TIME',
    })),
  );
  const otherMetrics = metrics.filter((m) => m.key !== key);

  const definition = (): MetricDefinitionInput => {
    switch (type) {
      case 'SIMPLE':
        return {
          type,
          measure,
          filters: filters.map((f) => ({
            member: f.member,
            op: f.op,
            values: parseValues(f.values, f.op),
          })),
          timeDimension: timeDimension || null,
        };
      case 'RATIO':
        return { type, numerator, denominator };
      case 'DERIVED':
        return { type, expr };
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (withKey && !SEMANTIC_KEY_PATTERN.test(key)) {
      setFormError(t('semantic.keyInvalid'));
      return;
    }
    const value = {
      label,
      businessDefinition: businessDefinition.trim() || null,
      unit: unit.trim() || null,
      format,
      definition: definition(),
    };
    const parsed = createMetricVersionRequestSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setFormError(issue ? `${issue.path.join('.')}: ${issue.message}` : null);
      return;
    }
    onSubmit(withKey ? { ...value, key } : value);
  };

  return (
    <form
      onSubmit={submit}
      className="bg-card space-y-4 rounded-xl border p-4"
      aria-label={submitLabel}
    >
      <div className="grid gap-4 md:grid-cols-2">
        {withKey && (
          <Field label={t('semantic.key')} hint={t('semantic.metricKeyHint')}>
            <Input
              className="font-mono"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="total_revenue"
            />
          </Field>
        )}
        <Field label={t('semantic.metricLabel')}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <div className="md:col-span-2">
          <Field
            label={t('semantic.businessDefinition')}
            hint={t('semantic.businessDefinitionHint')}
          >
            <textarea
              className="border-input bg-background min-h-16 w-full rounded-md border px-3 py-2 text-sm"
              value={businessDefinition}
              onChange={(e) => setBusinessDefinition(e.target.value)}
            />
          </Field>
        </div>
        <Field label={t('semantic.unit')}>
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="VND" />
        </Field>
        <Field label={t('semantic.format')}>
          <NativeSelect
            value={format}
            onChange={(e) => setFormat(e.target.value as MetricFormValue['format'])}
          >
            {(['number', 'currency', 'percent'] as const).map((f) => (
              <option key={f} value={f}>
                {t(`semantic.formats.${f}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('semantic.metricType')} hint={t(`semantic.metricTypeHint.${type}`)}>
          <NativeSelect value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {(['SIMPLE', 'RATIO', 'DERIVED'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`semantic.metricTypes.${k}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      {type === 'SIMPLE' && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('semantic.measure')}>
              <NativeSelect value={measure} onChange={(e) => setMeasure(e.target.value)}>
                <option value="">{t('semantic.choose')}</option>
                {measures.map((m) => (
                  <option key={m.ref} value={m.ref}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('semantic.defaultTime')}>
              <NativeSelect
                value={timeDimension}
                onChange={(e) => setTimeDimension(e.target.value)}
              >
                <option value="">{t('semantic.none')}</option>
                {dimensions
                  .filter((d) => d.time)
                  .map((d) => (
                    <option key={d.ref} value={d.ref}>
                      {d.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('semantic.metricFilters')}</legend>
            {filters.map((f, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_9rem_1fr_auto]">
                <NativeSelect
                  aria-label={t('semantic.filterMember')}
                  value={f.member}
                  onChange={(e) =>
                    setFilters(
                      filters.map((x, j) => (j === i ? { ...x, member: e.target.value } : x)),
                    )
                  }
                >
                  <option value="">{t('semantic.choose')}</option>
                  {dimensions.map((d) => (
                    <option key={d.ref} value={d.ref}>
                      {d.name}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label={t('semantic.filterOp')}
                  value={f.op}
                  onChange={(e) =>
                    setFilters(
                      filters.map((x, j) => (j === i ? { ...x, op: e.target.value as Op } : x)),
                    )
                  }
                >
                  {FILTER_OPERATORS.map((op) => (
                    <option key={op} value={op}>
                      {t(`semantic.ops.${op}`)}
                    </option>
                  ))}
                </NativeSelect>
                <Input
                  aria-label={t('semantic.filterValue')}
                  value={f.values}
                  disabled={f.op === 'is_null' || f.op === 'not_null'}
                  placeholder={f.op === 'in' || f.op === 'not_in' ? 'A, B' : ''}
                  onChange={(e) =>
                    setFilters(
                      filters.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-destructive"
                  aria-label={t('semantic.removeFilter')}
                  onClick={() => setFilters(filters.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setFilters([...filters, { member: '', op: 'eq', values: '' }])}
            >
              <Plus />
              {t('semantic.addFilter')}
            </Button>
          </fieldset>
        </div>
      )}
      {type === 'RATIO' && (
        <div className="grid gap-4 md:grid-cols-2">
          {(
            [
              ['numerator', numerator, setNumerator],
              ['denominator', denominator, setDenominator],
            ] as const
          ).map(([field, value, set]) => (
            <Field key={field} label={t(`semantic.${field}`)}>
              <NativeSelect value={value} onChange={(e) => set(e.target.value)}>
                <option value="">{t('semantic.choose')}</option>
                {otherMetrics.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.published?.label ?? m.draft?.label ?? m.key} ({m.key})
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ))}
        </div>
      )}
      {type === 'DERIVED' && (
        <Field
          label={t('semantic.derivedExpr')}
          hint={t('semantic.derivedHint', {
            keys: otherMetrics.map((m) => m.key).join(', ') || '—',
          })}
        >
          <Input
            className="font-mono"
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            placeholder="revenue - cost"
          />
        </Field>
      )}

      {(formError || error) && <Alert variant="destructive">{formError ?? error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

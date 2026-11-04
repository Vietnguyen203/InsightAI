import {
  type CleaningOperationInput,
  cleaningOperationSchema,
  type ColumnDataType,
  DATE_FORMATS,
  type DateFormat,
  type QualityRule,
} from '@insightai/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { describeRule } from './describe';
import type { StepColumn } from './step-columns';

const OPERATION_TYPES = [
  'trim_whitespace',
  'change_case',
  'replace_values',
  'fill_null',
  'cast_column',
  'parse_date',
  'drop_rows',
  'deduplicate',
  'rename_column',
  'drop_column',
] as const;
type OperationType = (typeof OPERATION_TYPES)[number];

const TYPES: ColumnDataType[] = ['TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'TIMESTAMP'];
const ROW_RULE_TYPES = new Set([
  'not_null',
  'regex',
  'allowed_values',
  'range',
  'length',
  'expression',
  'type_castable',
]);

interface Draft {
  type: OperationType;
  column: string;
  columns: string[];
  collapseInner: boolean;
  mode: 'lower' | 'upper' | 'title';
  mapping: string;
  caseSensitive: boolean;
  strategy: 'constant' | 'mean' | 'median' | 'mode' | 'previous';
  value: string;
  targetType: ColumnDataType;
  locale: '' | 'vi' | 'en';
  formats: DateFormat[];
  dropBy: 'condition' | 'rule';
  condition: string;
  ruleId: string;
  keep: 'first' | 'last';
  newName: string;
}

/** "from => to" per line; an empty right side clears the value. */
function parseMapping(text: string) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [from = '', ...rest] = line.split('=>');
      const to = rest.join('=>').trim();
      return { from: from.trim(), to: to === '' ? null : to };
    });
}

function operationOf(draft: Draft): unknown {
  switch (draft.type) {
    case 'trim_whitespace':
      return { type: draft.type, columns: draft.columns, collapseInner: draft.collapseInner };
    case 'change_case':
      return { type: draft.type, columns: draft.columns, mode: draft.mode };
    case 'replace_values':
      return {
        type: draft.type,
        column: draft.column,
        mapping: parseMapping(draft.mapping),
        caseSensitive: draft.caseSensitive,
      };
    case 'fill_null':
      return {
        type: draft.type,
        column: draft.column,
        strategy: draft.strategy,
        ...(draft.strategy === 'constant' ? { value: draft.value } : {}),
      };
    case 'cast_column':
      return {
        type: draft.type,
        column: draft.column,
        targetType: draft.targetType,
        ...(draft.locale ? { locale: draft.locale } : {}),
      };
    case 'parse_date':
      return { type: draft.type, column: draft.column, formats: draft.formats };
    case 'drop_rows':
      return draft.dropBy === 'condition'
        ? { type: draft.type, condition: draft.condition }
        : { type: draft.type, ruleId: draft.ruleId };
    case 'deduplicate':
      return { type: draft.type, keyColumns: draft.columns, keep: draft.keep };
    case 'rename_column':
      return { type: draft.type, column: draft.column, newName: draft.newName };
    case 'drop_column':
      return { type: draft.type, column: draft.column };
  }
}

/** Form for one cleaning operation, against the columns as they are at that step. */
export function OperationEditor({
  columns,
  rules,
  onAdd,
  onCancel,
}: {
  columns: StepColumn[];
  rules: QualityRule[];
  onAdd: (operation: CleaningOperationInput) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const first = columns[0]?.name ?? '';
  const [draft, setDraft] = useState<Draft>({
    type: 'trim_whitespace',
    column: first,
    columns: [],
    collapseInner: false,
    mode: 'lower',
    mapping: '',
    caseSensitive: true,
    strategy: 'constant',
    value: '',
    targetType: 'TEXT',
    locale: '',
    formats: ['dd/MM/yyyy'],
    dropBy: 'condition',
    condition: '',
    ruleId: '',
    keep: 'first',
    newName: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const textOnly =
    draft.type === 'trim_whitespace' ||
    draft.type === 'change_case' ||
    draft.type === 'replace_values';
  const available = textOnly ? columns.filter((c) => c.dataType === 'TEXT') : columns;
  const rowRules = rules.filter((r) => ROW_RULE_TYPES.has(r.definition.type));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = cleaningOperationSchema.safeParse(operationOf(draft));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(
        issue ? `${issue.path.join('.') || t('cleaning.operation')}: ${issue.message}` : null,
      );
      return;
    }
    onAdd(operationOf(draft) as CleaningOperationInput);
  };

  const column = (label = t('cleaning.editor.column')) => (
    <Field label={label}>
      <NativeSelect value={draft.column} onChange={(e) => set('column', e.target.value)}>
        {available.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} ({t(`datasets.types.${c.dataType}`)})
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
  const columnChecks = (legend: string) => (
    <fieldset className="md:col-span-2">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {available.map((c) => (
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
  );

  return (
    <form
      onSubmit={submit}
      className="bg-card space-y-4 rounded-xl border p-4"
      aria-label={t('cleaning.addOperation')}
    >
      <Field label={t('cleaning.editor.type')} hint={t(`cleaning.opHint.${draft.type}`)}>
        <NativeSelect
          value={draft.type}
          onChange={(e) => {
            const type = e.target.value as OperationType;
            const text =
              type === 'trim_whitespace' || type === 'change_case' || type === 'replace_values';
            const pool = text ? columns.filter((c) => c.dataType === 'TEXT') : columns;
            setDraft((current) => ({
              ...current,
              type,
              columns: [],
              column: pool.some((c) => c.name === current.column)
                ? current.column
                : (pool[0]?.name ?? ''),
            }));
            setError(null);
          }}
        >
          {OPERATION_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`cleaning.opType.${type}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>

      {textOnly && available.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('cleaning.editor.noTextColumns')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {draft.type === 'trim_whitespace' && (
            <>
              {columnChecks(t('cleaning.editor.columns'))}
              <label className="flex items-center gap-2 text-sm md:col-span-2">
                <input
                  type="checkbox"
                  checked={draft.collapseInner}
                  onChange={(e) => set('collapseInner', e.target.checked)}
                />
                {t('cleaning.editor.collapseInner')}
              </label>
            </>
          )}
          {draft.type === 'change_case' && (
            <>
              {columnChecks(t('cleaning.editor.columns'))}
              <Field label={t('cleaning.editor.mode')}>
                <NativeSelect
                  value={draft.mode}
                  onChange={(e) => set('mode', e.target.value as Draft['mode'])}
                >
                  {(['lower', 'upper', 'title'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`cleaning.caseMode.${m}`)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </>
          )}
          {draft.type === 'replace_values' && (
            <>
              {column()}
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.caseSensitive}
                  onChange={(e) => set('caseSensitive', e.target.checked)}
                />
                {t('cleaning.editor.caseSensitive')}
              </label>
              <div className="md:col-span-2">
                <Field label={t('cleaning.editor.mapping')} hint={t('cleaning.editor.mappingHint')}>
                  <textarea
                    className="border-input bg-background min-h-24 rounded-md border px-3 py-2 font-mono text-sm"
                    value={draft.mapping}
                    placeholder={'HN => Hà Nội\nHa Noi => Hà Nội'}
                    onChange={(e) => set('mapping', e.target.value)}
                  />
                </Field>
              </div>
            </>
          )}
          {draft.type === 'fill_null' && (
            <>
              {column()}
              <Field label={t('cleaning.editor.strategy')}>
                <NativeSelect
                  value={draft.strategy}
                  onChange={(e) => set('strategy', e.target.value as Draft['strategy'])}
                >
                  {(['constant', 'mean', 'median', 'mode', 'previous'] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`cleaning.fillStrategy.${s}`)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {draft.strategy === 'constant' && (
                <Field label={t('cleaning.editor.value')} hint={t('cleaning.editor.valueHint')}>
                  <Input value={draft.value} onChange={(e) => set('value', e.target.value)} />
                </Field>
              )}
            </>
          )}
          {draft.type === 'cast_column' && (
            <>
              {column()}
              <Field label={t('cleaning.editor.targetType')}>
                <NativeSelect
                  value={draft.targetType}
                  onChange={(e) => set('targetType', e.target.value as ColumnDataType)}
                >
                  {TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`datasets.types.${type}`)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label={t('cleaning.editor.locale')} hint={t('cleaning.editor.localeHint')}>
                <NativeSelect
                  value={draft.locale}
                  onChange={(e) => set('locale', e.target.value as Draft['locale'])}
                >
                  <option value="">{t('cleaning.editor.localeDefault')}</option>
                  <option value="vi">1.234,5 · dd/MM/yyyy</option>
                  <option value="en">1,234.5 · MM/dd/yyyy</option>
                </NativeSelect>
              </Field>
            </>
          )}
          {draft.type === 'parse_date' && (
            <>
              {column()}
              <fieldset className="md:col-span-2">
                <legend className="mb-1.5 text-sm font-medium">
                  {t('cleaning.editor.formats')}
                </legend>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {DATE_FORMATS.map((f) => (
                    <label key={f} className="flex items-center gap-2 font-mono text-xs">
                      <input
                        type="checkbox"
                        checked={draft.formats.includes(f)}
                        onChange={(e) =>
                          set(
                            'formats',
                            e.target.checked
                              ? [...draft.formats, f]
                              : draft.formats.filter((x) => x !== f),
                          )
                        }
                      />
                      {f}
                    </label>
                  ))}
                </div>
                <p className="text-muted-foreground mt-1.5 text-xs">
                  {t('cleaning.editor.formatsHint')}
                </p>
              </fieldset>
            </>
          )}
          {draft.type === 'drop_rows' && (
            <>
              <Field label={t('cleaning.editor.dropBy')}>
                <NativeSelect
                  value={draft.dropBy}
                  onChange={(e) => set('dropBy', e.target.value as Draft['dropBy'])}
                >
                  <option value="condition">{t('cleaning.editor.byCondition')}</option>
                  <option value="rule" disabled={rowRules.length === 0}>
                    {t('cleaning.editor.byRule')}
                  </option>
                </NativeSelect>
              </Field>
              {draft.dropBy === 'condition' ? (
                <div className="md:col-span-2">
                  <Field
                    label={t('cleaning.editor.condition')}
                    hint={t('cleaning.editor.conditionHint')}
                  >
                    <Input
                      className="font-mono"
                      value={draft.condition}
                      placeholder="so_luong < 0"
                      onChange={(e) => set('condition', e.target.value)}
                    />
                  </Field>
                </div>
              ) : (
                <Field label={t('cleaning.editor.rule')}>
                  <NativeSelect
                    value={draft.ruleId}
                    onChange={(e) => set('ruleId', e.target.value)}
                  >
                    <option value="">{t('quality.editor.choose')}</option>
                    {rowRules.map((r) => (
                      <option key={r.id} value={r.id} title={describeRule(t, r.definition)}>
                        {r.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
            </>
          )}
          {draft.type === 'deduplicate' && (
            <>
              {columnChecks(t('cleaning.editor.keyColumns'))}
              <p className="text-muted-foreground -mt-2 text-xs md:col-span-2">
                {t('cleaning.editor.keyColumnsHint')}
              </p>
              <Field label={t('cleaning.editor.keep')}>
                <NativeSelect
                  value={draft.keep}
                  onChange={(e) => set('keep', e.target.value as Draft['keep'])}
                >
                  <option value="first">{t('cleaning.keep.first')}</option>
                  <option value="last">{t('cleaning.keep.last')}</option>
                </NativeSelect>
              </Field>
            </>
          )}
          {draft.type === 'rename_column' && (
            <>
              {column()}
              <Field label={t('cleaning.editor.newName')} hint={t('cleaning.editor.newNameHint')}>
                <Input
                  className="font-mono"
                  value={draft.newName}
                  onChange={(e) => set('newName', e.target.value)}
                />
              </Field>
            </>
          )}
          {draft.type === 'drop_column' && column()}
        </div>
      )}

      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={textOnly && available.length === 0}>
          {t('cleaning.addToRecipe')}
        </Button>
      </div>
    </form>
  );
}

import type {
  CleaningOperation,
  CleaningOperationInput,
  RuleDefinition,
} from '@insightai/contracts';
import type { TFunction } from 'i18next';

const list = (values: readonly string[], max = 5) =>
  values.length > max ? `${values.slice(0, max).join(', ')}, …` : values.join(', ');

/** One-line, human-readable description of a rule definition. */
export function describeRule(t: TFunction, definition: RuleDefinition): string {
  switch (definition.type) {
    case 'not_null':
    case 'type_castable':
      return t(`quality.ruleText.${definition.type}`, { column: definition.column });
    case 'unique':
      return t('quality.ruleText.unique', { columns: definition.columns.join(', ') });
    case 'duplicate_rows':
      return t('quality.ruleText.duplicate_rows');
    case 'regex':
      return t('quality.ruleText.regex', {
        column: definition.column,
        pattern: definition.pattern,
      });
    case 'allowed_values':
      return t('quality.ruleText.allowed_values', {
        column: definition.column,
        values: list(definition.values),
      });
    case 'range':
      return t('quality.ruleText.range', {
        column: definition.column,
        min: definition.min ?? '−∞',
        max: definition.max ?? '+∞',
      });
    case 'length':
      return t('quality.ruleText.length', {
        column: definition.column,
        min: definition.min ?? 0,
        max: definition.max ?? '∞',
      });
    case 'expression':
      return t('quality.ruleText.expression', { expr: definition.expr });
    case 'foreign_key':
      return t('quality.ruleText.foreign_key', {
        column: definition.column,
        refColumn: definition.refColumn,
      });
  }
}

/** One-line description of a cleaning operation (as entered or as stored). */
export function describeOperation(
  t: TFunction,
  op: CleaningOperation | CleaningOperationInput,
  /** Rule names by id, to name the rule used by drop_rows. */
  ruleNames?: ReadonlyMap<string, string>,
): string {
  switch (op.type) {
    case 'trim_whitespace':
      return t(op.collapseInner ? 'cleaning.opText.trim_collapse' : 'cleaning.opText.trim', {
        columns: list(op.columns),
      });
    case 'change_case':
      return t('cleaning.opText.change_case', {
        columns: list(op.columns),
        mode: t(`cleaning.caseMode.${op.mode}`),
      });
    case 'replace_values':
      return t('cleaning.opText.replace_values', {
        column: op.column,
        count: op.mapping.length,
        first: op.mapping[0] ? `"${op.mapping[0].from}" → "${op.mapping[0].to ?? '∅'}"` : '',
      });
    case 'fill_null':
      return t('cleaning.opText.fill_null', {
        column: op.column,
        strategy:
          op.strategy === 'constant'
            ? `"${op.value ?? ''}"`
            : t(`cleaning.fillStrategy.${op.strategy}`),
      });
    case 'cast_column':
      return t('cleaning.opText.cast_column', {
        column: op.column,
        type: t(`datasets.types.${op.targetType}`),
      });
    case 'parse_date':
      return t('cleaning.opText.parse_date', { column: op.column, formats: op.formats.join(', ') });
    case 'drop_rows':
      return op.condition !== undefined
        ? t('cleaning.opText.drop_rows_condition', { condition: op.condition })
        : op.ruleId && ruleNames?.has(op.ruleId)
          ? t('cleaning.opText.drop_rows_named', { rule: ruleNames.get(op.ruleId) })
          : t('cleaning.opText.drop_rows_rule');
    case 'deduplicate':
      return op.keyColumns && op.keyColumns.length > 0
        ? t('cleaning.opText.deduplicate_keys', {
            columns: list(op.keyColumns),
            keep: t(`cleaning.keep.${op.keep ?? 'first'}`),
          })
        : t('cleaning.opText.deduplicate_all', { keep: t(`cleaning.keep.${op.keep ?? 'first'}`) });
    case 'rename_column':
      return t('cleaning.opText.rename_column', { column: op.column, newName: op.newName });
    case 'drop_column':
      return t('cleaning.opText.drop_column', { column: op.column });
  }
}

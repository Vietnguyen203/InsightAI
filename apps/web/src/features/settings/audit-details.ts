import type { TFunction } from 'i18next';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fields whose values are system codes (not user data), shown translated. */
const CODED_FIELDS = new Set(['op', 'validationStatus', 'visibility', 'role', 'currentRole']);

/**
 * Audit details as readable text ("Tên: Bán hàng · Riêng tư → Cả tổ chức") instead of raw JSON:
 * internal ids are left out, known field names and system codes are translated, anything else
 * is shown as it is.
 */
export function describeChanges(changes: unknown, t: TFunction): string {
  const value = (v: unknown, coded = false): string => {
    if (Array.isArray(v)) return v.map((x) => value(x, coded)).join(', ');
    if (v !== null && typeof v === 'object') return `(${describeChanges(v, t)})`;
    const text = String(v);
    return coded ? t(`settings.audit.values.${text}`, { defaultValue: text }) : text;
  };
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    return value(changes);
  }
  const fields = Object.entries(changes as Record<string, unknown>).filter(
    ([key, v]) =>
      !/Ids?$/.test(key) &&
      !(typeof v === 'string' && UUID.test(v)) &&
      !(Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && UUID.test(x))),
  );
  const label = (key: string) => t(`settings.audit.fields.${key}`, { defaultValue: key });
  const map = new Map(fields);
  const parts: string[] = [];
  if (map.has('from') && map.has('to')) {
    // from/to carry visibility or role codes here (ids were left out above).
    parts.push(`${value(map.get('from'), true)} → ${value(map.get('to'), true)}`);
    map.delete('from');
    map.delete('to');
  }
  for (const [key, v] of map) parts.push(`${label(key)}: ${value(v, CODED_FIELDS.has(key))}`);
  return parts.join(' · ');
}

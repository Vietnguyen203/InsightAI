/** Maximum length of a normalized column name (well under PostgreSQL's 63-byte identifier limit). */
const MAX_NAME_LENGTH = 50;

export interface NamedColumn {
  ordinal: number;
  originalName: string;
  /** snake_case, ASCII, unique within the dataset version; what users and semantics refer to. */
  name: string;
  /** Data-plane identifier. Positional and server-generated: file content never becomes SQL. */
  physicalName: string;
}

/** "Doanh thu (VNĐ)" → "doanh_thu_vnd". */
export function normalizeColumnName(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/_+$/g, '');
}

/**
 * Assigns normalized, unique names. Empty or symbol-only headers become `column_<n>`;
 * names starting with a digit get a `c_` prefix; duplicates get `_2`, `_3`, ...
 */
export function nameColumns(headers: readonly string[]): NamedColumn[] {
  const used = new Set<string>();
  return headers.map((header, index) => {
    const ordinal = index + 1;
    let base = normalizeColumnName(header);
    if (base === '') base = `column_${ordinal}`;
    if (/^[0-9]/.test(base)) base = `c_${base}`;

    let name = base;
    for (let suffix = 2; used.has(name); suffix++) name = `${base}_${suffix}`;
    used.add(name);

    return { ordinal, originalName: header, name, physicalName: `c_${ordinal}` };
  });
}

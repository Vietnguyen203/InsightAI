const localeOf = (language: string) => (language === 'vi' ? 'vi-VN' : 'en-US');

export function formatDateTime(iso: string, language: string): string {
  return new Date(iso).toLocaleString(localeOf(language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatNumber(value: number, language: string): string {
  return value.toLocaleString(localeOf(language));
}

/**
 * Formats an exact decimal string from the API for display. Values beyond JS precision are
 * shown as-is rather than rounded through a float.
 */
export function formatDecimal(value: string, language: string, maximumFractionDigits = 6): string {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) >= Number.MAX_SAFE_INTEGER) return value;
  return number.toLocaleString(localeOf(language), { maximumFractionDigits });
}

export function formatPercent(ratio: number, language: string): string {
  return ratio.toLocaleString(localeOf(language), { style: 'percent', maximumFractionDigits: 1 });
}

export function formatBytes(bytes: number, language: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString(localeOf(language), { maximumFractionDigits: 1 })} ${units[unit]}`;
}

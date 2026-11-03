export function formatDateTime(iso: string, language: string): string {
  return new Date(iso).toLocaleString(language === 'vi' ? 'vi-VN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

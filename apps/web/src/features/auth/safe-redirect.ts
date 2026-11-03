/**
 * Only same-app paths are allowed as post-login destinations (prevents open redirects such as
 * `?redirectTo=//evil.example`).
 */
export function safeRedirect(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  return value;
}

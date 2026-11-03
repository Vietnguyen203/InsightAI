import type { TFunction } from 'i18next';
import { ApiError } from './api-client';

/** User-facing message for any error thrown by apiFetch or the network. */
export function errorMessage(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.problem?.code;
    if (code && t(`errors.${code}`, { defaultValue: '' })) return t(`errors.${code}`);
    return error.problem?.detail ?? t('errors.INTERNAL_ERROR');
  }
  return t('errors.NETWORK');
}

/** Field errors returned by the server (RFC 7807 `errors[]`), keyed by field path. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !error.problem?.errors) return {};
  return Object.fromEntries(error.problem.errors.map((e) => [e.path, e.message]));
}

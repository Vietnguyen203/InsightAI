import {
  ORGANIZATION_HEADER,
  type ProblemDetails,
  problemDetailsSchema,
} from '@insightai/contracts';
import { ApiError } from './api-client';
import { getAccessToken, getActiveOrganizationId, refreshSession } from './session';

export interface UploadProgress {
  loaded: number;
  total: number;
}

function sendOnce(
  path: string,
  form: FormData,
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('Accept', 'application/json');
    const token = getAccessToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    const organizationId = getActiveOrganizationId();
    if (organizationId) xhr.setRequestHeader(ORGANIZATION_HEADER, organizationId);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.({ loaded: event.loaded, total: event.total });
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        body = undefined;
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new TypeError('Network error'));
    xhr.send(form);
  });
}

/**
 * Multipart upload with progress (fetch cannot report upload progress). Same auth behaviour as
 * apiFetch: bearer token + active organization, one refresh-and-retry on 401.
 */
export async function uploadForm<T>(
  path: string,
  form: FormData,
  onProgress?: (progress: UploadProgress) => void,
): Promise<T> {
  let response = await sendOnce(path, form, onProgress);
  if (response.status === 401 && getAccessToken() !== null && (await refreshSession())) {
    response = await sendOnce(path, form, onProgress);
  }
  if (response.status < 200 || response.status >= 300) {
    const parsed = problemDetailsSchema.safeParse(response.body);
    const problem: ProblemDetails | undefined = parsed.success ? parsed.data : undefined;
    throw new ApiError(response.status, problem);
  }
  return response.body as T;
}

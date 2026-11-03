import { type HealthResponse, healthResponseSchema } from '@insightai/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export function useSystemHealth() {
  return useQuery({
    queryKey: ['system', 'health'],
    queryFn: async (): Promise<HealthResponse> => {
      // Readiness answers 503 with a valid body when a dependency is down.
      const body = await apiFetch<unknown>('/health/ready', {
        acceptStatuses: [503],
        organization: false,
      });
      return healthResponseSchema.parse(body);
    },
    refetchInterval: 30_000,
  });
}

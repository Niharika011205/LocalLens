import type { CategoryListResponse, FollowsResponse, FollowTarget, UnreadCountResponse } from '@locallens/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { api } from './client';

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => api<CategoryListResponse>('GET', '/categories'),
    staleTime: 60 * 60 * 1000, // fixed product configuration
  });
}

export function useFollows() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['follows'],
    queryFn: () => api<FollowsResponse>('GET', '/me/follows'),
    enabled: !!user,
  });
}

/** Follow/unfollow with the follows list and personalised feed refreshed afterwards. */
export function useToggleFollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id, follow }: { type: FollowTarget; id: string; follow: boolean }) =>
      api(follow ? 'PUT' : 'DELETE', `/me/follows/${type}/${id}`, follow ? {} : undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['follows'] });
      void qc.invalidateQueries({ queryKey: ['feed', 'mine'] });
    },
  });
}

/** Unread alerts for the nav badge; refreshed every minute while the app is open. */
export function useUnreadCount() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api<UnreadCountResponse>('GET', '/me/notifications/unread-count'),
    enabled: !!user,
    refetchInterval: 60_000,
  });
}

import { skipToken, useInfiniteQuery, useQueries, useQueryClient, type QueryClient, type QueryKey, type UseInfiniteQueryOptions, type UseQueryOptions } from '@tanstack/react-query';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback } from 'react';

/** Finite-read consumer policy. No options / inactive domain owner creates no observer or fake cache key.
 * Navigation blur only unsubscribes: shared consumers keep their transport; focus refresh coalesces.
 * Explicit retry cancels the exact key first, so a user's retry never waits out automatic backoff.
 */
export function useGatewayQuery<T, TKey extends QueryKey = QueryKey>(options: UseQueryOptions<T, Error, T, TKey> | typeof skipToken, active = true) {
  const focused = useIsFocused();
  const client = useQueryClient();
  const [query] = useQueries<UseQueryOptions<T, Error, T, TKey>[]>({
    queries: options === skipToken || !active ? [] : [options], subscribed: focused && active,
  });
  const { refresh, retry } = useGatewayReadControls(client, options === skipToken ? undefined : options.queryKey, query?.refetch);
  // Select only consumed fields; spreading a Query result touches every tracked getter.
  const fetchStatus = query?.fetchStatus ?? 'idle';
  return { data: query?.data, isSuccess: query?.isSuccess ?? false,
    isFetchedAfterMount: query?.isFetchedAfterMount ?? false, fetchStatus,
    error: fetchStatus === 'paused' ? null : query?.error ?? query?.failureReason ?? null,
    refresh, retry };
}

/** Infinite pages default to focused subscriptions; a resource may explicitly retain its mounted visit. */
export function useGatewayInfiniteQuery<TPage, TData, TKey extends QueryKey, TPageParam>(options: UseInfiniteQueryOptions<TPage, Error, TData, TKey, TPageParam> & { fetchAllPages?: boolean }) {
  const focused = useIsFocused();
  const client = useQueryClient();
  const query = useInfiniteQuery({ ...options, subscribed: options.subscribed ?? focused });
  const { refresh, retry } = useGatewayReadControls(client, options.queryKey, query.refetch, options.refetchOnWindowFocus !== false);
  // The SDK initially fetches one page; getNextPageParam advertises a cursor and
  // maxPages only bounds retention. Whole directories opt in through their options.
  const { hasNextPage, isFetching, error, fetchNextPage } = query;
  useFocusEffect(useCallback(() => {
    if (options.fetchAllPages && hasNextPage && !isFetching && !error) void fetchNextPage({ cancelRefetch: false });
  }, [options.fetchAllPages, hasNextPage, isFetching, error, fetchNextPage]));
  return { data: query.data, error: query.fetchStatus === 'paused' ? null : query.error ?? query.failureReason,
    hasNextPage: query.hasNextPage, isFetching: query.isFetching, fetchStatus: query.fetchStatus,
    fetchNextPage: query.fetchNextPage, refresh, retry };
}

function useGatewayReadControls(client: QueryClient, key: QueryKey | undefined, refetch: ((options?: { cancelRefetch?: boolean }) => Promise<unknown>) | undefined, refreshOnFocus = true) {
  const refresh = useCallback(async () => { await refetch?.({ cancelRefetch: false }); }, [refetch]);
  const retry = useCallback(async () => {
    if (!key || !refetch) return;
    await client.cancelQueries({ queryKey: key, exact: true });
    await refetch({ cancelRefetch: false });
  }, [client, key, refetch]);
  useFocusEffect(useCallback(() => { if (refreshOnFocus) void refresh(); }, [refresh, refreshOnFocus]));
  return { refresh, retry };
}

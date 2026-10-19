import { onScopeDispose, ref, shallowRef, watch } from "vue";

export interface PageParams {
  page: number;
  pageSize: number;
  search: string;
}
export interface PageResult<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export function useRemotePage<T>(
  fetchPage: (params: PageParams, signal: AbortSignal) => Promise<PageResult<T>>,
  pageSize = 20,
) {
  const rows = shallowRef<T[]>([]);
  const query = ref("");
  const page = ref(1);
  const total = ref(0);
  const hasMore = ref(false);
  const loading = ref(false);
  const failed = ref(false);
  let generation = 0;
  let disposed = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function invalidate() {
    generation++;
    controller?.abort();
    clearTimeout(timer);
    loading.value = false;
  }
  async function load(): Promise<void> {
    if (disposed) return;
    invalidate();
    const ticket = generation;
    controller = new AbortController();
    loading.value = true;
    failed.value = false;
    // Never show rows belonging to an older query or page while a new one loads.
    rows.value = [];
    try {
      const result = await fetchPage({ page: page.value, pageSize, search: query.value.trim() }, controller.signal);
      if (ticket !== generation) return;
      const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
      if (page.value > lastPage) {
        page.value = lastPage;
        await load();
        return;
      }
      rows.value = result.data;
      total.value = result.total;
      hasMore.value = result.hasMore;
    } catch {
      if (ticket === generation) failed.value = true;
    } finally {
      if (ticket === generation) loading.value = false;
    }
  }
  async function go(value: number) {
    page.value = Math.max(1, value);
    await load();
  }
  function reset() {
    invalidate();
    page.value = 1;
    rows.value = [];
    total.value = 0;
    hasMore.value = false;
    failed.value = false;
  }
  watch(query, () => {
    reset();
    timer = setTimeout(() => void load(), 200);
  }, { flush: "sync" });
  onScopeDispose(() => { disposed = true; invalidate(); });
  return { rows, query, page, total, hasMore, loading, failed, load, go, reset, invalidate };
}

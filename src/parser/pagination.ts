import type { TypeRef, Parameter, PaginationMeta } from '../ir/types.js';

const CURSOR_PARAMS = ['cursor', 'after', 'before', 'starting_after', 'ending_before', 'page_token', 'next_token'];

const OFFSET_PARAMS = ['offset', 'page', 'page_number', 'skip'];
const LIMIT_PARAMS = ['limit', 'page_size', 'per_page', 'size', 'count'];

/**
 * Detect if an operation uses pagination and return structured metadata
 * for auto-paging iterator generation.
 *
 * Supports three strategies:
 * 1. **Cursor-based**: query params include a cursor-like parameter
 * 2. **Offset-based**: query params include both an offset-like and limit-like parameter
 * 3. **Link-header**: the success response declares a `Link` header (GitHub's
 *    real spec pattern) and neither of the above query-param shapes applies
 *    -- e.g. an endpoint with only a `page` param and no `per_page`-like
 *    limit param, which the offset check alone would miss entirely.
 *
 * Returns null if no pagination pattern is detected.
 */
export function detectPagination(
  response: TypeRef,
  queryParams: Parameter[],
  dataPath?: string,
  hasLinkHeader = false,
): PaginationMeta | null {
  // Try cursor-based first (preferred). Scan in CURSOR_PARAMS priority order
  // rather than queryParams order so that an endpoint exposing both `before`
  // and `after` reports `after` (forward iteration) — matches the wire
  // convention where `after` advances through pages.
  const cursorParam = CURSOR_PARAMS.map((name) => queryParams.find((p) => p.name === name)).find(
    (p): p is Parameter => p !== undefined,
  );

  if (cursorParam) {
    const itemType: TypeRef = response.kind === 'array' ? response.items : response;
    return {
      strategy: 'cursor',
      param: cursorParam.name,
      dataPath: dataPath,
      itemType,
    };
  }

  // Try offset-based pagination
  const offsetParam = queryParams.find((p) => OFFSET_PARAMS.includes(p.name));
  const limitParam = queryParams.find((p) => LIMIT_PARAMS.includes(p.name));

  if (offsetParam && limitParam) {
    const itemType: TypeRef = response.kind === 'array' ? response.items : response;
    return {
      strategy: 'offset',
      param: offsetParam.name,
      limitParam: limitParam.name,
      dataPath: dataPath,
      itemType,
    };
  }

  // Link-header pagination: the response itself carries the next-page URL
  // (rel="next"), so no query param is required to iterate -- `param`
  // captures a page-establishing param if the spec happens to declare one
  // (informational only, e.g. for a first-page default; not read back by
  // the link-following algorithm itself). Requires a genuine array response
  // -- confirmed against GitHub's real spec that some specs declare a
  // shared response component with a `Link` header reused across BOTH list
  // and single-resource operations (e.g. a GET-by-id or PATCH sharing the
  // same response shape as its sibling LIST endpoint), which would
  // otherwise misdetect a non-list operation as paginated (22 false
  // positives on GitHub's real spec before this guard).
  if (hasLinkHeader && response.kind === 'array') {
    const pageParam = queryParams.find((p) => OFFSET_PARAMS.includes(p.name));
    return {
      strategy: 'link-header',
      param: pageParam?.name ?? '',
      dataPath: dataPath,
      itemType: response.items,
    };
  }

  return null;
}

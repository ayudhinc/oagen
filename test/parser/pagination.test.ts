import { describe, it, expect } from 'vitest';
import { detectPagination } from '../../src/parser/pagination.js';
import type { TypeRef, Parameter } from '../../src/ir/types.js';

describe('detectPagination', () => {
  const makeParam = (name: string): Parameter => ({
    name,
    type: { kind: 'primitive', type: 'string' },
    required: false,
  });

  it('returns true when cursor param present', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [makeParam('cursor')])).not.toBeNull();
  });

  it('returns true when after param present', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [makeParam('after')])).not.toBeNull();
  });

  it('returns true when before param present', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [makeParam('before')])).not.toBeNull();
  });

  it('returns true when starting_after param present', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [makeParam('starting_after')])).not.toBeNull();
  });

  it('returns false when no cursor param', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [makeParam('limit')])).toBeNull();
  });

  it('returns false with empty params', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [])).toBeNull();
  });

  it('returns structured PaginationMeta with strategy, param, dataPath, and itemType', () => {
    const result = detectPagination({ kind: 'array', items: { kind: 'model', name: 'User' } }, [
      { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
    ]);
    expect(result).toEqual({
      strategy: 'cursor',
      param: 'after',
      dataPath: undefined,
      itemType: { kind: 'model', name: 'User' },
    });
  });

  it('prefers `after` over `before` when both are present', () => {
    const result = detectPagination({ kind: 'array', items: { kind: 'model', name: 'Event' } }, [
      makeParam('before'),
      makeParam('after'),
    ]);
    expect(result?.param).toBe('after');
  });

  it('prefers `cursor` over `after`/`before` when present', () => {
    const result = detectPagination({ kind: 'array', items: { kind: 'model', name: 'Event' } }, [
      makeParam('before'),
      makeParam('after'),
      makeParam('cursor'),
    ]);
    expect(result?.param).toBe('cursor');
  });

  it('detects offset-based pagination with strategy and limitParam', () => {
    const result = detectPagination({ kind: 'array', items: { kind: 'model', name: 'Item' } }, [
      makeParam('offset'),
      makeParam('limit'),
    ]);
    expect(result).toEqual({
      strategy: 'offset',
      param: 'offset',
      limitParam: 'limit',
      dataPath: undefined,
      itemType: { kind: 'model', name: 'Item' },
    });
  });

  it('accepts custom dataPath from caller', () => {
    const result = detectPagination(
      { kind: 'array', items: { kind: 'model', name: 'Repo' } },
      [makeParam('after')],
      'results',
    );
    expect(result).toEqual({
      strategy: 'cursor',
      param: 'after',
      dataPath: 'results',
      itemType: { kind: 'model', name: 'Repo' },
    });
  });

  it('offset pagination uses custom dataPath', () => {
    const result = detectPagination(
      { kind: 'array', items: { kind: 'model', name: 'Item' } },
      [makeParam('page'), makeParam('per_page')],
      'items',
    );
    expect(result).toEqual({
      strategy: 'offset',
      param: 'page',
      limitParam: 'per_page',
      dataPath: 'items',
      itemType: { kind: 'model', name: 'Item' },
    });
  });

  it('dataPath propagates as undefined when not detected', () => {
    const result = detectPagination({ kind: 'array', items: { kind: 'primitive', type: 'string' } }, [
      makeParam('cursor'),
    ]);
    expect(result).not.toBeNull();
    expect(result!.dataPath).toBeUndefined();
  });

  describe('link-header pagination', () => {
    // Real GitHub pattern: some list endpoints declare only `page` (no
    // `per_page`/limit-like param), which the offset heuristic requires
    // both of -- these were previously undetected as paginated at all,
    // despite the response genuinely declaring a `Link` header for real
    // rel="next" paging.
    it('detects link-header pagination when the response has a Link header and no cursor/offset param shape applies', () => {
      const result = detectPagination(
        { kind: 'array', items: { kind: 'model', name: 'Task' } },
        [makeParam('page')],
        undefined,
        true,
      );
      expect(result).toEqual({
        strategy: 'link-header',
        param: 'page',
        dataPath: undefined,
        itemType: { kind: 'model', name: 'Task' },
      });
    });

    it('captures an empty param when no page-establishing query param is declared at all', () => {
      const result = detectPagination({ kind: 'array', items: { kind: 'model', name: 'Task' } }, [], undefined, true);
      expect(result?.param).toBe('');
    });

    it('prefers cursor detection over a Link header when both signals are present', () => {
      const result = detectPagination(
        { kind: 'array', items: { kind: 'model', name: 'Event' } },
        [makeParam('after')],
        undefined,
        true,
      );
      expect(result?.strategy).toBe('cursor');
    });

    it('prefers offset detection over a Link header when both signals are present', () => {
      const result = detectPagination(
        { kind: 'array', items: { kind: 'model', name: 'Item' } },
        [makeParam('page'), makeParam('per_page')],
        undefined,
        true,
      );
      expect(result?.strategy).toBe('offset');
    });

    it('returns null when there is no Link header and no cursor/offset shape (default hasLinkHeader=false)', () => {
      const result = detectPagination({ kind: 'array', items: { kind: 'model', name: 'Task' } }, [makeParam('page')]);
      expect(result).toBeNull();
    });

    it('does not detect link-header pagination on a non-array (single-resource) response, even with a Link header present', () => {
      // Real GitHub pattern: a shared response component with a Link header
      // reused across both a LIST operation and a sibling single-resource
      // GET/PATCH -- without this guard, the single-resource operation was
      // wrongly flagged as paginated too (22 false positives on GitHub's
      // real spec before this guard).
      const result = detectPagination({ kind: 'model', name: 'Team' }, [], undefined, true);
      expect(result).toBeNull();
    });
  });
});

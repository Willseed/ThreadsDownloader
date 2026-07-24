import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createApiError,
  type ApiError,
  type ApiErrorCode,
  type HealthResponse,
} from '../src/index.js';

describe('contracts', () => {
  it('creates the stable API error envelope', () => {
    expect(createApiError('NOT_FOUND', '找不到請求的 API 路徑。', 'request-1')).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: '找不到請求的 API 路徑。',
        requestId: 'request-1',
      },
    });
  });

  it('keeps response discriminants type-safe', () => {
    expectTypeOf<ApiError['error']['code']>().toEqualTypeOf<ApiErrorCode>();
    expectTypeOf<HealthResponse['status']>().toEqualTypeOf<'ok'>();
  });
});

import { describe, expect, it } from 'vitest';
import { AttentionRequiredError } from './attention-required.js';

describe('attention required errors', () => {
  it('keeps a stable WorkBuddy code and the original platform detail', () => {
    const error = new AttentionRequiredError({
      platform: 'zhihu',
      code: 'LOGIN_REQUIRED',
      message: '请完成登录后重新执行任务',
      url: 'https://zhuanlan.zhihu.com/write',
    }, 'ZHIHU_LOGIN_REQUIRED');

    expect(error.code).toBe('LOGIN_REQUIRED');
    expect(error.details).toMatchObject({ platform: 'zhihu', originalCode: 'ZHIHU_LOGIN_REQUIRED' });
  });
});

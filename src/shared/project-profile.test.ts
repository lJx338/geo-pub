import { describe, expect, it } from 'vitest';
import { friendlyProjectSaveError, projectProfileFields, validateProjectProfile } from './project-profile.js';

describe('project profile validation', () => {
  it('points to the exact invalid field', () => {
    expect(validateProjectProfile({ name: '' })).toEqual({ field: 'name', message: '请填写项目名称' });
    const issue = validateProjectProfile({ name: '客户', industry: '行'.repeat(projectProfileFields.industry.maxLength + 1) });
    expect(issue?.field).toBe('industry');
    expect(issue?.message).toContain('行业与核心业务内容过长');
  });

  it('turns IPC errors into customer-facing messages', () => {
    expect(friendlyProjectSaveError(new Error("Error invoking remote method 'geo:project-create': Error: PUBLISHER_BUSY: busy"))).toBe('发布任务正在运行，请等任务结束后再创建项目');
  });
});

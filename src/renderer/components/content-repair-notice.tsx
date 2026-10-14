import React from 'react';
import { AlertTriangle, CheckCircle2, FolderOpen, X } from 'lucide-react';
import type { ContentRepairNotice } from '../../main/content-repair.js';
import { Button } from './ui.js';

export function ContentRepairBanner({ notice, dismiss, notify }: {
  notice: ContentRepairNotice;
  dismiss: () => void;
  notify: (message: string, failed?: boolean) => void;
}) {
  const failed = notice.status === 'failed';
  const openLocation = async () => {
    try {
      const result = notice.backupPath
        ? await window.geoPublisher.openContentBackups()
        : await window.geoPublisher.openDataDirectory();
      if (!result.opened) notify(`无法打开保存位置：${result.error || '未知错误'}`, true);
    } catch (error) {
      notify(`无法打开保存位置：${(error as Error).message}`, true);
    }
  };
  return <div className={`content-repair-notice${failed ? ' error' : ''}`} role={failed ? 'alert' : 'status'}>
    {failed ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
    <p>{notice.message}</p>
    <Button variant="outline" icon={FolderOpen} onClick={() => void openLocation()}>{notice.backupPath ? '打开备份位置' : '打开保存位置'}</Button>
    <Button variant="ghost" icon={X} onClick={dismiss} aria-label="关闭数据修复提示" />
  </div>;
}

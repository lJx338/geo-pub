import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, X } from 'lucide-react';
import { Button, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Field } from './ui.js';
import type { WechatConnectionSettings } from '../../main/wechat/types.js';

export function WechatSettingsDialog({ projectId, projectName, busy, close, onSaved }: {
  projectId: string;
  projectName: string;
  busy: boolean;
  close(): void;
  onSaved?(settings: WechatConnectionSettings): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [settings, setSettings] = useState<WechatConnectionSettings | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('正在读取连接信息…');
  const [failed, setFailed] = useState(false);
  const [openingHelp, setOpeningHelp] = useState(false);
  const [helpError, setHelpError] = useState('');
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    let canceled = false;
    void window.geoPublisher.wechatSettings(projectId).then((value) => {
      if (canceled) return;
      setSettings(value); setAppId(value.appId);
      setMessage(value.configured ? '连接信息已加密保存，可点击测试连接。' : '填写当前客户自己的公众号 AppID 和 AppSecret。');
    }).catch((error) => { if (!canceled) { setMessage(error.message); setFailed(true); } });
    return () => { canceled = true; if (dialog?.open) dialog.close(); };
  }, [projectId]);
  const locked = busy || working || !settings;
  const dirty = appId.trim() !== settings?.appId || !!appSecret;
  const updateSettings = (value: WechatConnectionSettings) => {
    setSettings(value); setAppId(value.appId); setAppSecret(''); onSaved?.(value);
  };
  const execute = async (action: () => Promise<void>) => {
    if (locked) return;
    setWorking(true); setFailed(false); setHelpError('');
    try { await action(); }
    catch (error) { setMessage((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')); setFailed(true); }
    finally { setWorking(false); }
  };
  const dismiss = () => { if (!working && !busy) close(); };
  return <dialog ref={dialogRef} id="wechat-settings-dialog" className="platform-settings-dialog" aria-labelledby="wechat-settings-title" onCancel={(event) => { event.preventDefault(); dismiss(); }}>
    <section className="platform-settings-dialog-layout">
      <CardHeader><div><CardTitle><span id="wechat-settings-title">微信公众号连接设置</span></CardTitle><CardDescription>{projectName} · 密钥加密保存在当前电脑，按客户项目隔离。</CardDescription></div><Button variant="ghost" icon={X} disabled={working || busy} aria-label="关闭微信公众号连接设置" onClick={dismiss}/></CardHeader>
      <CardContent><div className="platform-setting-groups"><fieldset className="platform-setting-group"><legend>公众号凭据</legend><p>从微信开发者平台复制当前客户的两项信息。扫码登录用于查看后台；保存草稿使用这里的连接设置。</p>
        <Field label="AppID" htmlFor="wechat-app-id"><input id="wechat-app-id" autoComplete="off" spellCheck={false} value={appId} disabled={locked} placeholder="wx 开头的公众号 AppID" onChange={(event) => setAppId(event.target.value)}/></Field>
        <Field label="AppSecret" htmlFor="wechat-app-secret"><input id="wechat-app-secret" type="password" autoComplete="new-password" value={appSecret} disabled={locked} placeholder={settings?.configured ? '密钥已保存；更换时重新填写' : '填写公众号 AppSecret'} onChange={(event) => setAppSecret(event.target.value)}/></Field>
      </fieldset><p role="status" id="wechat-connection-message" style={{ fontSize: 12, lineHeight: 1.7, overflowWrap: 'anywhere', color: failed ? '#b42318' : '#475467' }}>{message}</p>
        {failed && message.includes('WECHAT_IP_NOT_ALLOWED:') && <div id="wechat-whitelist-help" style={{ padding: 12, border: '1px solid #b2ccff', borderRadius: 8, background: '#eff4ff', color: '#344054', fontSize: 12, lineHeight: 1.7 }}>
          <Button id="wechat-open-developer-platform" variant="outline" icon={ExternalLink} disabled={openingHelp} onClick={async () => {
            setOpeningHelp(true); setHelpError('');
            try { await window.geoPublisher.wechatOpenDeveloperPlatform(projectId); }
            catch (error) { setHelpError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
            finally { setOpeningHelp(false); }
          }}>{openingHelp ? '正在打开…' : '打开微信开发者平台'}</Button>
          <p style={{ margin: '8px 0 0' }}>在电脑浏览器中打开后，用公众号管理员微信扫码登录，进入：<br/>我的业务与服务 → 公众号 → 选择对应账号 → 基础信息 → 开发密钥 → API IP 白名单 → 编辑。</p>
          <p style={{ margin: '8px 0 0' }}>添加上方提示的网络出口 IP，保留仍在使用的其他 IP；保存并完成微信要求的确认后，回到这里点击“测试连接”。</p>
          {helpError && <p role="alert" style={{ margin: '8px 0 0', color: '#b42318', overflowWrap: 'anywhere' }}>{helpError}</p>}
        </div>}
        <div style={{ display: 'flex', gap: 8 }}><Button id="wechat-test-connection" variant="outline" disabled={locked || dirty || !settings?.configured} onClick={() => void execute(async () => {
          setMessage('正在检查微信接口…'); const result = await window.geoPublisher.wechatTestConnection(projectId);
          setMessage(`连接正常，草稿箱有 ${result.draftCount} 篇草稿。保存一篇草稿后才能确认写入权限。`);
        })}>测试连接</Button><Button id="wechat-clear-credentials" variant="ghost" disabled={locked || !settings?.configured} onClick={() => void execute(async () => {
          updateSettings(await window.geoPublisher.wechatClearCredentials(projectId)); setMessage('已清除本项目连接信息，历史草稿记录仍保留。');
        })}>清除连接</Button></div>
      </div></CardContent>
      <CardFooter><Button variant="outline" disabled={working || busy} onClick={dismiss}>关闭</Button><Button id="wechat-save-credentials" icon={CheckCircle2} disabled={locked || !appId.trim() || !appSecret.trim()} onClick={() => void execute(async () => {
        try { updateSettings(await window.geoPublisher.wechatSaveCredentials(projectId, { appId: appId.trim(), appSecret: appSecret.trim() })); }
        finally { setAppSecret(''); }
        setMessage('已加密保存。点击“测试连接”检查接口权限和 IP 白名单。');
      })}>{working ? '处理中' : '保存连接信息'}</Button></CardFooter>
    </section>
  </dialog>;
}

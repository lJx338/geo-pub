# 微信公众号接入说明

微信公众号已经接入原来的 GEO Publisher 主程序，随原程序一起启动，无需单独运行测试窗口。

## 在软件里怎么用

1. 打开原软件，选择客户项目。
2. 进入 **平台账号 → 微信公众号 → 右侧设置按钮**，填写该客户自己的 AppID 和 AppSecret，保存后测试连接。
3. 进入原来的 **分发 → 选择文章 → 配置分发**，勾选微信公众号。也可以直接在分发弹窗中打开“连接设置”。
4. 选择封面，必要时调整公众号专用标题，点击“开始填充／存草稿”。专用标题和作者只用于该次公众号草稿，不修改原文章。
5. 在原来的“最近分发记录”查看结果。显示“草稿已保存”表示已创建并读回核对；有草稿编号的记录可以点击“重新核对”。
6. 在“平台账号”点击微信公众号的“打开平台”，公众号后台会显示在原主窗口中，可以扫码查看草稿、检查排版或手动发表。

当前只做官方接口保存草稿，不做正式发表或群发。选中公众号时，分发方式固定为“仅填充／存草稿”；若要正式发布其他平台，请分开执行。

## WorkBuddy 同主题七平台写作

更新后重启程序，点击一次 **连接 WorkBuddy**，将新指令发给 WorkBuddy，更新它已安装的五个 Skill。已有定时任务不会自动改写，请用软件“使用指南”里的新版提示词更新任务说明。

可以直接告诉 WorkBuddy：**“用当前客户项目的一个可用选题，按各平台规则分别写七篇文章，包含微信公众号，保存到内容中心，先不要分发。”**

- 只选并占用一个主题，七篇文章使用同一个 `payload.topicId`，核心问题和事实一致。
- 各平台独立写正文，分别保存一条文章记录；公众号版本的 `platform` 为 `wechat`。
- 明确指定部分平台时只写对应版本；未指定平台的普通写作请求默认七篇。所有目标文章保存成功后，只标记一次选题已使用；中断重试只补缺失版本。
- 写作不要求公众号已配置接口凭据。需要存入微信草稿箱时，先在当前客户的公众号连接设置完成配置，再让 WorkBuddy 使用 `validate` 和 `fill`；`publish wechat` 会被拒绝。
- 公众号正文图片引用当前客户素材库的 `materialId`，由主程序读取、上传；接口密钥不经过文章或 WorkBuddy 对话。

规则文件：`integrations/workbuddy/geo-article-writer/SKILL.md` 管理共同主题与分平台保存；`references/platform-rules.md` 管理平台风格；`references/output-contract.md` 管理共同质量要求。`geo-publisher/SKILL.md` 负责使用各平台对应的文章版本分发。桌面端手动选择一篇文章并勾选多个平台，仍是分发所选文章，不会在分发阶段自动写作。

## 客户要准备什么

- 客户自己公众号的 AppID、AppSecret，以及管理对应公众号的权限。
- 在微信开发者平台核对接口权限和 IP 白名单；白名单应放行客户电脑发起请求时的公网出口 IP，更换网络后可能需要更新。
- PNG/JPEG 封面，小于 10 MB；正文图片为 PNG/JPEG，每张小于 1 MB。
- 公众号标题 2～32 个字。原文标题较长时，在分发弹窗中填写公众号专用标题即可。

实际权限通过微信接口响应确认，不按个人号或企业号简单断言一定可用。连接测试通过表示能读取草稿箱；写入权限通过保存一篇草稿验证。

请求由本地 Electron 主进程直接发给微信，无需另外搭建自己的云服务器。AppID/AppSecret 接口凭据与扫码登录的网页会话分别管理；扫码后请确认网页中登录的是当前客户的公众号。本版本不是微信开放平台的第三方扫码授权模式。

## 这次修改了哪些原文件

以下是从“独立模块”接入“原程序”的改动清单。原工作区已经存在的 `package.json` 改动没有再修改；`platform-sessions.ts` 之前的窗口前置和弹窗相关改动也保留。

| 原文件 | 修改用途 |
| --- | --- |
| `src/main/index.ts` | 主程序启动时创建微信适配器，注入平台任务管理器，注册公众号连接与核对操作 |
| `src/main/platform-sessions.ts` | 增加公众号后台地址及内嵌页面，草稿写入转到官方 API，复用原任务锁和客户隔离，阻止公众号进入网页发布流程 |
| `src/main/distribution-service.ts` | 微信结果写入原分发记录，保存草稿编号和核对状态，禁止错误结果被记为成功，公众号请求不套用浏览器重试策略；提交前再次核对客户项目 |
| `src/main/cookie-vault.ts` | 增加微信域名，使原本的加密网页登录状态保存机制支持公众号 |
| `src/main/publish-adapter.ts` | 缩小网页发布适配器的类型范围，明确排除只走草稿 API 的微信公众号 |
| `src/shared/protocol.ts` | 注册 `wechat` 平台；接受草稿请求，拒绝公众号正式发布请求 |
| `src/shared/platform-settings.ts` | 增加公众号专用标题、作者以及用于核对目标账号的 AppID 参数 |
| `src/shared/distribution-diagnostics.ts` | 在诊断中区分草稿保存、读回失败与结果不确定，提供对应处理提示 |
| `src/preload.ts` | 提供连接设置、保存凭据、测试连接、清除连接、重新核对的受限接口 |
| `src/renderer/global.d.ts` | 为上述页面接口补充类型声明 |
| `src/renderer/app.tsx` | 原平台列表、账号设置和分发弹窗增加微信公众号；原记录显示“草稿已保存”，支持重新核对 |

没有修改原项目资料格式、文章库结构、六个平台的填充实现、依赖清单或构建脚本。Go CLI 和 WorkBuddy 已加入 `wechat` 平台写作、校验和草稿分发支持；仍不会允许公众号正式发表。

## 本次新增和调整的模块文件

| 文件 | 功能 |
| --- | --- |
| `src/main/wechat/desktop.ts`（新增） | 主程序的微信连接设置、IPC 来源检查、原分发记录重新核对 |
| `src/renderer/components/wechat-settings.tsx`（新增） | 原界面里的公众号连接设置弹窗 |
| `src/main/wechat/integration.test.ts`（新增） | 原分发记录、状态映射、禁止发表、客户任务锁与异步客户切换测试 |
| `tests/wechat-desktop-smoke.mjs`（新增） | 使用原启动入口验证完整窗口流程和账号隔离，模拟所有微信 API |
| `src/main/wechat/types.ts`（调整） | 补充页面可读取的连接状态类型，不返回 AppSecret |
| `docs/WECHAT-ADDON.md`（调整） | 更新为已经接入主程序的使用说明和文件改动清单 |

`src/main/wechat/adapter.ts`、`api.ts`、`storage.ts`、`document.ts` 等核心模块继续使用：负责接口凭据、本地加密、图片上传、创建草稿、读回比较、异常中断与重复创建保护。该目录是主程序使用的公众号适配层，不是废弃目录。

## 清理和 WorkBuddy 支持改动清单

本阶段没有新增代码文件，直接修改现有流程；删除以下九个旧独立预览文件：

- `src/main/wechat/preview.ts`
- `src/main/wechat/preview-preload.ts`
- `src/main/wechat/browser.ts`
- `src/main/wechat/library-reader.ts`
- `src/main/wechat/ui/index.html`
- `src/main/wechat/ui/styles.css`
- `src/main/wechat/ui/app.js`
- `scripts/wechat-preview.mjs`
- `tests/wechat-preview-smoke.mjs`

修改文件：

| 文件 | 功能 |
| --- | --- |
| `cli/main.go` | 七个平台识别和使用说明；公众号校验与草稿请求；正文素材 ID、图注与公众号单次选项；阻止正式发表 |
| `cli/main_test.go` | 验证公众号标题、封面、图片、账号绑定、单次选项和禁止发表 |
| `integrations/workbuddy/geo-article-writer/SKILL.md` | 一次占用一个选题、七平台分别生成保存、全部完成后标记使用、失败续作去重 |
| `integrations/workbuddy/geo-article-writer/references/platform-rules.md` | 增加公众号阅读场景、行文、配图和草稿边界 |
| `integrations/workbuddy/geo-article-writer/references/output-contract.md` | 素材库图片引用、同主题不同平台与重试去重规则 |
| `integrations/workbuddy/geo-article-writer/agents/openai.yaml` | 更新七平台写作介绍和调用提示 |
| `integrations/workbuddy/geo-topic-planner/SKILL.md` | 一个主选题供七个平台共用 |
| `integrations/workbuddy/geo-publisher/SKILL.md` | 根据主题和平台选对应稿件；公众号官方接口存草稿和状态说明 |
| `integrations/workbuddy/geo-publisher/agents/openai.yaml` | 更新分发能力介绍 |
| `src/main/workbuddy-integration.ts` | 新连接指令说明七平台共用选题及公众号草稿流程 |
| `src/renderer/app.tsx` | 更新写作、填充、自动化和多客户任务的复制提示词 |
| `src/main/wechat/wechat.test.ts` | 移除已删除的独立预览资料读取器测试，保留接口和存储测试 |
| `tests/wechat-desktop-smoke.mjs` | 增加生产 CLI 同主题七篇入库、公众号存草稿与读回、重复保护、客户隔离验证 |
| `README.md`、`docs/USER_GUIDE.md`、`docs/WECHAT-ADDON.md` | 同步七平台使用说明和本次改动清单 |

## 数据保存位置

Windows 默认数据根目录为 `%LOCALAPPDATA%\GEO Publisher Desktop`；设置 `GEO_PUBLISHER_USER_DATA_DIR` 时使用该目录。

- `projects/<项目 ID>/wechat/credentials.bin`：系统加密的 AppID/AppSecret。
- `projects/<项目 ID>/wechat/records/<编号>.json`：草稿操作凭据与核对内容，支持断网/重启后避免重复创建。
- `content/content.sqlite3`：原文章库和分发记录。微信公众号的记录也在这里，带 `platform: wechat`，关联原文章。
- `projects/<项目 ID>/session-vault/wechat.bin`：网页 Cookie 的加密备份。
- 原 Electron 会话目录中的 `persist:geo-publisher-<项目 ID>-wechat`：内嵌公众号页面的独立浏览器会话。

AppSecret 不返回页面、不写入分发记录；微信接口 token 仅在内存缓存。系统加密不可用时拒绝保存，不退回明文。网页会话过期仍需重新扫码，更换 AppID 不会自动切换网页账号。清除连接信息保留历史记录；通过原程序删除客户项目时，同时清理该项目的公众号配置、记录和网页会话。

## 状态与限制

- **草稿已保存**：已取得 `media_id` 并读回核对标题、正文、图片、封面及主要结构。原文章不会因此被标成“已发布”。
- **需人工处理**：查看记录中的原因；已有草稿编号时，重新核对只读取已有草稿，不再创建。
- **结果待确认**：创建请求中断，无法确定微信是否已接收；相同账号、内容和图片不会自动再建，需先在公众号后台核对。此版没有自动解除不确定状态的功能。
- 已保存草稿再次提交会读回已有草稿。若草稿被人工删除或发表，不会默默新建一份。
- 本版为单篇图文草稿；不支持多篇组合、自动压缩图片、WebP 转换或任意网络图片下载。网络图片应先导入本客户素材库。
- 上传成功但后续创建失败时，微信素材库可能留有已上传的素材；不会自动删除这些素材。
- 原任务锁阻止保存期间切换或删除客户、修改连接配置。每个官方 API 请求有超时；不会用浏览器的总超时提前释放仍在写入的微信任务。
- 强制终止进程可能留下 `projects/<项目 ID>/wechat/operation.lock`。确认程序已退出且没有任务后，仅清理该锁文件，保留 `records`；已有未确认记录仍阻止重复创建。
- 自动读回核对不能替代最终的视觉排版检查。正式发表请在公众号后台操作。

## 验证与运行

按原有开发流程启动：

```powershell
npm run dev
```

验证命令：

```powershell
npm run typecheck
node node_modules/vitest/vitest.mjs run
npm run build
npm run build:cli
cd cli
go test ./...
cd ..
node tests/wechat-desktop-smoke.mjs
```

桌面流程测试使用临时客户资料和模拟接口，覆盖同一个主窗口中的连接设置、文章选择、公众号专用标题、图片上传、原分发记录、结果不确定、重新核对、任务期间禁止切换客户、网页登录隔离、重启配置读取和项目删除清理；通过生产 CLI 验证同主题七篇独立文章入库、选题只使用一次、公众号正文素材上传和记录关联、重复保护及跨客户请求拒绝。文章使用测试样例，未调用真实 WorkBuddy 模型；测试不向真实微信账号发请求，客户实际权限和真实稿件仍需用其账号联调。

## 官方接口文档

- [获取稳定接口凭据](https://developers.weixin.qq.com/doc/subscription/api/base/api_getstableaccesstoken.html)
- [上传正文图片](https://developers.weixin.qq.com/doc/subscription/api/material/permanent/api_uploadimage.html)
- [新增永久素材（封面）](https://developers.weixin.qq.com/doc/subscription/api/material/permanent/api_addmaterial.html)
- [新增草稿](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add.html)
- [读取草稿](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_getdraft.html)
- [获取草稿总数](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_count.html)

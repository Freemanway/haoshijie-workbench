# 好时节AI工作台

好时节内部运营系统：把“公域内容曝光 → 私信咨询 → 线索入库 → 私域成交”串成一条可追踪的流水线。一期只做小红书。

- 产品需求文档：<https://claude.ai/code/artifact/167b1d6c-be3d-462f-9a10-5a705036649b>
- 一期可交互原型：<https://claude.ai/artifact/7wdYQDirLT7Ujyhb751Vu3>
- 研发任务拆解与技术方案：<https://claude.ai/code/artifact/d4e70245-904c-422e-9570-55ffd7524144>
- 试用验收与客服培训：<https://claude.ai/code/artifact/4860ba0d-d398-41ad-9ce5-aedbad1d96ac>
- 上线：[上线手册](docs/上线手册.md)、[压测记录](docs/压测记录.md)

## 目录

| 目录 | 内容 |
| --- | --- |
| `apps/web` | 管理后台与客服 H5：React 19 + Vite + Ant Design 5 |
| `apps/server` | 后端服务：NestJS 11 + Prisma 6（PostgreSQL） |
| `packages/shared` | 前后端共用的业务规则：内容风控词库匹配、收货地址拆分 |
| `deploy` | 生产部署：接口服务和前端镜像、nginx、docker compose |
| `docs` | 上线手册、压测记录 |

## 本地开发

需要 Node.js 22、pnpm 10、Docker。

```bash
pnpm install
pnpm db:up                         # 启动 PostgreSQL（pgvector）和 Redis
cp .env.example apps/server/.env   # 按需修改
pnpm db:migrate                    # 建表
# 写入初始风控词库、知识库样例，并创建首位管理员（填你自己的企业微信成员账号）
SEED_ADMIN_WECOM_ID=你的成员账号 SEED_ADMIN_NAME=你的名字 pnpm --filter @hsj/server db:seed
pnpm --filter @hsj/shared build
pnpm dev:server                    # http://localhost:3000/api
pnpm dev:web                       # http://localhost:5173
```

开发环境 `AUTH_DEV_LOGIN=true` 时，登录页可直接填成员账号登录；配置好 `WECOM_*` 后出现企业微信扫码登录。生产环境必须把 `AUTH_DEV_LOGIN` 设为 `false`，并换掉 `JWT_SECRET`。

常用检查：`pnpm typecheck`、`pnpm test`、`pnpm build`。后端接口测试使用单独的 `hsj_test` 库，第一次运行前先建库：

```bash
docker compose exec postgres createdb -U hsj hsj_test
DATABASE_URL=postgresql://hsj:hsj@localhost:5432/hsj_test pnpm --filter @hsj/server prisma:deploy
```

## 登录与权限

- 只有管理员在“设置 > 成员与权限”里添加过的企业微信成员能登录；停用或改角色立即生效。
- 角色：管理员、内容运营、审核人、客服、招商、管理层（只读）。管理员拥有全部权限。
- 除健康检查和登录相关接口外，所有接口都要带 `Authorization: Bearer <令牌>`，令牌 12 小时有效。
- 成员、平台账号、风控词的增删改都写入审计日志（`AuditLog`）。

## 已有接口

| 接口 | 说明 | 任务 |
| --- | --- | --- |
| `GET /api/health` | 服务与数据库状态（无需登录） | M0 |
| `GET /api/auth/options`、`GET /api/auth/wecom/login`、`POST /api/auth/dev-login`、`GET /api/auth/me` | 登录方式、企业微信扫码、开发登录、当前成员 | M1 |
| `GET/POST/PATCH /api/users` | 成员与角色管理（管理员） | M1 |
| `GET/POST/PATCH/DELETE /api/accounts` | 平台账号绑定（写操作限管理员） | M1 |
| `/api/knowledge/items`、`/faqs`、`/assets` | 知识条目、FAQ、素材的增删改查（写操作限内容运营） | M2 |
| `GET /api/knowledge/search?q=`、`GET /api/knowledge/assets/recommend?tags=` | 知识检索（暂为关键词匹配，向量检索随 M4-1 接入）、按标签推荐素材 | M2 |
| `POST /api/risk/check` `{ text, platform?, source?, sourceId? }` | 风控检测，返回命中词、级别和替换建议；带来源时记录命中日志 | M5 |
| `GET/POST/PATCH/DELETE /api/risk/words` | 风控词库维护（写操作限审核人），改完立即生效 | M5 |
| `GET /api/risk/stats/top-words?days=7` | 近 N 天高频命中词 | M5 |
| `GET /api/ai/status`、`GET /api/ai/usage?days=30`、`GET /api/ai/calls?refType=&refId=` | 当前模型、调用量与费用（管理员）、某个选题或稿件的全部 AI 调用记录 | M4-1 |
| `GET/PUT /api/topics/settings`、`/api/topics/categories` | 每周配额、C/B 比例、季节节点、自动生成开关；选题类别增删 | M3-1 |
| `GET /api/topics/weekly?weekOf=`、`POST /api/topics/weekly/generate`、`POST /api/topics/weekly/confirm` | 每周选题清单：查看、AI 生成（默认下周）、确认后批量生成稿件 | M3-2、M3-3 |
| `GET/POST/PATCH/DELETE /api/topics`、`POST /api/topics/:id/replace` | 选题库维护；替换清单里的一个选题 | M3 |
| `GET/POST /api/drafts`、`GET /api/drafts/:id`、`POST /api/drafts/:id/retry` | 稿件列表、按选题生成小红书稿件（默认 2 个版本）、详情（含风控和规格检查、推荐素材）、失败重试 | M4-2 |
| `POST /api/drafts/:id/rewrite`、`PATCH /api/drafts/:id/versions/:vid`、`POST …/choose` | AI 改写（整篇重写、改语气、缩短、扩写、按驳回原因重写）、人工修改、设为采用；每次都生成新版本 | M4-3 |
| `POST /api/drafts/:id/submit`、`/withdraw`、`/approve`、`/reject` `{ reason }`、`/comments`、`POST /api/drafts/batch-approve` | 审核流：提交（含拦截词不能提交）、撤回、通过、驳回（必填原因）、批注、批量通过；提交通知审核人，驳回通知运营 | M6 |
| `PATCH /api/drafts/:id/review-versions/:vid`、`GET /api/drafts/:id/reviews` | 审核人直接修改（记录改前改后，页面可看逐行对比）、审核记录 | M6 |
| `GET /api/schedule?from=&to=`、`POST /api/schedule` `{ draftId, accountIds, publishAt }`、`PATCH/DELETE /api/schedule/:id` | 排期日历；只排审核通过的稿件，受账号每日上限约束，多账号发同一篇时提示做差异化；改期、换账号、取消 | M7-1 |
| `GET /api/schedule/today`、`GET /api/schedule/:id/package`、`POST …/publish` `{ postUrl }`、`POST …/fail` `{ reason }` | 今日待发、素材包（文案、配图建议、素材库里标签匹配的图片）、回填作品链接、标记发布失败 | M7-2 |
| `GET /api/schedule/metrics-due`、`POST /api/schedule/:id/metrics` `{ checkpoint: '24h'\|'7d', reads, likes, saves, comments }` | 待回填数据、回填发布 24 小时 / 7 天数据 | M7-3 |
| `POST /api/inbox/manual` `{ accountId, kind, nickname, text, postUrl? }` | 半自动接入：客服贴入小红书私信或咨询评论，AI 立即回复（待复制发送） | M8-1 |
| `POST /api/inbox/webhook` `{ events: [{ id, accountId, kind, userId, nickname?, text, postUrl? }] }` | 实时接入：授权服务商推送消息，请求体用 `INBOX_WEBHOOK_SECRET` 做 HMAC-SHA256 放在 `X-Hsj-Signature`；先落库再处理，重复推送只处理一次，失败定时重试 | M8-1 |
| `GET /api/inbox/conversations?status=&accountId=&mine=&q=`、`GET …/:id` | 统一收件箱：会话列表（五种状态计数）、会话详情 | M8-2 |
| `POST …/:id/claim`、`/messages` `{ text }`、`/summary`、`/handoff`、`/release`、`/status`、`PATCH /api/inbox/messages/:id/sent` | 客服接管、回复（发出前风控）、客户摘要与建议回复、转人工、交还 AI、标记已引流/关闭、半自动消息标记已发送 | M8-4、M8-5 |
| `GET/PUT /api/inbox/settings` | 接待设置：自动应答开关、人工工作时间、响应时限、转人工和非工作时间话术、C/B 引流话术 | M8-3、M8-4 |
| `GET /api/wecom/status`、`GET/PUT /api/wecom/settings` | 企业微信配置状态；默认欢迎语（C/B）、团购群快满提醒人数 | M9-0、M9-2 |
| `GET/POST /api/wecom/channels`、`PATCH/DELETE …/:id` | 渠道活码：每个平台账号一个“联系我”二维码或获客助手链接，自动建同名来源标签；删除时作废企业微信那边的码，保留加微记录 | M9-1 |
| `GET /api/wecom/conversation-link/:conversationId` | 私信会话专属加微链接（获客链接带 `customer_channel=cv_<会话>`） | M9-2 |
| `GET/POST /api/wecom/callback` | 企业微信回调（加解密同官方 WXBizMsgCrypt）：加微后发欢迎语（C 端可附团购群码）、打来源标签、关联或新建线索、私信会话标记已引流；员工备注手机号后按手机号并到已有线索 | M9-2 |
| `GET /api/wecom/contacts?channelId=` | 最近加微的客户 | M9-2 |
| `GET/POST /api/wecom/groups`、`PATCH/DELETE …/:id`、`POST …/:id/check` | 团购群活码（企业微信“加入群聊”，最多 5 个群，可开群满自动建群）；每小时刷新群人数，没开自动建群时群都快满了提醒换群 | M9-3 |
| `POST /api/leads/parse-address` `{ raw }` | 整段地址拆成收件人、电话、省市区、详细地址，按“线索设置”的配送范围校验 | M10-2 |
| `GET /api/leads?audience=&status=&intent=&ownerId=&account=&mine=&q=&page=`、`GET …/:id` | 线索列表（C/B 分开、各状态计数、手机号脱敏）与详情（来源记录、地址、跟进、私信会话、企业微信） | M10-3 |
| `POST /api/leads`、`PATCH …/:id` | 手动录入、编辑线索；人工改过的客群、意向、姓名、微信 AI 不再覆盖；改手机号撞到已有线索时自动合并 | M10-1、M10-3 |
| `POST …/:id/follow-ups` `{ note, nextFollowAt?, status? }`、`/script`、`/extract` | 跟进记录、推荐话术、AI 从对话重新提取意向 | M10-3 |
| `POST/PATCH/DELETE …/:id/addresses`、`POST …/:id/addresses/import` `{ text }` | 收货地址（多地址）、批量导入（每行一个，可从 Excel 粘贴） | M10-2 |
| `POST …/:id/reveal` `{ addressId? }`、`GET /api/leads/export?audience=`、`GET/PUT /api/leads/settings`、`POST …/:id/merge` | 查看明文（记日志）、管理员明文导出 CSV（记日志）、配送范围与告知语与未跟进时限、管理员手动合并 | M10-4、M10-5 |
| `POST /api/orders/import/preview`、`POST /api/orders/import` `{ tool, fileName, data(base64), mapping }` | 团购订单表（.xlsx / .csv）导入：先预览并猜字段映射，确认后导入；同订单号或同行内容不重复导入；映射按工具记住 | M11-1 |
| `GET /api/orders?state=&tool=&q=&from=&to=&importId=&page=`、`POST …/:id/link` `{ leadId }`、`/unlink`、`/reveal` | 订单列表（脱敏、汇总）、待人工关联、人工关联（同手机号或同收货人加地址的其他未关联订单一起关联）、撤销、看明文（记日志） | M11-2 |
| `POST /api/orders/manual`、`DELETE /api/orders/:id`、`GET /api/orders/imports`、`DELETE /api/orders/imports/:id` | B 端和线下成交人工录入（报价、合同、金额）、删除人工录入、导入记录、管理员整批删除 | M11-3 |
| `GET /api/reports/dashboard?from=&to=&platform=&accountId=` | 数据周报看板：内容、客服、C/B 端客资、转化漏斗，并和等长的上一期环比；按北京时间实时计算 | M12-1、M12-2 |
| `GET /api/reports`、`GET /api/reports/:id`、`POST /api/reports/generate` `{ kind, from?, to?, push }` | 周报 / 月报快照（含 AI 解读）；每周一 9:00 生成上周周报、每月 1 日生成上月月报并推送企业微信（管理员、只读、内容岗）；管理员可手动生成 | M12-3 |
| `GET /api/reports/export?from=&to=&platform=&accountId=` | 明细 Excel：汇总、作品、会话，管理员另含脱敏的线索表（记导出日志）；看板导出 PDF 走浏览器打印 | M12-3 |
| `GET /api/reports/baseline`、`PUT /api/reports/baseline` `{ period, note, baseline, target }` | 上线前基线和目标（PRD 11.2，人工方式下的每周数字）；看板对比本期，管理员录入并记日志 | M13-1 |

## 大模型

- 当前选用 DeepSeek（`deepseek-chat`），`.env.example` 已填好接口地址和模型名，部署时只需填 `LLM_API_KEY`。填好后运行 `pnpm --filter @hsj/server llm:check`，会发一次请求并实际生成一篇小红书稿件，检查格式和规格。
- DeepSeek 目前把 `deepseek-chat` 映射到 `deepseek-flash`，也可以直接把 `LLM_MODEL` 改成 `deepseek-flash` 或 `deepseek-v4-pro`。
- 模型网关只依赖 OpenAI 兼容接口，换模型只改 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，见 `.env.example`。
- 不配置时使用演示模型，输出固定的示例内容，页面会提示“当前为演示模型”。测试一律走演示模型。
- 提示词模板在 `apps/server/src/ai/prompts.ts`，每个模板带版本号；每次调用都写入 `LlmCall`（模板版本、输入输出、tokens、费用、耗时），稿件版本记录生成它的调用。
- 输出不合格（格式不对、字数或篇数不符）时带上问题自动重试一次，仍不合格的保留下来并在页面标出问题，由运营修改。
- 知识库里的“合规口径”条目作为改写规则交给模型，不当作事实写进稿件。
- 每周四 9:00（北京时间）自动生成下周选题清单，可在“选题清单 > 配额与类别”里关闭，部署时也可用 `CRON_ENABLED=false` 关闭。
- 定时任务（`CRON_ENABLED=false` 可全部关闭）：每分钟检查到点排期并提醒内容运营去发；每小时检查发布满 24 小时、7 天的作品并提醒回填数据；周四生成选题清单后也会提醒。
- 收件箱：AI 每轮判断客群和意向，按 FAQ 和品牌资料回复，发出前过风控（拦截时重写一次，仍不合规就转人工）。客户要求人工、B 端谈价格合作、投诉售后、连续 2 轮答不上、回复无法通过风控时转人工；工作时间内超过响应时限提醒客服和管理员，非工作时间告知上班时间并引导留资。AI 回复命中的 FAQ 会计入每周选题的“私信高频问题”。手机端在企业微信里打开 `/m/inbox`。
- 提醒走企业微信应用消息（`WECOM_*`），没配置时只写日志。
- 私域引流：自建应用需在企业微信后台“客户联系 > API”里设为可调用应用；回调地址填 `https://<域名>/api/wecom/callback`，Token、EncodingAESKey 填进 `WECOM_CALLBACK_TOKEN`、`WECOM_CALLBACK_AES_KEY`。获客助手链接需企业开通获客助手。获客链接的 `customer_channel` 会在加微回调的 State 里带回（上线前用真实企业再核对一次）。
- 手机号、收货地址加密存储（`FIELD_ENCRYPTION_KEY`，AES-256-GCM），手机号另存 HMAC 用于去重和匹配；生产环境必须配置密钥。列表和管理层只看脱敏数据，查看明文、导出都记审计日志。
- 线索：私信里中高意向、要人工、谈合作、投诉的会话自动建档，客户留手机号也会建档；同手机号或同平台用户 ID 合并成一条并保留每次来源。新线索 B 端分给招商、C 端客服轮流分配并提醒负责人；到下次跟进时间、新线索超过时限（默认 24 小时）没跟进，提醒负责人（各一次）。
- 客户在私信里发整段地址：AI 接待时回显核对（只露手机尾号，附上用途告知），客户回“确认”后地址标记已确认；不在配送范围的转人工。人工接待中识别到的地址先存为待确认，在线索里确认。
- 稿件生成在进程内排队（同时最多 2 个）；收件箱同时处理 `INBOX_CONCURRENCY` 条（默认 8，估算方法见[压测记录](docs/压测记录.md)）。多实例部署时换成 Redis + BullMQ。
- 上线前运行 `pnpm --filter @hsj/server preflight` 检查生产配置和基础数据；`loadtest` 按咨询峰值压测收件箱（只对测试环境）。

## 约定

- 手机号、地址等个人信息以密文存库（`*Enc` 字段），另存哈希（`*Hash`）用于去重和订单匹配。
- 所有对外文本（稿件、私信回复）发出前必须经过 `RiskEngine`。
- 服务器部署在境内；大模型使用国内已备案模型，经模型网关调用（M4-1）。

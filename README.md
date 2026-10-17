# 好时节AI工作台

好时节内部运营系统：把“公域内容曝光 → 私信咨询 → 线索入库 → 私域成交”串成一条可追踪的流水线。一期只做小红书。

- 产品需求文档：<https://claude.ai/code/artifact/167b1d6c-be3d-462f-9a10-5a705036649b>
- 一期可交互原型：<https://claude.ai/artifact/7wdYQDirLT7Ujyhb751Vu3>
- 研发任务拆解与技术方案：<https://claude.ai/code/artifact/d4e70245-904c-422e-9570-55ffd7524144>

## 目录

| 目录 | 内容 |
| --- | --- |
| `apps/web` | 管理后台与客服 H5：React 19 + Vite + Ant Design 5 |
| `apps/server` | 后端服务：NestJS 11 + Prisma 6（PostgreSQL） |
| `packages/shared` | 前后端共用的业务规则：内容风控词库匹配、收货地址拆分 |

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
| `POST /api/leads/parse-address` `{ raw }` | 整段地址拆成收件人、电话、省市区、详细地址，校验配送范围 | M10-2 |

## 大模型

- 当前选用 DeepSeek（`deepseek-chat`），`.env.example` 已填好接口地址和模型名，部署时只需填 `LLM_API_KEY`。填好后运行 `pnpm --filter @hsj/server llm:check`，会发一次请求并实际生成一篇小红书稿件，检查格式和规格。
- 模型网关只依赖 OpenAI 兼容接口，换模型只改 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，见 `.env.example`。
- 不配置时使用演示模型，输出固定的示例内容，页面会提示“当前为演示模型”。测试一律走演示模型。
- 提示词模板在 `apps/server/src/ai/prompts.ts`，每个模板带版本号；每次调用都写入 `LlmCall`（模板版本、输入输出、tokens、费用、耗时），稿件版本记录生成它的调用。
- 输出不合格（格式不对、字数或篇数不符）时带上问题自动重试一次，仍不合格的保留下来并在页面标出问题，由运营修改。
- 知识库里的“合规口径”条目作为改写规则交给模型，不当作事实写进稿件。
- 每周四 9:00（北京时间）自动生成下周选题清单，可在“选题清单 > 配额与类别”里关闭，部署时也可用 `CRON_ENABLED=false` 关闭。
- 稿件生成在进程内排队（同时最多 2 个）；多实例部署时换成 Redis + BullMQ。

## 约定

- 手机号、地址等个人信息以密文存库（`*Enc` 字段），另存哈希（`*Hash`）用于去重和订单匹配。
- 所有对外文本（稿件、私信回复）发出前必须经过 `RiskEngine`。
- 服务器部署在境内；大模型使用国内已备案模型，经模型网关调用（M4-1）。

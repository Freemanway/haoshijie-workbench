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
pnpm --filter @hsj/shared build
pnpm dev:server                    # http://localhost:3000/api
pnpm dev:web                       # http://localhost:5173
```

常用检查：`pnpm typecheck`、`pnpm test`、`pnpm build`。

## 已有接口

| 接口 | 说明 | 任务 |
| --- | --- | --- |
| `GET /api/health` | 服务与数据库状态 | M0 |
| `POST /api/risk/check` `{ text }` | 风控检测，返回命中词、级别和替换建议 | M5-2 |
| `POST /api/leads/parse-address` `{ raw }` | 整段地址拆成收件人、电话、省市区、详细地址，校验配送范围 | M10-2 |

## 约定

- 手机号、地址等个人信息以密文存库（`*Enc` 字段），另存哈希（`*Hash`）用于去重和订单匹配。
- 所有对外文本（稿件、私信回复）发出前必须经过 `RiskEngine`。
- 服务器部署在境内；大模型使用国内已备案模型，经模型网关调用（M4-1）。

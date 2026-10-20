/**
 * 收件箱压测（M13-2）：按错峰季的咨询峰值往消息接收接口推私信，同时模拟客服在收件箱里轮询，
 * 统计接口耗时、AI 首条回复的等待时间和失败数。
 *
 * 只能对测试环境跑：会建出一批以 lt- 开头的假客户会话，跑完用 --cleanup 删掉。
 *
 *   pnpm --filter @hsj/server loadtest -- --rate 1 --minutes 5 --agents 8
 *   pnpm --filter @hsj/server loadtest -- --cleanup
 *
 * 需要的环境变量：DATABASE_URL、INBOX_WEBHOOK_SECRET（和被测服务一致）；
 * 模拟客服轮询需要被测服务开着 AUTH_DEV_LOGIN（测试环境），否则加 --agents 0。
 */
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const BASE = arg('base', process.env.LOADTEST_BASE ?? 'http://localhost:3000/api');
const RATE = Number(arg('rate', '1')); // 每秒客户消息数
const MINUTES = Number(arg('minutes', '3'));
const AGENTS = Number(arg('agents', '6'));
const PER_CUSTOMER = 3; // 每位客户连发几条
const GAP_S = Number(arg('gap', '20')); // 同一客户两条消息的间隔
const DRAIN_S = Number(arg('drain', '600')); // 推完后最多等多久让 AI 回完
const SECRET = process.env.INBOX_WEBHOOK_SECRET ?? '';
const prisma = new PrismaClient();

const QUESTIONS = [
  '你好，无花果多少钱一盒？',
  '新疆能发货吗',
  '无花果怎么保存？放冰箱可以吗',
  '我想买两盒送人，有礼盒装吗',
  '今天下单什么时候到？',
  '你们是产地直发吗，甜不甜',
  '我们是水果店，想谈一下批发，起订量多少',
  '收到有坏果怎么办',
  '孕妇能吃吗',
  '13800138000，张三，四川省成都市武侯区天府大道 1 号',
];

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (ms: number) => (Number.isNaN(ms) ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} 毫秒`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  const convs = await prisma.conversation.findMany({ where: { externalUserId: { startsWith: 'lt-' } }, select: { id: true } });
  const ids = convs.map((c) => c.id);
  const leadIds = (await prisma.lead.findMany({ where: { conversationId: { in: ids } }, select: { id: true } })).map((l) => l.id);
  await prisma.$transaction([
    prisma.followUp.deleteMany({ where: { leadId: { in: leadIds } } }),
    prisma.address.deleteMany({ where: { leadId: { in: leadIds } } }),
    prisma.leadSource.deleteMany({ where: { OR: [{ leadId: { in: leadIds } }, { conversationId: { in: ids } }] } }),
    prisma.lead.deleteMany({ where: { id: { in: leadIds } } }),
    prisma.message.deleteMany({ where: { conversationId: { in: ids } } }),
    prisma.conversation.deleteMany({ where: { id: { in: ids } } }),
    prisma.inboundEvent.deleteMany({ where: { externalId: { startsWith: 'api:lt-' } } }),
  ]);
  console.log(`已删除 ${ids.length} 个压测会话和 ${leadIds.length} 条压测线索`);
}

async function main() {
  if (process.argv.includes('--cleanup')) return cleanup();
  if (!SECRET) throw new Error('缺少 INBOX_WEBHOOK_SECRET');
  const account = await prisma.platformAccount.findFirst({ where: { platform: 'XHS' }, orderBy: { createdAt: 'asc' } });
  if (!account) throw new Error('测试库里没有小红书账号');
  const run = `lt-${Date.now().toString(36)}`;
  const started = new Date();
  console.log(`压测 ${run}：每秒 ${RATE} 条，持续 ${MINUTES} 分钟，每位客户 ${PER_CUSTOMER} 条、间隔 ${GAP_S} 秒，${AGENTS} 名客服轮询，账号 ${account.name}`);

  const hook: number[] = [];
  const poll: number[] = [];
  let hookErrors = 0;
  let pollErrors = 0;
  let sent = 0;

  // 客服：每 5 秒刷新收件箱列表和当前会话，和网页里的轮询一致
  const agents = await Promise.all(
    Array.from({ length: AGENTS }, async () => {
      const wecomId = (await prisma.user.findFirst({ where: { roles: { has: 'CS' }, active: true } }))?.wecomId ?? 'admin';
      const res = await fetch(`${BASE}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wecomId }) });
      if (!res.ok) throw new Error(`客服登录失败（HTTP ${res.status}），测试环境需开 AUTH_DEV_LOGIN，或加 --agents 0`);
      return `Bearer ${((await res.json()) as { token: string }).token}`;
    }),
  );
  let polling = true;
  const pollers = agents.map(async (auth, i) => {
    await sleep((i * 5000) / Math.max(1, agents.length));
    while (polling) {
      for (const path of ['/inbox/conversations?status=WAITING_AGENT', '/inbox/conversations?status=AI_HANDLING']) {
        const t = Date.now();
        try {
          const r = await fetch(`${BASE}${path}`, { headers: { Authorization: auth } });
          if (!r.ok) pollErrors++;
          await r.arrayBuffer();
        } catch {
          pollErrors++;
        }
        poll.push(Date.now() - t);
      }
      await sleep(5000);
    }
  });

  const push = async (customer: number, n: number) => {
    const body = JSON.stringify({
      events: [{ id: `${run}-${customer}-${n}`, accountId: account.id, kind: 'dm', userId: `${run}-${customer}`, nickname: `lt-客户${customer}`, text: QUESTIONS[(customer + n) % QUESTIONS.length] }],
    });
    const t = Date.now();
    try {
      const r = await fetch(`${BASE}/inbox/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hsj-Signature': createHmac('sha256', SECRET).update(body).digest('hex') }, body });
      if (!r.ok) hookErrors++;
      await r.arrayBuffer();
    } catch {
      hookErrors++;
    }
    hook.push(Date.now() - t);
    sent++;
  };

  // 按速率发：每位新客户发第 1 条，之后每隔 GAP_S 秒再发一条
  const total = Math.round(RATE * MINUTES * 60);
  const pending: Promise<void>[] = [];
  let customer = 0;
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    await sleep(Math.max(0, t0 + (i * 1000) / RATE - Date.now()));
    const slot = i % PER_CUSTOMER;
    if (slot === 0) customer++;
    const c = customer;
    pending.push(sleep(slot * GAP_S * 1000).then(() => push(c, slot)));
  }
  await Promise.all(pending);
  const pushEnd = Date.now();

  // 等队列处理完
  let left = 0;
  for (const deadline = Date.now() + DRAIN_S * 1000; Date.now() < deadline; await sleep(2000)) {
    left = await prisma.inboundEvent.count({ where: { externalId: { startsWith: `api:${run}-` }, status: { not: 'done' } } });
    if (!left) break;
  }
  const drain = Date.now() - pushEnd;
  polling = false;
  await Promise.all(pollers);

  // AI 首条回复等待：从接口收到客户消息算起，到之后第一条 AI 回复或转人工提示
  const convs = await prisma.conversation.findMany({ where: { externalUserId: { startsWith: `${run}-` } }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
  const events = await prisma.inboundEvent.findMany({ where: { externalId: { startsWith: `api:${run}-` } }, select: { externalId: true, createdAt: true } });
  const receivedAt = new Map(events.map((e) => [e.externalId, e.createdAt.getTime()]));
  const replyWait: number[] = [];
  let unanswered = 0;
  let handoffs = 0;
  for (const c of convs) {
    if (c.handoffReason) handoffs++;
    c.messages.forEach((m, i) => {
      if (m.sender !== 'customer') return;
      const later = c.messages.slice(i + 1);
      const next = later.find((x) => x.sender === 'ai' || x.sender === 'system');
      const t = receivedAt.get(m.externalId ?? '') ?? m.createdAt.getTime();
      if (next) replyWait.push(next.createdAt.getTime() - t);
      // 转人工后的消息由客服回，不算漏回
      else if (c.status === 'AI_HANDLING' && !later.some((x) => x.sender === 'customer')) unanswered++;
    });
  }
  const failed = await prisma.inboundEvent.count({ where: { externalId: { startsWith: `api:${run}-` }, status: 'failed' } });
  const minutes = (Date.now() - started.getTime()) / 60000;

  const lines = [
    `## 压测结果 ${run}`,
    '',
    `- 场景：每秒 ${RATE} 条客户消息（每小时 ${Math.round(RATE * 3600)} 条），${customer} 位客户，${AGENTS} 名客服每 5 秒刷新，共 ${minutes.toFixed(1)} 分钟`,
    `- 推送：${sent} 条，接口出错 ${hookErrors} 条；耗时 p50 ${fmt(pct(hook, 50))}，p95 ${fmt(pct(hook, 95))}，p99 ${fmt(pct(hook, 99))}`,
    `- 客服刷新：${poll.length} 次，出错 ${pollErrors} 次；耗时 p50 ${fmt(pct(poll, 50))}，p95 ${fmt(pct(poll, 95))}`,
    `- AI 首条回复等待：p50 ${fmt(pct(replyWait, 50))}，p95 ${fmt(pct(replyWait, 95))}，最长 ${fmt(Math.max(...replyWait))}`,
    `- 推完后清空队列用了 ${fmt(drain)}；仍未处理 ${left} 条，处理失败 ${failed} 条，AI 接待中却没回的消息 ${unanswered} 条；转人工会话 ${handoffs} 个`,
    '',
    '跑完记得 `--cleanup` 删掉压测数据。',
  ];
  console.log(lines.join('\n'));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

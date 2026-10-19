import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InboxService, sign } from '../src/inbox/inbox.module';
import { TopicsService } from '../src/topics/topics.module';
import { NotifyService } from '../src/wecom/wecom.module';
import { bootApp, loginAs, prisma, resetDb } from './helpers';

const SECRET = 'test-webhook-secret';
const ALL_DAY = { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' };

describe('收件箱（M8）', () => {
  let app: INestApplication;
  let cs: string;
  let cs2: string;
  let biz: string;
  let ops: string;
  let acc: string;
  let inbox: InboxService;
  let notify: NotifyService;
  const http = () => request(app.getHttpServer());

  const settings = async (patch: object = {}) => {
    const s = (await http().get('/api/inbox/settings').set('Authorization', cs)).body;
    await prisma.setting.upsert({ where: { key: 'inbox' }, create: { key: 'inbox', value: { ...s, workHours: ALL_DAY, ...patch } }, update: { value: { ...s, workHours: ALL_DAY, ...patch } } });
  };
  const paste = (nickname: string, text: string, extra: object = {}) =>
    http().post('/api/inbox/manual').set('Authorization', cs).send({ accountId: acc, nickname, text, ...extra });

  beforeAll(async () => {
    process.env.INBOX_WEBHOOK_SECRET = SECRET;
    await resetDb();
    app = await bootApp();
    inbox = app.get(InboxService);
    notify = app.get(NotifyService);
    cs = await loginAs(app, 'kefu', ['CS']);
    cs2 = await loginAs(app, 'kefu2', ['CS']);
    biz = await loginAs(app, 'zhaoshang', ['BIZ']);
    ops = await loginAs(app, 'yunying', ['CONTENT']);
    acc = (await prisma.platformAccount.create({ data: { platform: 'XHS', name: '好时节果园', audience: 'C', externalId: 'xhs-001' } })).id;
    await prisma.faqItem.createMany({
      data: [
        { category: '保存方法', question: '无花果怎么保存', answer: '收到后冷藏 0–4℃，建议 3 天内吃完～' },
        { category: '配送范围', question: '发货到哪些城市', answer: '全国大部分城市顺丰冷链，偏远地区私信确认～' },
        { category: '营养', question: '无花果有什么功效', answer: '无花果能润肠通便哦' }, // 故意放一条不合规的答案
      ],
    });
    await prisma.riskWord.create({ data: { word: '润肠通便', category: '医疗功效', level: 'block' } });
    await settings();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    delete process.env.INBOX_WEBHOOK_SECRET;
  });

  it('客服贴入私信，AI 按 FAQ 回复，待复制发送；运营没有权限', async () => {
    await paste('小鹿', '你好').expect(201); // 先建会话
    await http().post('/api/inbox/manual').set('Authorization', ops).send({ accountId: acc, nickname: 'x', text: 'y' }).expect(403);
    const res = await paste('小鹿', '买回来的无花果要怎么保存呀？').expect(201);
    expect(res.body.status).toBe('AI_HANDLING');
    const ai = res.body.messages.filter((m: { sender: string }) => m.sender === 'ai').at(-1);
    expect(ai.text).toContain('冷藏');
    expect(ai.delivery).toBe('to_send');
    expect(ai.meta.matched).toBe(true);
    await http().patch(`/api/inbox/messages/${ai.id}/sent`).set('Authorization', cs).expect(200);
    await http().patch(`/api/inbox/messages/${ai.id}/sent`).set('Authorization', cs).expect(409);
  });

  it('客户要求人工 → 待人工，通知客服并生成客户摘要', async () => {
    const res = await paste('阿茶', '我要找人工客服').expect(201);
    expect(res.body.status).toBe('WAITING_AGENT');
    expect(res.body.handoffReason).toBe('客户要求人工');
    expect(res.body.summary).toContain('客户共发了');
    expect(res.body.messages.at(-1)).toMatchObject({ sender: 'system', text: expect.stringContaining('转人工') });
    expect(notify.sent.filter((n) => n.text.startsWith('【待人工】')).at(-1)!.to).toEqual(['kefu', 'kefu2']);
  });

  it('B 端谈代理 → 转人工并通知招商', async () => {
    const res = await paste('果商老王', '你们招代理吗，起订量多少').expect(201);
    expect(res.body.status).toBe('WAITING_AGENT');
    expect(res.body.audience).toBe('B');
    expect(notify.sent.filter((n) => n.text.startsWith('【待人工】')).at(-1)!.to.sort()).toEqual(['kefu', 'kefu2', 'zhaoshang']);
    // 谈合作是有效咨询：建 B 端线索，分给招商
    expect(notify.sent.at(-1)).toMatchObject({ to: ['zhaoshang'], text: expect.stringContaining('【新线索】B 端') });
  });

  it('AI 连续 2 轮答不上才转人工', async () => {
    let r = await paste('路人', '今天天气怎么样').expect(201);
    expect(r.body.status).toBe('AI_HANDLING');
    expect(r.body.unmatched).toBe(1);
    r = await paste('路人', '你们老板是谁').expect(201);
    expect(r.body.status).toBe('WAITING_AGENT');
    expect(r.body.handoffReason).toContain('连续 2 轮');
  });

  it('回复命中风控且重写后仍不合规 → 不发出，转人工', async () => {
    const r = await paste('健康控', '无花果有什么功效').expect(201);
    expect(r.body.status).toBe('WAITING_AGENT');
    expect(r.body.handoffReason).toContain('风控');
    const sent = r.body.messages.filter((m: { sender: string }) => m.sender === 'ai');
    expect(sent.map((m: { text: string }) => m.text).join()).not.toContain('润肠通便');
    expect(sent.at(-1).blockedText).toContain('润肠通便');
  });

  it('非工作时间转人工：告知上班时间并留资；超时只按工作时间计算', async () => {
    // 只有“明天”是工作日，现在一定是非工作时间
    const today = new Date(Date.now() + 8 * 3600_000).getUTCDay() || 7;
    await settings({ workHours: { days: [(today % 7) + 1], start: '09:00', end: '18:00' } });
    const r = await paste('夜猫子', '人工').expect(201);
    expect(r.body.messages.find((m: { sender: string }) => m.sender === 'ai').text).toContain('9:00–18:00');
    expect((await inbox.tick(new Date(Date.now() + 3600_000), true)).escalated).toBe(0);
    await settings();
  });

  it('工作时间内超过响应时限升级提醒，只提醒一次', async () => {
    const t = await inbox.tick(new Date(Date.now() + 6 * 60_000), true);
    expect(t.escalated).toBeGreaterThan(0);
    expect(notify.sent.at(-1)!.text).toContain('超时未接待');
    expect((await inbox.tick(new Date(Date.now() + 7 * 60_000), true)).escalated).toBe(0);
  });

  it('客服接管：发出前风控、不能抢别人的会话、交还 AI、标记已引流后客户再来消息重新由 AI 接待', async () => {
    const conv = await prisma.conversation.findFirstOrThrow({ where: { nickname: '阿茶' } });
    const claimed = await http().post(`/api/inbox/conversations/${conv.id}/claim`).set('Authorization', cs).expect(201);
    expect(claimed.body).toMatchObject({ status: 'AGENT_HANDLING', agent: { name: 'kefu' } });
    await http().post(`/api/inbox/conversations/${conv.id}/claim`).set('Authorization', cs2).expect(409);
    await http().post(`/api/inbox/conversations/${conv.id}/messages`).set('Authorization', cs2).send({ text: '你好' }).expect(409);
    const blocked = await http().post(`/api/inbox/conversations/${conv.id}/messages`).set('Authorization', cs).send({ text: '多吃能润肠通便' }).expect(409);
    expect(blocked.body.message).toContain('润肠通便');
    const ok = await http().post(`/api/inbox/conversations/${conv.id}/messages`).set('Authorization', cs).send({ text: '你好，我是客服小林，请问想了解哪款？' }).expect(201);
    expect(ok.body.messages.at(-1)).toMatchObject({ sender: 'agent', authorName: 'kefu', delivery: 'to_send' });

    const s = await http().post(`/api/inbox/conversations/${conv.id}/summary`).set('Authorization', cs).expect(201);
    expect(s.body.summary).toBeTruthy();
    expect(s.body.suggestedReply).toBeTruthy();

    await http().post(`/api/inbox/conversations/${conv.id}/status`).set('Authorization', cs).send({ status: 'DIVERTED' }).expect(201);
    const again = await paste('阿茶', '发货到哪些城市').expect(201);
    expect(again.body.status).toBe('AI_HANDLING');
    expect(again.body.messages.at(-1).text).toContain('顺丰冷链');

    const list = await http().get('/api/inbox/conversations?status=WAITING_AGENT').set('Authorization', biz).expect(200);
    expect(list.body.items.every((c: { status: string }) => c.status === 'WAITING_AGENT')).toBe(true);
    expect(list.body.counts.WAITING_AGENT).toBe(list.body.items.length);
  });

  it('实时接入：校验签名、重复推送只处理一次、找不到账号的消息记为失败待重试', async () => {
    const body = JSON.stringify({ events: [{ id: 'm-1', accountId: 'xhs-001', userId: 'u-9', nickname: '远方', text: '发货到哪些城市', kind: 'comment', postUrl: 'https://www.xiaohongshu.com/explore/abc' }] });
    await http().post('/api/inbox/webhook').set('Content-Type', 'application/json').set('X-Hsj-Signature', 'bad').send(body).expect(401);
    const ok = await http().post('/api/inbox/webhook').set('Content-Type', 'application/json').set('X-Hsj-Signature', sign(SECRET, body)).send(body).expect(201);
    expect(ok.body).toEqual({ received: 1, accepted: 1 });
    const dup = await http().post('/api/inbox/webhook').set('Content-Type', 'application/json').set('X-Hsj-Signature', sign(SECRET, body)).send(body).expect(201);
    expect(dup.body.accepted).toBe(0);
    await inbox.idle();
    const conv = await prisma.conversation.findFirstOrThrow({ where: { externalUserId: 'comment:u-9' }, include: { messages: true } });
    expect(conv.kind).toBe('comment');
    expect(conv.sourcePostUrl).toContain('explore/abc');
    expect(conv.messages.filter((m) => m.sender === 'customer')).toHaveLength(1);
    expect(conv.messages.find((m) => m.sender === 'ai')!.text).toContain('私信我');

    const bad = JSON.stringify({ events: [{ id: 'm-2', accountId: 'nope', userId: 'u-1', text: '在吗' }] });
    await http().post('/api/inbox/webhook').set('Content-Type', 'application/json').set('X-Hsj-Signature', sign(SECRET, bad)).send(bad).expect(201);
    await inbox.idle();
    const ev = await prisma.inboundEvent.findUniqueOrThrow({ where: { externalId: 'api:m-2' } });
    expect(ev).toMatchObject({ status: 'failed', attempts: 1 });
    await prisma.platformAccount.create({ data: { platform: 'XHS', name: '好时节批发', audience: 'B', externalId: 'nope', inboxMode: 'api' } });
    await prisma.inboundEvent.update({ where: { id: ev.id }, data: { createdAt: new Date(Date.now() - 120_000) } });
    await inbox.tick(new Date(), true);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('done');
    // api 模式账号没配置服务商发送接口 → 回复标记发送失败，客服可以手动补发
    const m = await prisma.message.findFirstOrThrow({ where: { sender: 'ai', conversation: { externalUserId: 'u-1' } } });
    expect(m.delivery).toBe('failed');
  });

  it('AI 回复命中的 FAQ 计入每周选题的“私信高频问题”', async () => {
    const hot = await app.get(TopicsService).hotQuestions();
    expect(hot[0]).toEqual({ question: '发货到哪些城市', count: expect.any(Number) });
    expect(hot.map((h) => h.question)).toContain('无花果怎么保存');
  });
});

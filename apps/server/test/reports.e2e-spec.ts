import { INestApplication } from '@nestjs/common';
import JSZip from 'jszip';
import request from 'supertest';
import { ReportsService } from '../src/reports/reports.service';
import { NotifyService } from '../src/wecom/wecom.module';
import { bootApp, loginAs, prisma, resetDb } from './helpers';

const ALL_DAY = { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' };
/** 北京时间 */
const at = (s: string) => new Date(`${s}+08:00`);
const WEEK = { from: '2026-10-12', to: '2026-10-18' };

describe('数据周报（M12）', () => {
  let app: INestApplication;
  let admin: string;
  let viewer: string;
  let ops: string;
  let accC: string;
  let accB: string;
  let agentId: string;
  const http = () => request(app.getHttpServer());
  const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

  async function post(title: string, category: string, audience: 'C' | 'B', accountId: string, publishedAt: string, noteId: string, m: [number, number, number, number] | null) {
    const topic = await prisma.topic.create({ data: { title, audience, category, platforms: ['XHS'] } });
    const draft = await prisma.draft.create({ data: { topicId: topic.id, platform: 'XHS' } });
    await prisma.draftVersion.create({ data: { draftId: draft.id, index: 1, title: `${title}｜成稿`, body: '正文', tags: [], imageTips: [], chosen: true } });
    const [reads, likes, saves, comments] = m ?? [null, null, null, null];
    return prisma.scheduleItem.create({
      data: { draftId: draft.id, accountId, publishAt: at(publishedAt), publishedAt: at(publishedAt), postUrl: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=a`, reads, likes, saves, comments },
    });
  }
  async function conv(accountId: string, user: string, audience: 'C' | 'B' | null, postNote: string | null, msgs: [string, string, string?, object?][]) {
    const c = await prisma.conversation.create({ data: { accountId, externalUserId: user, nickname: user, audience, sourcePostUrl: postNote ? `https://www.xiaohongshu.com/explore/${postNote}?share=1` : null } });
    for (const [sender, time, text, meta] of msgs) {
      await prisma.message.create({ data: { conversationId: c.id, sender, text: text ?? '你好', createdAt: at(time), authorId: sender === 'agent' ? agentId : null, meta: meta as object | undefined } });
    }
    return c;
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootApp();
    admin = await loginAs(app, 'guanli', ['ADMIN']);
    viewer = await loginAs(app, 'laoban', ['VIEWER']);
    ops = await loginAs(app, 'yunying', ['CONTENT']);
    await loginAs(app, 'kefu', ['CS']);
    agentId = (await prisma.user.findUniqueOrThrow({ where: { wecomId: 'kefu' } })).id;
    await prisma.setting.create({ data: { key: 'inbox', value: { workHours: ALL_DAY } } });
    accC = (await prisma.platformAccount.create({ data: { platform: 'XHS', name: '好时节果园', audience: 'C' } })).id;
    accB = (await prisma.platformAccount.create({ data: { platform: 'XHS', name: '好时节批发', audience: 'B' } })).id;
    const faq = await prisma.faqItem.create({ data: { category: '品种', question: '品种有什么区别', answer: '……' } });

    // 本周 3 篇（1 篇没回填数据），上周 1 篇
    const NOTE = (n: number) => `66f1a2b3c4d5e6f7a8b9c0d${n}`;
    await post('三种无花果盲盒开箱', '开箱', 'C', accC, '2026-10-13T19:30:00', NOTE(1), [6000, 400, 150, 50]);
    await post('无花果到手怎么存', '储存食用', 'C', accC, '2026-10-15T12:00:00', NOTE(2), null);
    await post('果商看过来：稳定货源', '错峰空档', 'B', accB, '2026-10-17T10:00:00', NOTE(3), [2000, 40, 20, 20]);
    await post('上周的作品', '开箱', 'C', accC, '2026-10-08T10:00:00', NOTE(4), [1000, 10, 10, 10]);

    // 咨询：小满两天都发了消息（算 2 次），同一天两条算 1 次；阿杰是 B 端
    await conv(accC, '小满', 'C', NOTE(1), [
      ['customer', '2026-10-13T20:00:00'],
      ['ai', '2026-10-13T20:00:05', '一盒三个品种', { matched: true, faqIds: [faq.id] }],
      ['customer', '2026-10-13T20:05:00'],
      ['customer', '2026-10-14T09:00:00'],
      ['ai', '2026-10-14T09:00:05', '好的', { matched: true, faqIds: [faq.id] }],
    ]);
    await conv(accB, '阿杰', 'B', NOTE(3), [
      ['customer', '2026-10-17T11:00:00', '起订量多少'],
      ['ai', '2026-10-17T11:00:05', '马上请招商联系您'],
      ['system', '2026-10-17T11:00:06', '转人工：B 端高意向（询价、起订量、代理合作）'],
      ['agent', '2026-10-17T11:04:06', '您好，我是招商'],
    ]);
    await conv(accC, 'momo', null, null, [
      ['customer', '2026-10-18T10:00:00', '压坏了'],
      ['system', '2026-10-18T10:00:06', '转人工：投诉、售后或情绪负面（非工作时间，上班后处理）'],
      ['agent', '2026-10-18T10:10:06', '抱歉'],
    ]);
    await conv(accC, '上周的人', 'C', null, [['customer', '2026-10-09T10:00:00']]);

    // 线索：C 端 2 条（1 条加微、1 条成交），B 端 1 条
    await prisma.lead.create({ data: { audience: 'C', intent: 'high', intentDetail: { scene: '送礼' }, status: 'ADDED_WECOM', sourcePlatform: 'XHS', sourceAccount: '好时节果园', sourcePostUrl: `https://www.xiaohongshu.com/explore/${NOTE(1)}`, createdAt: at('2026-10-13T20:10:00') } });
    const l2 = await prisma.lead.create({ data: { audience: 'C', intent: 'medium', intentDetail: { scene: '自吃' }, status: 'WON', sourcePlatform: 'XHS', sourceAccount: '好时节果园', sourcePostUrl: `https://www.xiaohongshu.com/explore/${NOTE(1)}`, createdAt: at('2026-10-14T09:10:00') } });
    await prisma.wecomContact.create({ data: { externalUserId: 'wm-1', staffId: 'kefu', leadId: l2.id, addedAt: at('2026-10-14T10:00:00') } });
    await prisma.lead.create({ data: { audience: 'B', intent: 'high', intentDetail: { channel: '水果店', city: '成都' }, sourcePlatform: 'XHS', sourceAccount: '好时节批发', sourcePostUrl: `https://www.xiaohongshu.com/explore/${NOTE(3)}`, createdAt: at('2026-10-17T11:10:00') } });
    await prisma.lead.create({ data: { audience: 'C', createdAt: at('2026-10-09T11:00:00') } });
    await prisma.order.createMany({
      data: [
        { tool: 'ktt', externalNo: 'K1', leadId: l2.id, audience: 'C', amountCents: 25600, orderedAt: at('2026-10-15T12:00:00'), attrPlatform: 'XHS', attrAccount: '好时节果园' },
        { tool: 'ktt', externalNo: 'K2', leadId: l2.id, audience: 'C', amountCents: 9900, isRepeat: true, orderedAt: at('2026-10-16T12:00:00'), attrPlatform: 'XHS', attrAccount: '好时节果园' },
        { tool: 'ktt', externalNo: 'K3', audience: 'C', amountCents: 9900, cancelled: true, orderedAt: at('2026-10-16T13:00:00') },
        { tool: 'ktt', externalNo: 'K0', audience: 'C', amountCents: 12800, orderedAt: at('2026-10-10T12:00:00') },
      ],
    });
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('看板：发布、阅读、咨询、线索、成交按 PRD 口径计算，附上期环比', async () => {
    await http().get(`/api/reports/dashboard?${qs({ from: '2026-10-18', to: '2026-10-12' })}`).set('Authorization', viewer).expect(400);
    const r = (await http().get(`/api/reports/dashboard?${qs(WEEK)}`).set('Authorization', viewer).expect(200)).body;
    expect(r.kpi).toEqual({ posts: 3, reads: 8000, consults: 4, leads: 3, leadsC: 2, leadsB: 1, dealCents: 35500 });
    expect(r.prev).toMatchObject({ from: '2026-10-05', to: '2026-10-11', kpi: { posts: 1, reads: 1000, consults: 1, leads: 1, dealCents: 12800 } });

    const c = r.funnel.find((f: { audience: string }) => f.audience === 'C').steps.map((s: { value: number }) => s.value);
    const b = r.funnel.find((f: { audience: string }) => f.audience === 'B').steps.map((s: { value: number }) => s.value);
    expect(c).toEqual([6000, 3, 2, 2, 1]);
    expect(b).toEqual([2000, 1, 1, 0, 0]);
  });

  it('内容：作品排行带互动率和带来的咨询、线索；按选题类别和平台汇总；标出没回填数据的作品', async () => {
    const r = (await http().get(`/api/reports/dashboard?${qs(WEEK)}`).set('Authorization', ops).expect(200)).body;
    expect(r.content.top[0]).toMatchObject({ title: '三种无花果盲盒开箱｜成稿', category: '开箱', reads: 6000, rate: 10, consults: 1, leads: 2 });
    expect(r.content.unfilled).toBe(1);
    expect(r.content.byCategory.find((x: { name: string }) => x.name === '错峰空档')).toMatchObject({ posts: 1, reads: 2000, rate: 4, consults: 1, leads: 1 });
    expect(r.content.byPlatform).toEqual([expect.objectContaining({ name: '小红书', posts: 3, reads: 8000 })]);
  });

  it('客服：咨询按天、自动回复、转人工率和原因、首响按工作时间、高频问题', async () => {
    const r = (await http().get(`/api/reports/dashboard?${qs(WEEK)}`).set('Authorization', viewer).expect(200)).body;
    const s = r.service;
    expect(s.daily).toHaveLength(7);
    expect(s.daily.find((d: { date: string }) => d.date === '2026-10-13')).toMatchObject({ consults: 1, posts: 1 });
    expect(s).toMatchObject({ conversations: 3, aiReplies: 3, aiOnly: 1, handoffs: 2, handoffRate: 66.7, firstResponse: 7, firstResponseCount: 2 });
    expect(s.reasons.map((x: { reason: string }) => x.reason).sort()).toEqual(['B 端高意向（询价、起订量、代理合作）', '投诉、售后或情绪负面']);
    expect(s.byAgent).toEqual([{ name: 'kefu', count: 2, avg: 7 }]);
    expect(s.topQuestions).toEqual([{ question: '品种有什么区别', count: 2 }]);
  });

  it('客资：C/B 分列的加微率、成交率、成交金额、复购，来源渠道和意向分布；按账号筛选', async () => {
    const r = (await http().get(`/api/reports/dashboard?${qs(WEEK)}`).set('Authorization', viewer).expect(200)).body;
    expect(r.leads.C).toMatchObject({ new: 2, wecom: 2, won: 1, wecomRate: 100, wonRate: 50, orders: 2, repeat: 1, dealCents: 35500, intent: { high: 1, medium: 1 } });
    expect(r.leads.C.scene).toEqual(expect.arrayContaining([{ name: '送礼', count: 1 }, { name: '自吃', count: 1 }]));
    expect(r.leads.C.sources).toEqual([{ name: '小红书 · 好时节果园', count: 2 }]);
    expect(r.leads.C.categories).toEqual([{ name: '开箱', count: 2 }]);
    expect(r.leads.B).toMatchObject({ new: 1, channel: [{ name: '水果店', count: 1 }], city: [{ name: '成都', count: 1 }] });

    const onlyB = (await http().get(`/api/reports/dashboard?${qs({ ...WEEK, accountId: accB })}`).set('Authorization', viewer).expect(200)).body;
    expect(onlyB.kpi).toMatchObject({ posts: 1, reads: 2000, consults: 1, leads: 1, dealCents: 0 });
  });

  it('周报：取上周一到周日，AI 写解读，存快照并推送企业微信', async () => {
    const reports = app.get(ReportsService);
    expect(reports.lastPeriod('week', at('2026-10-19T09:00:00'))).toEqual(WEEK);
    expect(reports.lastPeriod('week', at('2026-10-25T23:00:00'))).toEqual(WEEK);
    expect(reports.lastPeriod('month', at('2026-11-01T09:00:00'))).toEqual({ from: '2026-10-01', to: '2026-10-31' });

    await http().post('/api/reports/generate').set('Authorization', viewer).send({ kind: 'week' }).expect(403);
    const notify = app.get(NotifyService);
    const r = (await http().post('/api/reports/generate').set('Authorization', admin).send({ kind: 'week', ...WEEK, push: true }).expect(201)).body;
    expect(r).toMatchObject({ kind: 'week', from: '2026-10-12', to: '2026-10-18' });
    expect(r.insight.highlights[0]).toContain('三种无花果盲盒开箱');
    expect(r.pushedAt).toBeNull(); // 返回的是推送前的快照
    const msg = notify.sent.at(-1)!;
    expect(msg.to.sort()).toEqual(['guanli', 'laoban', 'yunying']);
    expect(msg.text).toContain('【周报】10/12–10/18');
    expect(msg.text).toContain('成交 ¥355');
    expect(msg.text).toContain(`/overview?report=${r.id}`);

    // 重新生成同一期是覆盖，不会多一条
    await http().post('/api/reports/generate').set('Authorization', admin).send({ kind: 'week', ...WEEK }).expect(201);
    const list = (await http().get('/api/reports').set('Authorization', viewer).expect(200)).body;
    expect(list).toHaveLength(1);
    const one = (await http().get(`/api/reports/${list[0].id}`).set('Authorization', viewer).expect(200)).body;
    expect(one.data.kpi.posts).toBe(3);
    expect(one.pushedAt).toBeTruthy();
  });

  it('明细导出 Excel：管理员多一张脱敏的线索表，记导出日志', async () => {
    const sheetNames = async (auth: string) => {
      const res = await http().get(`/api/reports/export?${qs(WEEK)}`).set('Authorization', auth).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      const zip = await JSZip.loadAsync(res.body as Buffer);
      const wb = await zip.file('xl/workbook.xml')!.async('string');
      return { names: [...wb.matchAll(/name="([^"]+)"/g)].map((m) => m[1]), zip };
    };
    expect((await sheetNames(viewer)).names).toEqual(['汇总', '作品', '会话']);
    const { names, zip } = await sheetNames(admin);
    expect(names).toEqual(['汇总', '作品', '会话', '线索']);
    const works = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
    expect(works).toContain('未回填');
    expect(works).toContain('三种无花果盲盒开箱｜成稿');
    const logs = await prisma.auditLog.findMany({ where: { action: 'report.export' } });
    expect(logs).toHaveLength(2);
  });
});

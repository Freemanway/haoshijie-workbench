import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ScheduleService } from '../src/schedule/schedule.module';
import { NotifyService } from '../src/wecom/wecom.module';
import { bootApp, loginAs, prisma, resetDb } from './helpers';

const HOUR = 3600_000;

async function makeDraft(title: string, body = '果肉红润，甜度很高，冷藏后口感更好。') {
  const topic = await prisma.topic.create({ data: { title, audience: 'C', category: '产地纪实', platforms: ['XHS'] } });
  const draft = await prisma.draft.create({ data: { topicId: topic.id, platform: 'XHS' } });
  const v = await prisma.draftVersion.create({ data: { draftId: draft.id, index: 1, title, body, tags: ['无花果', '水果', '产地'], imageTips: ['果园全景'], chosen: true } });
  return { topic, draft, v };
}

describe('稿件审核（M6）', () => {
  let app: INestApplication;
  let ops: string;
  let reviewer: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await resetDb();
    app = await bootApp();
    ops = await loginAs(app, 'yunying', ['CONTENT']);
    reviewer = await loginAs(app, 'shenhe', ['REVIEWER']);
    await prisma.riskWord.create({ data: { word: '润肠通便', category: '医疗功效', level: 'block' } });
  });
  afterAll(() => app.close());

  it('含拦截词不能提交；提交后通知审核人，驳回必须写原因并通知运营', async () => {
    const { draft, v } = await makeDraft('无花果怎么挑', '每天两个润肠通便');
    await http().post(`/api/drafts/${draft.id}/submit`).set('Authorization', ops).expect(409);
    await http().patch(`/api/drafts/${draft.id}/versions/${v.id}`).set('Authorization', ops).send({ title: v.title, body: '富含膳食纤维', tags: v.tags }).expect(200);

    const notify = app.get(NotifyService);
    await http().post(`/api/drafts/${draft.id}/submit`).set('Authorization', reviewer).expect(403);
    await http().post(`/api/drafts/${draft.id}/submit`).set('Authorization', ops).expect(201);
    expect(notify.sent.at(-1)).toEqual({ to: ['shenhe'], text: expect.stringContaining('待审核') });

    await http().post(`/api/drafts/${draft.id}/reject`).set('Authorization', reviewer).send({ reason: '' }).expect(400);
    await http().post(`/api/drafts/${draft.id}/reject`).set('Authorization', reviewer).send({ reason: '开头不够吸引人' }).expect(201);
    expect(notify.sent.at(-1)!.to).toEqual(['yunying']);
    const d = (await http().get(`/api/drafts/${draft.id}`).set('Authorization', ops)).body;
    expect(d.status).toBe('REJECTED');
    expect(d.rejectReason).toBe('开头不够吸引人');
    expect(d.reviews.map((r: { action: string }) => r.action)).toEqual(['reject', 'submit']);
  });

  it('审核人可以批注、直接修改（留下前后对比），再通过；撤回只针对待审核', async () => {
    const draft = await prisma.draft.findFirstOrThrow();
    await http().post(`/api/drafts/${draft.id}/withdraw`).set('Authorization', ops).expect(409);
    await http().post(`/api/drafts/${draft.id}/submit`).set('Authorization', ops).expect(201);
    await http().post(`/api/drafts/${draft.id}/comments`).set('Authorization', reviewer).send({ note: '标题可以更口语' }).expect(201);
    const chosen = await prisma.draftVersion.findFirstOrThrow({ where: { draftId: draft.id, chosen: true } });
    await http().patch(`/api/drafts/${draft.id}/versions/${chosen.id}`).set('Authorization', reviewer).send({ title: 'x', body: 'y', tags: [] }).expect(403);
    await http()
      .patch(`/api/drafts/${draft.id}/review-versions/${chosen.id}`)
      .set('Authorization', reviewer)
      .send({ title: '无花果这样挑才甜', body: chosen.body, tags: chosen.tags })
      .expect(200);
    const logs = (await http().get(`/api/drafts/${draft.id}/reviews`).set('Authorization', ops).expect(200)).body;
    const edit = logs.find((l: { action: string }) => l.action === 'edit');
    expect(edit.before).toContain('无花果怎么挑');
    expect(edit.after).toContain('无花果这样挑才甜');
    await http().post(`/api/drafts/${draft.id}/approve`).set('Authorization', reviewer).send({}).expect(201);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('APPROVED');
  });

  it('批量通过逐篇返回结果', async () => {
    const a = await makeDraft('批量一');
    const b = await makeDraft('批量二');
    await http().post(`/api/drafts/${a.draft.id}/submit`).set('Authorization', ops).expect(201);
    const res = await http().post('/api/drafts/batch-approve').set('Authorization', reviewer).send({ ids: [a.draft.id, b.draft.id] }).expect(201);
    expect(res.body.approved).toBe(1);
    expect(res.body.results.find((r: { id: string }) => r.id === a.draft.id).ok).toBe(true);
    expect(res.body.results.find((r: { id: string }) => r.id === b.draft.id).reason).toContain("待审核");
  });
});

describe('排期与发布（M7）', () => {
  let app: INestApplication;
  let ops: string;
  let viewer: string;
  let acc1: string;
  let acc2: string;
  const http = () => request(app.getHttpServer());
  const at = new Date(Date.now() + 2 * 24 * HOUR);

  beforeAll(async () => {
    await resetDb();
    app = await bootApp();
    ops = await loginAs(app, 'yunying', ['CONTENT']);
    viewer = await loginAs(app, 'laoban', ['VIEWER']);
    acc1 = (await prisma.platformAccount.create({ data: { platform: 'XHS', name: '好时节果园', audience: 'C', dailyPostCap: 1 } })).id;
    acc2 = (await prisma.platformAccount.create({ data: { platform: 'XHS', name: '好时节批发', audience: 'B' } })).id;
    await prisma.asset.create({ data: { title: '坏链接', url: 'ftp://nope', kind: 'image', tags: ['产地纪实'] } });
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('只有审核通过的稿件能排期；多账号给出差异化提醒；每日上限生效', async () => {
    const a = await makeDraft('排期一');
    await http().post('/api/schedule').set('Authorization', ops).send({ draftId: a.draft.id, accountIds: [acc1], publishAt: at }).expect(409);
    await prisma.draft.update({ where: { id: a.draft.id }, data: { status: 'APPROVED' } });
    await http().post('/api/schedule').set('Authorization', viewer).send({ draftId: a.draft.id, accountIds: [acc1], publishAt: at }).expect(403);
    const res = await http().post('/api/schedule').set('Authorization', ops).send({ draftId: a.draft.id, accountIds: [acc1, acc2], publishAt: at }).expect(201);
    expect(res.body.warning).toContain('2 个账号');
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: a.draft.id } })).status).toBe('SCHEDULED');
    expect((await prisma.topic.findUniqueOrThrow({ where: { id: a.topic.id } })).status).toBe('SCHEDULED');

    const b = await makeDraft('排期二');
    await prisma.draft.update({ where: { id: b.draft.id }, data: { status: 'APPROVED' } });
    const capped = await http().post('/api/schedule').set('Authorization', ops).send({ draftId: b.draft.id, accountIds: [acc1], publishAt: at }).expect(409);
    expect(capped.body.message).toContain('每日上限 1 篇');
    await http().post('/api/schedule').set('Authorization', ops).send({ draftId: b.draft.id, accountIds: [acc1], publishAt: new Date(at.getTime() + 24 * HOUR) }).expect(201);

    const list = await http().get(`/api/schedule?from=${new Date(Date.now()).toISOString()}&to=${new Date(Date.now() + 7 * 24 * HOUR).toISOString()}`).set('Authorization', viewer).expect(200);
    expect(list.body).toHaveLength(3);
    expect(list.body[0].draft.version.title).toBe('排期一');
  });

  it('拖拽改期也受上限约束；删掉最后一条排期稿件回到已通过', async () => {
    const b = await prisma.scheduleItem.findFirstOrThrow({ where: { draft: { topic: { title: '排期二' } } } });
    await http().patch(`/api/schedule/${b.id}`).set('Authorization', ops).send({ publishAt: at }).expect(409);
    await http().patch(`/api/schedule/${b.id}`).set('Authorization', ops).send({ accountId: acc2 }).expect(200);
    await http().delete(`/api/schedule/${b.id}`).set('Authorization', ops).expect(200);
    const d = await prisma.draft.findUniqueOrThrow({ where: { id: b.draftId }, include: { topic: true } });
    expect(d.status).toBe('APPROVED');
    expect(d.topic.status).toBe('IDLE');
  });

  it('到点提醒运营且只提醒一次；今日待发列出过点未发的', async () => {
    const item = await prisma.scheduleItem.findFirstOrThrow({ where: { accountId: acc1 } });
    await prisma.scheduleItem.update({ where: { id: item.id }, data: { publishAt: new Date(Date.now() - HOUR) } });
    const svc = app.get(ScheduleService);
    expect(await svc.remindDue()).toBe(0); // 测试环境关闭了定时任务
    expect(await svc.remindDue(new Date(), true)).toBe(1);
    expect(await svc.remindDue(new Date(), true)).toBe(0);
    expect(app.get(NotifyService).sent.at(-1)).toEqual({ to: ['yunying'], text: expect.stringContaining('【到点发布】好时节果园') });
    const today = (await http().get('/api/schedule/today').set('Authorization', ops).expect(200)).body;
    expect(today.map((i: { id: string }) => i.id)).toEqual([item.id]);
  });

  it('素材包包含文案和配图建议，下载不到的素材单独列出', async () => {
    const item = await prisma.scheduleItem.findFirstOrThrow({ where: { accountId: acc1 } });
    const res = await http()
      .get(`/api/schedule/${item.id}/package`)
      .set('Authorization', ops)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(res.body as Buffer);
    expect(Object.keys(zip.files).sort()).toEqual(['完整文案.txt', '未能下载的素材.txt', '标题.txt', '正文.txt', '话题.txt', '配图建议.txt'].sort());
    expect(await zip.file('完整文案.txt')!.async('string')).toContain('#无花果 #水果 #产地');
  });

  it('回填链接后全部账号发完才算已发布；失败可改期重来；数据按 24 小时、7 天回填', async () => {
    const items = await prisma.scheduleItem.findMany({ where: { draft: { topic: { title: '排期一' } } }, orderBy: { accountId: 'asc' } });
    const [one, two] = items;
    await http().post(`/api/schedule/${one.id}/metrics`).set('Authorization', ops).send({ checkpoint: '24h', reads: 1, likes: 1, saves: 1, comments: 1 }).expect(409);
    await http().post(`/api/schedule/${one.id}/publish`).set('Authorization', ops).send({ postUrl: 'xhs' }).expect(400);
    await http().post(`/api/schedule/${one.id}/publish`).set('Authorization', ops).send({ postUrl: 'https://www.xiaohongshu.com/explore/abc' }).expect(201);
    let d = await prisma.draft.findFirstOrThrow({ where: { id: one.draftId }, include: { topic: true } });
    expect(d.status).toBe('SCHEDULED');
    expect(d.topic.status).toBe('PUBLISHED');

    await http().post(`/api/schedule/${two.id}/fail`).set('Authorization', ops).send({ reason: '平台审核不通过' }).expect(201);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: one.draftId } })).status).toBe('PUBLISH_FAILED');
    await http().patch(`/api/schedule/${two.id}`).set('Authorization', ops).send({ publishAt: new Date(at.getTime() + 3 * 24 * HOUR) }).expect(200);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: one.draftId } })).status).toBe('SCHEDULED');
    await http().post(`/api/schedule/${two.id}/publish`).set('Authorization', ops).send({ postUrl: 'https://www.xiaohongshu.com/explore/def' }).expect(201);
    d = await prisma.draft.findFirstOrThrow({ where: { id: one.draftId }, include: { topic: true } });
    expect(d.status).toBe('PUBLISHED');

    // 假装 8 天前发的
    await prisma.scheduleItem.update({ where: { id: one.id }, data: { publishedAt: new Date(Date.now() - 8 * 24 * HOUR) } });
    const svc = app.get(ScheduleService);
    expect(await svc.remindMetrics(new Date(), true)).toBe(2); // 24h + 7d
    expect(await svc.remindMetrics(new Date(), true)).toBe(0);
    const due = (await http().get('/api/schedule/metrics-due').set('Authorization', ops).expect(200)).body;
    expect(due).toHaveLength(1);
    expect(due[0].due).toEqual(['24h', '7d']);

    await http().post(`/api/schedule/${one.id}/metrics`).set('Authorization', ops).send({ checkpoint: '24h', reads: 500, likes: 30, saves: 12, comments: 4 }).expect(201);
    const r = await http().post(`/api/schedule/${one.id}/metrics`).set('Authorization', ops).send({ checkpoint: '7d', reads: 2100, likes: 88, saves: 40, comments: 9 }).expect(201);
    expect(r.body.reads).toBe(2100);
    expect(r.body.metrics).toHaveLength(2);
    // 再改 24 小时数据，主表仍以 7 天为准
    const r2 = await http().post(`/api/schedule/${one.id}/metrics`).set('Authorization', ops).send({ checkpoint: '24h', reads: 600, likes: 30, saves: 12, comments: 4 }).expect(201);
    expect(r2.body.reads).toBe(2100);
    expect((await http().get('/api/schedule/metrics-due').set('Authorization', ops)).body).toHaveLength(0);
  });
});

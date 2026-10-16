import { INestApplication } from '@nestjs/common';
import { nextMonday } from '@hsj/shared';
import request from 'supertest';
import { z } from 'zod';
import { AiService, extractJson } from '../src/ai/ai.module';
import { DraftsService } from '../src/drafts/drafts.module';
import { bootApp, loginAs, prisma, resetDb } from './helpers';

describe('模型网关（M4-1）', () => {
  let app: INestApplication;
  beforeAll(async () => {
    await resetDb();
    app = await bootApp();
  });
  afterAll(() => app.close());

  it('能从代码块里取出 JSON', () => {
    expect(extractJson('好的：\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson('没有 JSON')).toThrow();
  });

  it('输出不合格时带上问题重试一次，每次调用都留痕', async () => {
    let n = 0;
    const tpl = {
      name: 'test_retry',
      version: 3,
      temperature: 0,
      system: 's',
      user: () => 'u',
      output: z.object({ title: z.string() }),
      mock: () => ({ title: n++ === 0 ? '太长太长太长' : '短' }),
    };
    const res = await app.get(AiService).run(tpl, {}, { refType: 'x', refId: '1', check: (o) => ((o as { title: string }).title.length > 3 ? ['标题太长'] : []) });
    expect(res.output.title).toBe('短');
    const calls = await prisma.llmCall.findMany({ where: { refType: 'x', refId: '1' }, orderBy: { createdAt: 'asc' } });
    expect(calls).toHaveLength(2);
    expect(calls[0].template).toBe('test_retry@3');
    expect(calls[0].error).toContain('标题太长');
    expect(calls[1].ok).toBe(true);
  });
});

describe('选题清单与稿件生成（M3、M4）', () => {
  let app: INestApplication;
  let ops: string;
  let reviewer: string;
  let cs: string;
  const weekOf = nextMonday();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await resetDb();
    app = await bootApp();
    ops = await loginAs(app, 'yunying', ['CONTENT']);
    reviewer = await loginAs(app, 'shenhe', ['REVIEWER']);
    cs = await loginAs(app, 'kefu', ['CS']);
    await prisma.knowledgeItem.create({ data: { kind: 'variety', title: '波姬红', content: '果皮紫红，果肉红润，甜度高' } });
    await prisma.knowledgeItem.create({ data: { kind: 'compliance', title: '润肠通便', content: '改为：富含膳食纤维' } });
    await prisma.riskWord.create({ data: { word: '润肠通便', category: '医疗功效', level: 'block' } });
    await prisma.asset.create({ data: { title: '果园清晨', url: 'https://example.com/a.jpg', kind: 'image', tags: ['产地纪实', '果园'] } });
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('首次读取时写入预置类别：C 端 6 类、B 端 5 类', async () => {
    const res = await http().get('/api/topics/categories').set('Authorization', cs).expect(200);
    expect(res.body.filter((c: { audience: string }) => c.audience === 'C')).toHaveLength(6);
    expect(res.body.filter((c: { audience: string }) => c.audience === 'B')).toHaveLength(5);
    await http().post('/api/topics/categories').set('Authorization', ops).send({ audience: 'C', name: '开箱' }).expect(409);
  });

  it('按配额和 C/B 比例生成下周清单，只有运营能生成', async () => {
    await http().put('/api/topics/settings').set('Authorization', ops).send({ weeklyQuota: { XHS: 5 }, cRatio: 0.8, seasonNodes: [], autoGenerate: true }).expect(200);
    await http().post('/api/topics/weekly/generate').set('Authorization', cs).send({}).expect(403);
    const res = await http().post('/api/topics/weekly/generate').set('Authorization', ops).send({}).expect(201);
    expect(res.body.weekOf).toBe(weekOf);
    expect(res.body.topics).toHaveLength(5);
    expect(res.body.topics.filter((t: { audience: string }) => t.audience === 'C')).toHaveLength(4);
    for (const t of res.body.topics) {
      expect(t.status).toBe('PROPOSED');
      expect(t.reason).toBeTruthy();
      expect(t.suggestedDate.slice(0, 10) >= weekOf).toBe(true);
    }
    // 已有清单时不能直接再生成
    await http().post('/api/topics/weekly/generate').set('Authorization', ops).send({}).expect(409);
  });

  it('可以修改、替换、追加，确认后勾选的进入选题库并批量出稿', async () => {
    const week = (await http().get(`/api/topics/weekly?weekOf=${weekOf}`).set('Authorization', ops).expect(200)).body;
    const [a, b, c] = week.topics;
    await http().patch(`/api/topics/${a.id}`).set('Authorization', ops).send({ title: '改过的选题' }).expect(200);
    const replaced = (await http().post(`/api/topics/${b.id}/replace`).set('Authorization', ops).expect(201)).body;
    expect(replaced.title).not.toBe(b.title);
    expect(replaced.audience).toBe(b.audience);
    const added = (
      await http().post('/api/topics').set('Authorization', ops).send({ title: '运营追加的选题', audience: 'C', category: '产地纪实', weekOf }).expect(201)
    ).body;
    expect(added.status).toBe('PROPOSED');

    const confirmed = await http()
      .post('/api/topics/weekly/confirm')
      .set('Authorization', ops)
      .send({ weekOf, topicIds: [a.id, b.id, added.id] })
      .expect(201);
    expect(confirmed.body.drafts).toHaveLength(3);
    expect(confirmed.body.drafts[0].status).toBe('GENERATING');

    const after = (await http().get(`/api/topics/weekly?weekOf=${weekOf}`).set('Authorization', ops)).body;
    expect(after.confirmed).toBe(true);
    expect(after.topics.map((t: { id: string }) => t.id).sort()).toEqual([a.id, b.id, added.id].sort());
    expect((await prisma.topic.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ARCHIVED');

    await app.get(DraftsService).idle();
    const drafts = (await http().get('/api/drafts').set('Authorization', cs).expect(200)).body;
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d: { status: string; _count: { versions: number } }) => d.status === 'DRAFT' && d._count.versions === 2)).toBe(true);
  });

  it('稿件详情：每个版本有风控和规格检查，推荐匹配素材，调用可追溯', async () => {
    const topic = await prisma.topic.findFirstOrThrow({ where: { title: '运营追加的选题' } });
    const draft = await prisma.draft.findFirstOrThrow({ where: { topicId: topic.id } });
    const res = await http().get(`/api/drafts/${draft.id}`).set('Authorization', cs).expect(200);
    expect(res.body.versions).toHaveLength(2);
    const v = res.body.versions.find((x: { chosen: boolean }) => x.chosen);
    expect(v.problems).toEqual([]);
    expect(v.risk.blocked).toBe(false);
    expect(v.body).toContain('波姬红'); // 用了知识库事实
    expect(v.body).not.toContain('润肠通便'); // 合规口径只作为规则，不当事实写进稿件
    const call = await prisma.llmCall.findFirstOrThrow({ where: { refType: 'draft', refId: draft.id } });
    expect(JSON.stringify(call.messages)).toContain('不写“润肠通便”→ 富含膳食纤维');
    expect(v.modelName).toBe('mock');
    expect(res.body.assets.map((x: { title: string }) => x.title)).toContain('果园清晨');

    const calls = await http().get(`/api/ai/calls?refType=draft&refId=${draft.id}`).set('Authorization', ops).expect(200);
    expect(calls.body[0].template).toBe('xhs_draft@1');
  });

  it('人工修改和改写都生成新版本，审核人也能按驳回原因让 AI 重写', async () => {
    const draft = await prisma.draft.findFirstOrThrow({ include: { versions: true } });
    const base = draft.versions.find((v) => v.chosen)!;

    const edited = await http()
      .patch(`/api/drafts/${draft.id}/versions/${base.id}`)
      .set('Authorization', ops)
      .send({ title: '人工改的标题', body: '每天吃两个润肠通便', tags: ['无花果'] })
      .expect(200);
    expect(edited.body.index).toBe(3);
    expect(edited.body.note).toContain('人工修改');
    const d1 = (await http().get(`/api/drafts/${draft.id}`).set('Authorization', ops)).body;
    const latest = d1.versions[0];
    expect(latest.chosen).toBe(true);
    expect(latest.risk.blocked).toBe(true); // “润肠通便”是拦截词
    expect(latest.problems.join()).toContain('标签 1 个');

    await http().post(`/api/drafts/${draft.id}/rewrite`).set('Authorization', cs).send({ mode: 'shorter' }).expect(403);
    await http().post(`/api/drafts/${draft.id}/rewrite`).set('Authorization', reviewer).send({ mode: 'reject_reason' }).expect(400);
    const rw = await http()
      .post(`/api/drafts/${draft.id}/rewrite`)
      .set('Authorization', reviewer)
      .send({ mode: 'reject_reason', instruction: '去掉功效表述', versionId: base.id })
      .expect(201);
    expect(rw.body.index).toBe(4);
    expect(rw.body.note).toContain('按驳回原因重写（基于版本 1）');

    await http().post(`/api/drafts/${draft.id}/versions/${base.id}/choose`).set('Authorization', ops).expect(201);
    const d2 = (await http().get(`/api/drafts/${draft.id}`).set('Authorization', ops)).body;
    expect(d2.versions.find((v: { chosen: boolean }) => v.chosen).id).toBe(base.id);
  });

  it('有稿件的选题不能删除，只能归档', async () => {
    const draft = await prisma.draft.findFirstOrThrow();
    await http().delete(`/api/topics/${draft.topicId}`).set('Authorization', ops).expect(409);
    await http().patch(`/api/topics/${draft.topicId}`).set('Authorization', ops).send({ status: 'ARCHIVED' }).expect(200);
  });
});

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootApp, loginAs, prisma, resetDb } from './helpers';

describe('风控词库（M5）', () => {
  let app: INestApplication;
  let reviewer: string;
  let ops: string;

  const check = (text: string, extra: object = {}) =>
    request(app.getHttpServer()).post('/api/risk/check').set('Authorization', ops).send({ text, ...extra }).expect(201);

  beforeAll(async () => {
    await resetDb();
    app = await bootApp();
    reviewer = await loginAs(app, 'shenhe', ['REVIEWER']);
    ops = await loginAs(app, 'yunying', ['CONTENT']);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('内容运营不能改词库', () =>
    request(app.getHttpServer())
      .post('/api/risk/words')
      .set('Authorization', ops)
      .send({ word: '养胃', category: '医疗功效', level: 'block' })
      .expect(403));

  it('新增词后立即生效，带替换建议', async () => {
    expect((await check('吃了养胃')).body.blocked).toBe(false);
    await request(app.getHttpServer())
      .post('/api/risk/words')
      .set('Authorization', reviewer)
      .send({ word: '养胃', category: '医疗功效', level: 'block', suggestion: '口感绵软，适合早餐搭配' })
      .expect(201);
    const res = await check('吃了养 胃');
    expect(res.body.blocked).toBe(true);
    expect(res.body.hits[0].suggestion).toBe('口感绵软，适合早餐搭配');
  });

  it('平台专属词只在该平台生效', async () => {
    await request(app.getHttpServer())
      .post('/api/risk/words')
      .set('Authorization', reviewer)
      .send({ word: '电话', category: '平台引流', level: 'block', platform: 'XHS' })
      .expect(201);
    expect((await check('留个电话', { platform: 'XHS' })).body.blocked).toBe(true);
    expect((await check('留个电话')).body.blocked).toBe(false);
  });

  it('白名单短语放行其中的命中词', async () => {
    await request(app.getHttpServer())
      .post('/api/risk/words')
      .set('Authorization', reviewer)
      .send({ word: '第一', category: '绝对化用语', level: 'block' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/risk/words')
      .set('Authorization', reviewer)
      .send({ word: '第一次', category: '白名单', level: 'pass', whitelist: true })
      .expect(201);
    expect((await check('第一次吃无花果')).body.hits).toHaveLength(0);
    expect((await check('全国第一')).body.blocked).toBe(true);
  });

  it('删除词后不再命中', async () => {
    const words = await request(app.getHttpServer()).get('/api/risk/words?q=养胃').set('Authorization', ops).expect(200);
    await request(app.getHttpServer()).delete(`/api/risk/words/${words.body[0].id}`).set('Authorization', reviewer).expect(200);
    expect((await check('吃了养胃')).body.hits).toHaveLength(0);
  });

  it('带来源的检测写命中日志，并汇总高频词', async () => {
    await check('全国第一，全国第一', { source: 'draft', sourceId: 'd1' });
    await check('留个电话', { platform: 'XHS', source: 'reply', sourceId: 'm1' });
    const res = await request(app.getHttpServer()).get('/api/risk/stats/top-words').set('Authorization', ops).expect(200);
    expect(res.body[0]).toMatchObject({ word: '第一', count: 2 });
    expect(res.body).toHaveLength(2);
  });
});

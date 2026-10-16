import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootApp, loginAs, prisma, resetDb } from './helpers';

describe('品牌知识库（M2）', () => {
  let app: INestApplication;
  let ops: string;
  let cs: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootApp();
    ops = await loginAs(app, 'yunying', ['CONTENT']);
    cs = await loginAs(app, 'kefu', ['CS']);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('运营维护知识条目，客服只读', async () => {
    await request(app.getHttpServer())
      .post('/api/knowledge/items')
      .set('Authorization', cs)
      .send({ kind: 'variety', title: '金傲芬', content: '果皮金黄' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/knowledge/items')
      .set('Authorization', ops)
      .send({ kind: 'variety', title: '金傲芬', content: '果皮金黄，果肉琥珀色，甜度高' })
      .expect(201);
    const res = await request(app.getHttpServer()).get('/api/knowledge/items?kind=variety').set('Authorization', cs).expect(200);
    expect(res.body).toHaveLength(1);
  });

  it('FAQ 分类不在预置列表里时拒绝', () =>
    request(app.getHttpServer())
      .post('/api/knowledge/faqs')
      .set('Authorization', ops)
      .send({ category: '随便', question: 'q', answer: 'a' })
      .expect(400));

  it('关键词检索同时查知识条目和 FAQ', async () => {
    await request(app.getHttpServer())
      .post('/api/knowledge/faqs')
      .set('Authorization', ops)
      .send({ category: '保存方法', question: '无花果怎么保存？', answer: '冷藏 3 天内吃完' })
      .expect(201);
    const res = await request(app.getHttpServer()).get('/api/knowledge/search?q=冷藏').set('Authorization', cs).expect(200);
    expect(res.body.faqs).toHaveLength(1);
    expect(res.body.items).toHaveLength(0);
  });

  it('素材按命中标签数排序推荐', async () => {
    const add = (title: string, tags: string[]) =>
      request(app.getHttpServer())
        .post('/api/knowledge/assets')
        .set('Authorization', ops)
        .send({ title, url: `https://oss.example.com/${encodeURIComponent(title)}.jpg`, kind: 'image', tags })
        .expect(201);
    await add('果园清晨', ['果园']);
    await add('开箱俯拍', ['开箱', '礼盒']);
    await add('礼盒侧面', ['礼盒']);
    const res = await request(app.getHttpServer())
      .get('/api/knowledge/assets/recommend?tags=开箱,礼盒')
      .set('Authorization', cs)
      .expect(200);
    expect(res.body.map((a: { title: string }) => a.title)).toEqual(['开箱俯拍', '礼盒侧面']);
  });
});

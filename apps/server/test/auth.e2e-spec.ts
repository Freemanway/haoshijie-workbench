import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootApp, loginAs, prisma, resetDb } from './helpers';

describe('登录与权限（M1）', () => {
  let app: INestApplication;
  let admin: string;
  let cs: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootApp();
    admin = await loginAs(app, 'admin', ['ADMIN']);
    cs = await loginAs(app, 'kefu', ['CS']);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('健康检查不需要登录', () => request(app.getHttpServer()).get('/api/health').expect(200));

  it('其他接口没有令牌返回 401', () => request(app.getHttpServer()).get('/api/accounts').expect(401));

  it('令牌无效返回 401', () =>
    request(app.getHttpServer()).get('/api/accounts').set('Authorization', 'Bearer nope').expect(401));

  it('me 返回当前成员', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', cs).expect(200);
    expect(res.body).toMatchObject({ name: 'kefu', roles: ['CS'] });
  });

  it('非管理员不能管理成员', () => request(app.getHttpServer()).get('/api/users').set('Authorization', cs).expect(403));

  it('管理员添加成员并写审计日志', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', admin)
      .send({ wecomId: 'zhaoshang', name: '陈经理', roles: ['BIZ'] })
      .expect(201);
    const log = await prisma.auditLog.findFirst({ where: { action: 'user.create', target: res.body.id } });
    expect(log).not.toBeNull();
  });

  it('参数不对返回字段级错误', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', admin)
      .send({ wecomId: 'x', name: '', roles: [] })
      .expect(400);
    expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(['name', 'roles']);
  });

  it('停用成员后令牌立即失效', async () => {
    const token = await loginAs(app, 'leaver', ['CS']);
    const u = await prisma.user.findUniqueOrThrow({ where: { wecomId: 'leaver' } });
    await request(app.getHttpServer()).patch(`/api/users/${u.id}`).set('Authorization', admin).send({ active: false }).expect(200);
    await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', token).expect(401);
  });

  it('管理员不能停用自己或撤掉自己的管理员角色', async () => {
    const me = await prisma.user.findUniqueOrThrow({ where: { wecomId: 'admin' } });
    const patch = (body: object) =>
      request(app.getHttpServer()).patch(`/api/users/${me.id}`).set('Authorization', admin).send(body);
    await patch({ active: false }).expect(400);
    await patch({ roles: ['CS'] }).expect(400);
    await patch({ name: '管理员甲' }).expect(200);
  });

  it('只有管理员能绑定平台账号，所有成员可查看', async () => {
    await request(app.getHttpServer())
      .post('/api/accounts')
      .set('Authorization', cs)
      .send({ platform: 'XHS', name: '好时节无花果研究所', audience: 'C' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/accounts')
      .set('Authorization', admin)
      .send({ platform: 'XHS', name: '好时节无花果研究所', audience: 'C' })
      .expect(201);
    const res = await request(app.getHttpServer()).get('/api/accounts').set('Authorization', cs).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].dailyPostCap).toBe(2);
  });

  it('未配置企业微信时扫码入口返回 404', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/options').expect(200);
    expect(res.body).toEqual({ wecom: false, devLogin: true });
    await request(app.getHttpServer()).get('/api/auth/wecom/login').expect(404);
  });
});

import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../src/app.factory';

export const prisma = new PrismaClient();

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
}

export async function bootApp() {
  const app = await createApp();
  await app.init();
  return app;
}

/** 建一个成员并用开发登录拿到令牌。 */
export async function loginAs(app: INestApplication, wecomId: string, roles: Role[]) {
  await prisma.user.create({ data: { wecomId, name: wecomId, roles } });
  const res = await request(app.getHttpServer()).post('/api/auth/dev-login').send({ wecomId }).expect(201);
  return `Bearer ${res.body.token}`;
}

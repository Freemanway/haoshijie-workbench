import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: process.env.NODE_ENV === 'test' ? ['error', 'warn'] : ['error', 'warn', 'log'] });
  // 企业微信回调是 XML
  app.useBodyParser('text', { type: ['text/xml', 'application/xml'] });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}

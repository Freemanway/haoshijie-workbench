import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: process.env.NODE_ENV === 'test' ? ['error', 'warn'] : ['error', 'warn', 'log'] });
  // 企业微信回调是 XML
  // 订单表以 base64 放在 JSON 里上传（最大 10MB）
  app.useBodyParser('json', { limit: '15mb' });
  app.useBodyParser('text', { type: ['text/xml', 'application/xml'] });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}

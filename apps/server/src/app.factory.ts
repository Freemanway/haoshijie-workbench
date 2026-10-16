import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: process.env.NODE_ENV === 'test' ? ['error', 'warn'] : ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}

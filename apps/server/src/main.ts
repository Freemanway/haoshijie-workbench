import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';

async function bootstrap() {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`好时节AI工作台服务已启动：http://localhost:${port}/api`, 'Bootstrap');
}
bootstrap();

import { Controller, Get, Module } from '@nestjs/common';
import { Public } from '../common/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';

@Public()
@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    let database: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    return { status: 'ok', database, time: new Date().toISOString() };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}

import { Global, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** M1-4 审计日志：敏感操作与导出留痕。 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  log(userId: string | undefined, action: string, target?: string, detail?: Prisma.InputJsonValue) {
    return this.prisma.auditLog.create({ data: { userId, action, target, detail } });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}

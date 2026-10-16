import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AccountsModule } from './accounts/accounts.module';
import { AiModule } from './ai/ai.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { DraftsModule } from './drafts/drafts.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LeadsModule } from './leads/leads.module';
import { PrismaModule } from './prisma/prisma.module';
import { RiskModule } from './risk/risk.module';
import { TopicsModule } from './topics/topics.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AiModule,
    AuditModule,
    AuthModule,
    HealthModule,
    UsersModule,
    AccountsModule,
    KnowledgeModule,
    RiskModule,
    LeadsModule,
    DraftsModule,
    TopicsModule,
  ],
})
export class AppModule {}

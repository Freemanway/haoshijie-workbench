import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AccountsModule } from './accounts/accounts.module';
import { AiModule } from './ai/ai.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { DraftsModule } from './drafts/drafts.module';
import { ReviewModule } from './drafts/review.module';
import { HealthModule } from './health/health.module';
import { InboxModule } from './inbox/inbox.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LeadsModule } from './leads/leads.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';
import { RiskModule } from './risk/risk.module';
import { ScheduleModule as PublishScheduleModule } from './schedule/schedule.module';
import { TopicsModule } from './topics/topics.module';
import { CrmModule } from './wecom/crm.module';
import { WecomModule } from './wecom/wecom.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AiModule,
    AuditModule,
    WecomModule,
    AuthModule,
    HealthModule,
    UsersModule,
    AccountsModule,
    KnowledgeModule,
    RiskModule,
    LeadsModule,
    OrdersModule,
    DraftsModule,
    ReviewModule,
    TopicsModule,
    PublishScheduleModule,
    InboxModule,
    CrmModule,
  ],
})
export class AppModule {}

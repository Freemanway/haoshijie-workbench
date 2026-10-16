import { Logger } from '@nestjs/common';

/**
 * 进程内的简单任务队列，限制同时调用模型的数量。
 * 一期单实例部署够用；多实例部署时换成 Redis + BullMQ（技术方案已选型），调用方不变。
 */
export class JobQueue {
  private readonly log = new Logger('JobQueue');
  private running = 0;
  private readonly waiting: (() => Promise<void>)[] = [];
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly concurrency = 2) {}

  push(job: () => Promise<void>) {
    this.waiting.push(job);
    this.next();
  }

  /** 等所有任务跑完（测试和优雅停机用）。 */
  idle(): Promise<void> {
    if (!this.running && !this.waiting.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private next() {
    while (this.running < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.running++;
      job()
        .catch((e) => this.log.error(e))
        .finally(() => {
          this.running--;
          this.next();
          if (!this.running && !this.waiting.length) {
            this.idleWaiters.forEach((r) => r());
            this.idleWaiters = [];
          }
        });
    }
  }
}

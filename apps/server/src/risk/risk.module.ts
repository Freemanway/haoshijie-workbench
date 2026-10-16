import { BadRequestException, Body, Controller, Module, Post } from '@nestjs/common';
import { RiskEngine } from '@hsj/shared';

/** M5-2 风控匹配接口。后续词库改从数据库 RiskWord 表加载（M5-1）。 */
@Controller('risk')
class RiskController {
  private readonly engine = new RiskEngine();

  @Post('check')
  check(@Body() body: { text?: string }) {
    if (typeof body?.text !== 'string') throw new BadRequestException('请传入要检测的 text');
    const hits = this.engine.scan(body.text);
    return { blocked: hits.some((h) => h.level === 'block'), hits };
  }
}

@Module({ controllers: [RiskController] })
export class RiskModule {}

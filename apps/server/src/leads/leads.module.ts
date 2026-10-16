import { BadRequestException, Body, Controller, Module, Post } from '@nestjs/common';
import { parseAddress } from '@hsj/shared';

/** M10-2 地址智能拆分接口。 */
@Controller('leads')
class LeadsController {
  @Post('parse-address')
  parse(@Body() body: { raw?: string }) {
    if (typeof body?.raw !== 'string' || !body.raw.trim()) throw new BadRequestException('请传入客户发来的地址文本 raw');
    return parseAddress(body.raw);
  }
}

@Module({ controllers: [LeadsController] })
export class LeadsModule {}

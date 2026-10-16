import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** 用 zod 校验请求体，错误信息按字段返回。 */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        message: '请求参数不正确',
        errors: r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    return r.data;
  }
}

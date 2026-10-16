process.env.DATABASE_URL ??= 'postgresql://hsj:hsj@localhost:5432/hsj_test?schema=public';
process.env.JWT_SECRET = 'test-secret';
process.env.AUTH_DEV_LOGIN = 'true';
process.env.CRON_ENABLED = 'false';
// 测试一律走演示模型
process.env.LLM_BASE_URL = '';
process.env.LLM_API_KEY = '';

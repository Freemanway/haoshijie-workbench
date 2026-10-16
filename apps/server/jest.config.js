/** 接口测试连真实 PostgreSQL（DATABASE_URL），每个测试文件开始前清空数据。 */
module.exports = {
  rootDir: '.',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/env.ts'],
};

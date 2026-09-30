import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

test.beforeAll(async () => {
  await build({
    entryPoints: {
      'sandbox-client': 'tests/performance/sandbox-binary-sync.ts',
      'sandbox-engine-worker': 'src/threading/engine-worker.ts',
    },
    bundle: true, platform: 'browser', format: 'esm', target: 'esnext',
    outdir: 'test-results',
  });
});

test('worker sandbox sync preserves binary bytes, text and deletion', async ({ page }) => {
  await page.goto('/tests/performance/sandbox-binary-sync.html');
  await expect(page.locator('#status')).toHaveText(/^(PASS|FAIL)/, { timeout: 30_000 });
  await expect(page.locator('#status')).toHaveText('PASS', { timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).__sandboxBinarySync)).toEqual({
    bytes: [0, 255, 128, 65], text: 'héllo', existsAfterDelete: false,
  });
});

import { expect, test } from '@playwright/test';

const pages = [
  'compositions/recurring-billing',
  'compositions/email-delivery',
  'compositions/job-dashboard',
  'compositions/account-concurrency',
  'compositions/event-stream',
  'primitives/operations',
  'primitives/alarms',
  'primitives/scheduler',
  'primitives/fanout',
  'primitives/log',
  'primitives/routing',
  'primitives/socket',
  'primitives/client',
  'primitives/outbox',
  'primitives/schedule',
  'primitives/tracker',
  'primitives/topology',
  'primitives/semaphore',
  'primitives/semaphore-queue',
];

for (const slug of pages) {
  test(`${slug} draws its diagram in both themes without errors`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    await page.goto(`/${slug}/`);
    await expect(page.locator('pre.mermaid')).toHaveCount(0);
    const preview = page.locator('.aw-preview svg.architecture');
    await expect(preview).toHaveCount(1);
    await expect(preview.locator('.arch-node').first()).toBeVisible();

    await page.locator('[data-nb-theme-toggle]').first().click();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await expect(preview.locator('.arch-node').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('the preview loops through its flows unless motion is reduced', async ({
  page,
}) => {
  await page.goto('/primitives/operations/');
  const preview = page.locator('.aw-preview svg.architecture');
  await preview.scrollIntoViewIfNeeded();
  await expect(preview).toHaveAttribute('data-spotlight', 'flow', {
    timeout: 8_000,
  });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForTimeout(4_000);
  await expect(preview).not.toHaveAttribute('data-spotlight', /.+/u);
});

test('primitive pages explain how they use the Durable Object', async ({
  page,
}) => {
  await page.goto('/primitives/operations/');
  await expect(page.locator('#how-it-uses-your-durable-object')).toBeVisible();
  await expect(page.locator('#behind-the-scenes')).toBeVisible();
});

test('diagrams fit on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/compositions/email-delivery/');
  await expect(page.locator('.aw-preview svg.architecture')).toBeVisible();
  const hasPageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(hasPageOverflow).toBe(false);
});

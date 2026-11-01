import { expect, test } from '@playwright/test';

const compositions = [
  'recurring-billing',
  'email-delivery',
  'job-dashboard',
  'account-concurrency',
  'event-stream',
];

for (const composition of compositions) {
  test(`${composition} renders architecture and failure diagrams`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    await page.goto(`/compositions/${composition}/`);
    const diagrams = page.locator('pre.mermaid');
    expect(await diagrams.count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('pre.mermaid:not([data-processed])')).toHaveCount(
      0
    );
    await expect(page.locator('pre.mermaid svg')).toHaveCount(
      await diagrams.count()
    );
    await expect(
      page.getByText('Error rendering diagram:', { exact: false })
    ).toHaveCount(0);
    expect(errors).toEqual([]);
    // Prove the theme observer re-rendered, rather than counting the old SVGs.
    const previousId = await page
      .locator('pre.mermaid svg')
      .first()
      .getAttribute('id');
    expect(previousId).not.toBeNull();
    await page.locator('[data-nb-theme-toggle]').first().click();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await expect(page.locator('pre.mermaid svg').first()).not.toHaveAttribute(
      'id',
      previousId!
    );
    await expect(page.locator('pre.mermaid svg')).toHaveCount(
      await diagrams.count()
    );
    expect(errors).toEqual([]);
  });
}

for (const primitive of [
  'operations',
  'alarms',
  'scheduler',
  'fanout',
  'log',
  'routing',
  'socket',
  'client',
  'outbox',
  'schedule',
  'tracker',
  'topology',
  'semaphore',
  'semaphore-queue',
]) {
  test(`${primitive} renders its behind-the-scenes diagram`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    await page.goto(`/primitives/${primitive}/`);
    await expect(page.locator('#behind-the-scenes')).toBeVisible();
    await expect(page.locator('pre.mermaid svg')).toHaveCount(1);
    await expect(
      page.getByText('Error rendering diagram:', { exact: false })
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('composition diagrams fit on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/compositions/email-delivery/');
  await expect(page.locator('pre.mermaid svg')).toHaveCount(2);
  const hasPageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(hasPageOverflow).toBe(false);
});

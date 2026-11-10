import { expect, test } from '@playwright/test';

test('Nimbus keeps a separate navigation entry for every primitive', async ({
  page,
}) => {
  await page.goto('/');
  const sidebar = page.locator('[data-nb-sidebar]');
  await expect(sidebar).toHaveCount(1);
  await Promise.all(
    [
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
    ].map(async (primitive) => {
      await expect(
        sidebar.locator(`a[href="/primitives/${primitive}/"]`)
      ).toHaveCount(1);
    })
  );
});

test('Nimbus searches the built Pagefind index', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-search-trigger]').first().click();
  const dialog = page.getByRole('dialog', {
    name: 'Search documentation',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-search-input]').fill('Semaphore');
  await expect(dialog.locator('[data-search-results]')).toBeVisible();
  await expect(dialog.locator('[data-search-results]')).toContainText(
    'Semaphore'
  );
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

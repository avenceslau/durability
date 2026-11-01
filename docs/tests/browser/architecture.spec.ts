/* eslint-disable no-await-in-loop -- These assertions intentionally follow one interactive state machine in order. */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { WalkthroughState } from '../../src/lib/architecture';

const pages = [
  'recurring-billing',
  'email-delivery',
  'job-dashboard',
  'account-concurrency',
  'event-stream',
];

async function openExplorer(page: Page) {
  const root = page.locator('[data-architecture]');
  await root
    .getByRole('button', { name: 'Explore code and architecture', exact: true })
    .click();
  await expect(root.locator('[data-dialog]')).toBeVisible();
  return root;
}

for (const slug of pages) {
  test(`${slug}: complete source, graph, and scroll stay synchronized`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/compositions/${slug}/`);
    const root = page.locator('[data-architecture]');
    await expect(root).toHaveAttribute('data-active-step', /.+/u);
    const model: WalkthroughState = JSON.parse(
      (await root.getAttribute('data-model'))!
    );
    // The article gets only a small preview, not an inline control dashboard.
    await expect(root.locator('[data-dialog]')).not.toBeVisible();
    await expect(root.locator('.aw-code-panel').first()).not.toBeVisible();
    expect((await root.boundingBox())!.height).toBeLessThan(320);
    await openExplorer(page);
    const viewport = page.viewportSize()!;
    expect(await root.locator('[data-dialog]').boundingBox()).toEqual({
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    });
    await expect(root.locator('.aw-details')).not.toHaveAttribute('open');
    await expect(root.locator('.aw-inspector')).not.toBeVisible();

    const files = [...new Set(model.excerpts.map((excerpt) => excerpt.file))];
    await expect(root.locator('[data-file-panel]')).toHaveCount(files.length);
    for (const file of files) {
      const original = await readFile(
        new URL(`../../../${file}`, import.meta.url),
        'utf8'
      );
      const rendered = await root
        .locator(`[data-file="${file}"] .line`)
        .allTextContents();
      expect(rendered.join('\n').trimEnd()).toBe(original.trimEnd());
    }
    await root.locator('.aw-details > summary').click();
    for (const scenario of model.scenarios) {
      await root
        .getByLabel('Architecture scenario', { exact: true })
        .selectOption(scenario.id);
      await root
        .getByRole('button', {
          name: 'Close code and architecture',
          exact: true,
        })
        .focus();
      for (const [index, step] of scenario.steps.entries()) {
        if (index > 0) {
          await page.keyboard.press('ArrowRight');
        }
        await expect(root).toHaveAttribute('data-active-step', step.id);
        await expect(
          root.locator('[data-node][data-active="true"]')
        ).toHaveCount(step.nodes.length);
        await expect(
          root.locator('[data-edge][data-active="true"]')
        ).toHaveCount(step.edges.length);
        for (const node of step.nodes) {
          await expect(root.locator(`[data-node="${node}"]`)).toHaveAttribute(
            'data-active',
            'true'
          );
        }
        const file = model.excerpts.find(
          (excerpt) => excerpt.id === step.source.excerpt
        )!.file;
        const panel = root.locator(`[data-file="${file}"]`);
        await expect(panel).toBeVisible();
        await expect(panel.locator('[data-highlighted]')).toHaveCount(
          step.source.to - step.source.from + 1
        );
        const inView = await panel.locator('pre').evaluate((pre, number) => {
          const line = pre
            .querySelector(`[data-source-line="${number}"]`)!
            .getBoundingClientRect();
          const bounds = pre.getBoundingClientRect();
          return line.top >= bounds.top - 1 && line.bottom <= bounds.bottom + 1;
        }, step.source.from);
        expect(
          inView,
          `${slug}/${step.id}: scroll to the selected source`
        ).toBe(true);
        await expect(root.locator('[data-source-link]')).toHaveAttribute(
          'href',
          new RegExp(`#L${step.source.from}-L${step.source.to}$`, 'u')
        );
        await expect(root.locator('[data-durable]')).toHaveText(step.durable);
        await expect(root.locator('[data-volatile]')).toHaveText(step.volatile);
        await expect(root.locator('[data-status]')).toHaveAttribute(
          'data-status',
          step.status
        );
      }
      await expect(
        root.getByRole('button', {
          name: 'Next architecture step',
          exact: true,
        })
      ).toBeDisabled();
      await page.keyboard.press('ArrowRight');
      await expect(root).toHaveAttribute(
        'data-active-step',
        scenario.steps.at(-1)!.id
      );
      await page.keyboard.press('ArrowLeft');
      await expect(root).toHaveAttribute(
        'data-active-step',
        scenario.steps.at(-2)!.id
      );
      await root
        .getByRole('button', { name: 'Reset architecture walkthrough' })
        .click();
      await expect(root).toHaveAttribute(
        'data-active-step',
        scenario.steps[0]!.id
      );
      await expect(
        root.getByRole('button', {
          name: 'Previous architecture step',
          exact: true,
        })
      ).toBeDisabled();
      await page.keyboard.press('ArrowLeft');
      await expect(root).toHaveAttribute(
        'data-active-step',
        scenario.steps[0]!.id
      );
    }
    expect(errors).toEqual([]);
  });
}

test('clicking code or a component keeps the complete file and moves the highlight', async ({
  page,
}) => {
  await page.goto('/compositions/recurring-billing/');
  const root = await openExplorer(page);
  const model: WalkthroughState = JSON.parse(
    (await root.getAttribute('data-model'))!
  );
  const subscribe = model.scenarios[0]!.steps.find(
    (step) => step.id === 'subscribe'
  )!;
  const schedule = model.scenarios[0]!.steps.find(
    (step) => step.id === 'schedule'
  )!;
  const panel = root.locator('[data-file-panel]');
  const count = await panel.locator('.line').count();
  await panel.locator(`[data-source-line="${subscribe.source.from}"]`).focus();
  await page.keyboard.press('Enter');
  await expect(root).toHaveAttribute('data-active-step', 'subscribe');
  await panel.locator(`[data-source-line="${schedule.source.from}"]`).focus();
  await page.keyboard.press('Enter');
  await expect(root).toHaveAttribute('data-active-step', 'schedule');
  await expect(root.locator('[data-node="renewal"]')).toHaveAttribute(
    'data-active',
    'true'
  );
  await root
    .getByRole('button', { name: 'Inspect Payment receiver', exact: true })
    .click();
  await expect(root).toHaveAttribute('data-active-step', 'charge');
  await expect(panel.locator('.line')).toHaveCount(count);
  await expect(root.locator('[data-node="provider"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(
    await panel.locator('pre').evaluate((pre) => pre.scrollTop)
  ).toBeGreaterThan(0);
});

test('arrow keys keep working when a focused code line belongs to a file that is replaced', async ({
  page,
}) => {
  await page.goto('/compositions/job-dashboard/');
  const root = await openExplorer(page);
  const model: WalkthroughState = JSON.parse(
    (await root.getAttribute('data-model'))!
  );
  const steps = model.scenarios[0]!.steps;
  await root
    .locator(
      `[data-file-panel]:not([hidden]) [data-source-line="${steps[0]!.source.from}"]`
    )
    .focus();
  for (const step of steps.slice(1)) {
    await page.keyboard.press('ArrowRight');
    await expect(root).toHaveAttribute('data-active-step', step.id);
  }
  await page.keyboard.press('ArrowLeft');
  await expect(root).toHaveAttribute('data-active-step', steps.at(-2)!.id);
});

test('arrow shortcuts leave native selectors, modified keys, and source selection alone', async ({
  page,
}) => {
  await page.goto('/compositions/job-dashboard/');
  const root = await openExplorer(page);
  const selector = root.getByLabel('Example source file');
  await selector.focus();
  await page.evaluate(() => {
    document.addEventListener(
      'keydown',
      (event) => {
        document.querySelector<HTMLElement>(
          '[data-source-select]'
        )!.dataset.keyPrevented = String(event.defaultPrevented);
      },
      { once: true }
    );
  });
  await page.keyboard.press('ArrowLeft');
  await expect(selector).toHaveAttribute('data-key-prevented', 'false');
  await root
    .getByRole('button', { name: 'Close code and architecture', exact: true })
    .focus();
  const step = await root.getAttribute('data-active-step');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(root).toHaveAttribute('data-active-step', step!);
  await root
    .locator('[data-file-panel]:not([hidden]) code')
    .evaluate((code) => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await page.keyboard.press('ArrowRight');
  await expect(root).toHaveAttribute('data-active-step', step!);
});

test('multi-file diagrams switch to the component’s owning file', async ({
  page,
}) => {
  await page.goto('/compositions/job-dashboard/');
  const root = await openExplorer(page);
  await root
    .getByLabel('Example source file')
    .selectOption('examples/job-dashboard/client.ts');
  await expect(
    root.locator('[data-file="examples/job-dashboard/client.ts"]')
  ).toBeVisible();
  await root
    .getByRole('button', { name: 'Inspect Dashboard SQL', exact: true })
    .click();
  await expect(
    root.locator('[data-file="examples/job-dashboard/dashboard.ts"]')
  ).toBeVisible();
  await root
    .getByRole('button', { name: 'Inspect Browser client', exact: true })
    .click();
  await expect(
    root.locator('[data-file="examples/job-dashboard/client.ts"]')
  ).toBeVisible();
});

test('Escape closes the zoom, restores focus, and leaves the guide in place', async ({
  page,
}) => {
  await page.goto('/compositions/recurring-billing/');
  const opener = page.getByRole('button', {
    name: 'Explore code and architecture',
    exact: true,
  });
  await opener.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  const root = await openExplorer(page);
  await page.mouse.move(20, 10);
  await page.mouse.wheel(0, 500);
  await page.keyboard.press('Escape');
  await expect(root.locator('[data-dialog]')).not.toBeVisible();
  await expect(opener).toBeFocused();
  const closedStep = await root.getAttribute('data-active-step');
  await page.keyboard.press('ArrowRight');
  await expect(root).toHaveAttribute('data-active-step', closedStep!);
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  await opener.click();
  await root
    .getByRole('button', { name: 'Close code and architecture', exact: true })
    .click();
  await expect(opener).toBeFocused();
});

test('state survives closing, theme changes, and client-side navigation', async ({
  page,
}) => {
  await page.goto('/compositions/recurring-billing/');
  const root = await openExplorer(page);
  await root
    .getByRole('button', { name: 'Next architecture step', exact: true })
    .click();
  await expect(root).toHaveAttribute('data-active-step', 'subscribe');
  await root
    .getByRole('button', { name: 'Close code and architecture', exact: true })
    .click();
  await page.locator('[data-nb-theme-toggle]').first().click();
  await openExplorer(page);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(root).toHaveAttribute('data-active-step', 'subscribe');
  await root
    .getByRole('button', { name: 'Inspect Shared scheduler', exact: true })
    .click();
  await root.locator('.aw-details > summary').click();
  await root.locator('[data-node-link]').click();
  await expect(page).toHaveURL(/\/primitives\/scheduler\//u);
  await page.goBack();
  await openExplorer(page);
  await expect(root).toHaveAttribute('data-active-step', 'pool');
  await root
    .getByRole('button', { name: 'Next architecture step', exact: true })
    .click();
  await expect(root).toHaveAttribute('data-active-step', 'subscribe');
});

test('mobile zoom confines scrolling to the graph and full source', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/compositions/email-delivery/');
  const root = await openExplorer(page);
  await root
    .getByRole('button', { name: 'Next architecture step', exact: true })
    .click();
  await expect(root.locator('[data-step][aria-current="step"]')).toContainText(
    'Wire independent destinations'
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  expect(await root.locator('[data-dialog]').boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 390,
    height: 844,
  });
});

test('the guide has meaningful source links and content without JavaScript', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://localhost:8793/compositions/recurring-billing/');
  await expect(page.locator('noscript p').first()).toContainText(
    'complete ordered walkthrough'
  );
  await page.locator('noscript summary').first().click();
  await expect(
    page
      .locator('noscript li')
      .filter({ hasText: 'Hand off to payment work' })
      .first()
  ).toBeVisible();
  await expect(page.locator('noscript a').first()).toHaveAttribute(
    'href',
    /github\.com.*#L\d+-L\d+/u
  );
  await context.close();
});

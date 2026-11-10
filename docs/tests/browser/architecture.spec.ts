/* eslint-disable no-await-in-loop -- These assertions intentionally follow one interactive state machine in order. */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  introducedNodes,
  scenarioDiagram,
  stepNodes,
  type WalkthroughState,
} from '../../src/lib/architecture';

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
    await page.goto(`/${slug}/`);
    const root = page.locator('[data-architecture]');
    await expect(root).toHaveAttribute('data-active-step', /.+/u);
    const model: WalkthroughState = JSON.parse(
      (await root.getAttribute('data-model'))!
    );
    // The article gets only a small preview, not an inline control dashboard.
    await expect(root.locator('[data-dialog]')).not.toBeVisible();
    await expect(root.locator('.aw-code-panel').first()).not.toBeVisible();
    await expect(root.locator('.aw-preview svg.architecture')).toBeVisible();
    expect((await root.boundingBox())!.height).toBeLessThan(480);
    await openExplorer(page);
    const viewport = page.viewportSize()!;
    expect(await root.locator('[data-dialog]').boundingBox()).toEqual({
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    });

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
    for (const scenario of model.scenarios) {
      const diagram = scenarioDiagram(model, scenario);
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
        const spotlit = diagram.stages[index]!.spotlight !== undefined;
        const nodes = stepNodes(diagram, index, introducedNodes(model, step));
        for (const node of nodes) {
          await expect(
            root.locator(
              `[data-graph] ${spotlit ? '.is-lit ' : ''}[data-node="${node}"]`
            )
          ).toBeVisible();
        }
        await expect(
          root.locator(`[data-graph] [data-node="${nodes[0]}"]`)
        ).toHaveAttribute('aria-pressed', 'true');
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
      for (let index = scenario.steps.length - 2; index > 0; index -= 1) {
        await page.keyboard.press('ArrowLeft');
      }
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
  await page.goto('/primitives/operations/');
  const root = await openExplorer(page);
  const model: WalkthroughState = JSON.parse(
    (await root.getAttribute('data-model'))!
  );
  const steps = model.scenarios[0]!.steps;
  const rpc = steps.find((step) => step.id === 'rpc')!;
  const handler = steps.find((step) => step.id === 'handler')!;
  const example = root.locator('[data-file="examples/image-jobs/worker.ts"]');
  const count = await example.locator('.line').count();
  await example.locator(`[data-source-line="${rpc.source.from}"]`).focus();
  await page.keyboard.press('Enter');
  await expect(root).toHaveAttribute('data-active-step', 'rpc');
  await example.locator(`[data-source-line="${handler.source.from}"]`).focus();
  await page.keyboard.press('Enter');
  await expect(root).toHaveAttribute('data-active-step', 'handler');
  await expect(example.locator('.line')).toHaveCount(count);
  await root
    .getByRole('button', { name: 'Inspect durability_calls', exact: true })
    .click();
  await expect(root).toHaveAttribute('data-active-step', 'migrate');
  await expect(root.locator('[data-node="sqlite"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  const library = root.locator(
    '[data-file="packages/durability/src/operations/index.ts"]'
  );
  await expect(library).toBeVisible();
  expect(
    await library.locator('pre').evaluate((pre) => pre.scrollTop)
  ).toBeGreaterThan(0);
});

test('arrow keys move the diagram after a node is clicked, and the step card follows', async ({
  page,
}) => {
  await page.goto('/primitives/operations/');
  const root = await openExplorer(page);
  const card = root.locator('[data-step-card]');
  await expect(card).toHaveAttribute('data-side', /.+/u);
  const placement = () =>
    card.evaluate((element) => `${element.style.left},${element.style.top}`);

  await page.keyboard.press('ArrowRight');
  await root
    .getByRole('button', { name: 'Inspect durability_calls', exact: true })
    .click();
  await expect(root).toHaveAttribute('data-active-step', 'migrate');
  const beside = await placement();
  await page.keyboard.press('ArrowRight');
  await expect(root).toHaveAttribute('data-active-step', 'rpc');
  await expect(root.locator('[data-graph] [data-node="caller"]')).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Next architecture step' })
  ).toBeVisible();
  expect(await placement()).not.toBe(beside);
});

test('arrow keys keep working when a focused code line belongs to a file that is replaced', async ({
  page,
}) => {
  await page.goto('/primitives/operations/');
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
  await page.goto('/primitives/operations/');
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
  await page.goto('/primitives/operations/');
  const root = await openExplorer(page);
  await root
    .getByLabel('Example source file')
    .selectOption('packages/durability/src/scheduler/index.ts');
  await expect(
    root.locator('[data-file="packages/durability/src/scheduler/index.ts"]')
  ).toBeVisible();
  await root
    .getByRole('button', { name: 'Inspect Durability', exact: true })
    .click();
  await expect(
    root.locator('[data-file="packages/durability/src/operations/index.ts"]')
  ).toBeVisible();
  await root
    .getByRole('button', { name: 'Inspect ImageJobs', exact: true })
    .click();
  await expect(
    root.locator('[data-file="examples/image-jobs/worker.ts"]')
  ).toBeVisible();
});

test('Escape closes the zoom, restores focus, and leaves the guide in place', async ({
  page,
}) => {
  await page.goto('/primitives/operations/');
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
  await page.goto('/primitives/operations/');
  const root = await openExplorer(page);
  await root
    .getByRole('button', { name: 'Next architecture step', exact: true })
    .click();
  await expect(root).toHaveAttribute('data-active-step', 'migrate');
  await root
    .getByRole('button', { name: 'Close code and architecture', exact: true })
    .click();
  await page.locator('[data-nb-theme-toggle]').first().click();
  await openExplorer(page);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(root).toHaveAttribute('data-active-step', 'migrate');
  await root
    .getByRole('button', { name: 'Inspect Durability', exact: true })
    .click();
  await expect(root).toHaveAttribute('data-active-step', 'insert');
  await root
    .getByRole('button', { name: 'Close code and architecture', exact: true })
    .click();
  await page.locator('a[href="/primitives/scheduler/"]').first().click();
  await expect(page).toHaveURL(/\/primitives\/scheduler\//u);
  await page.goBack();
  await openExplorer(page);
  await expect(root).toHaveAttribute('data-active-step', 'field');
  await root
    .getByRole('button', { name: 'Next architecture step', exact: true })
    .click();
  await expect(root).toHaveAttribute('data-active-step', 'migrate');
});

test('mobile zoom confines scrolling to the graph and full source', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/primitives/operations/');
  const root = await openExplorer(page);
  await root
    .getByRole('button', { name: 'Next architecture step', exact: true })
    .click();
  await expect(root.locator('[data-step-title]')).toContainText(
    'Create tables in the object’s SQLite'
  );
  await expect(root.locator('[data-graph] svg.architecture')).toBeVisible();
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
  await page.goto('http://localhost:8793/primitives/operations/');
  await expect(page.locator('noscript p').first()).toContainText(
    'complete ordered walkthrough'
  );
  await page.locator('noscript summary').first().click();
  await expect(
    page
      .locator('noscript li')
      .filter({ hasText: 'Insert the pending row' })
      .first()
  ).toBeVisible();
  await expect(page.locator('noscript a').first()).toHaveAttribute(
    'href',
    /github\.com.*#L\d+-L\d+/u
  );
  await context.close();
});

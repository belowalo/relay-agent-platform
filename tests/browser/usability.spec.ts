import { test, expect } from '@playwright/test';
async function register(page: any, label: string) {
  await page.goto('/');
  await page.getByLabel('Your name').fill(label);
  await page.getByLabel('Email address').fill(`usability-${crypto.randomUUID()}@relay.test`);
  await page.getByLabel('Password', { exact: true }).fill('Usability-password-2026');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Welcome back/ })).toBeVisible();
}
test('keyboard modal focus is contained, Escape closes and focus returns to the launcher', async ({
  page,
}) => {
  await register(page, 'Keyboard Tester');
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  const launcher = page.getByRole('button', { name: 'New collection', exact: true });
  await launcher.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('button', { name: 'Create collection', exact: true }).last(),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();
});
test('structured provider errors retain actionable guidance and correlation after the toast disappears', async ({
  page,
}) => {
  await register(page, 'Provider Tester');
  await page.getByRole('button', { name: 'Model connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByLabel('Connection name').fill('Quota fixture');
  await page.getByLabel('Model identifier').fill('fixture');
  await page.getByLabel('API key', { exact: true }).fill('synthetic-browser-key');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await page.route('**/connections/*/test', (route) =>
    route.fulfill({
      status: 429,
      json: {
        error: {
          code: 'BUDGET_LIMIT',
          message: 'Provider quota is exhausted.',
          retryable: false,
          requestId: 'fixture-correlation-42',
        },
      },
    }),
  );
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  const result = page.locator('.connection-result');
  await expect(result).toContainText('Provider quota is exhausted');
  await expect(result).toContainText('fixture-correlation-42');
  await expect(result).toContainText('provider credits and quota');
  await expect(page.getByRole('button', { name: 'Test connection', exact: true })).toBeEnabled();
  await expect(result).not.toContainText('[object Object]');
});
test('mobile onboarding, ingestion progress and citation details expose actual backend state', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, 'Mobile Tester');
  await expect(page.locator('.launch-note')).toContainText('Preview is deterministic');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'New collection' }).click();
  await page.getByLabel('Collection name').fill('Mobile policies');
  await page.getByRole('button', { name: 'Create collection', exact: true }).last().click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'synthetic-policy.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('Travel reimbursement requires receipts and Finance review.'),
  });
  await expect(page.locator('.source-list')).toContainText('ready');
  await page.getByLabel('Retrieval query').fill('travel reimbursement');
  await page.getByRole('button', { name: 'Retrieve', exact: true }).click();
  await expect(page.locator('.retrieval-result')).toContainText('Finance review');
  await page.getByText('Inspect citation', { exact: true }).click();
  await expect(page.locator('.citation-details')).toContainText('Chunk ID');
  await expect(page.locator('.citation-details')).toContainText('not confidence');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: 'test-results/mobile-citations.png', fullPage: true });
});

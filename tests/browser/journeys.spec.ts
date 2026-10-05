import { test, expect } from '@playwright/test';
test('account → canvas → save → reload → preview → inspect → knowledge → publish', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Your name').fill('Browser Tester');
  await page.getByLabel('Email address').fill(`browser-${Date.now()}@relay.test`);
  await page.getByLabel(/^Password/).fill('Browser-password-2026');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back, Browser.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Open your workflow' }).click();
  await expect(page.getByLabel('Workflow name')).toHaveValue('Research studio');
  await expect(page.locator('.canvas-node')).toHaveCount(6);
  await page.locator('.canvas-node').filter({ hasText: 'Research analyst' }).click();
  await page
    .getByLabel('Instructions', { exact: true })
    .fill('Investigate assigned evidence and cite only retrieved sources.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/Saved · v/)).toBeVisible();
  await page.reload();
  await expect(page.locator('.canvas-node')).toHaveCount(6);
  await page.locator('.canvas-node').filter({ hasText: 'Research analyst' }).click();
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
    'Investigate assigned evidence and cite only retrieved sources.',
  );
  await page.screenshot({ path: 'test-results/builder-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await page.getByLabel('Task or input').fill('Compare launch options for Project Orion');
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.locator('.run-bar')).toContainText('completed', { timeout: 30000 });
  await page.locator('.run-bar').click();
  await expect(page.getByRole('heading', { name: 'Research lead', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Research analyst completed', exact: false }).click();
  await expect(page.locator('.step-details .result-block')).toContainText('Development preview');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'New collection' }).click();
  await page.getByLabel('Collection name').fill('Project Orion');
  await page.getByRole('button', { name: 'Create collection', exact: true }).last().click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'orion.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('Orion launch is in November. Every deployment requires approval.'),
  });
  await expect(page.locator('.source-list')).toContainText('ready', { timeout: 15000 });
  await page.getByPlaceholder('Ask something about your sources…').fill('Orion launch');
  await page.getByRole('button', { name: 'Retrieve', exact: true }).click();
  await expect(page.locator('.retrieval-result')).toContainText('November');
  await page.getByRole('button', { name: 'Applications', exact: true }).click();
  await page.getByRole('button', { name: 'Publish locally', exact: true }).click();
  await page.getByLabel('Application name').fill('Orion research');
  await page.getByText('Allow public hosted chat and widget access').click();
  await page.getByRole('button', { name: 'Publish locally', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Your application is ready' })).toBeVisible();
  const token = await page.getByLabel('Application access token').inputValue();
  expect(token.length).toBe(64);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('heading', { name: 'Orion research' })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back, Browser.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-light.png', fullPage: true });
  expect(errors).toEqual([]);
});

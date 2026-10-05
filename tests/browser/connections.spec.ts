import { test, expect } from '@playwright/test';
test('reusable API credentials can be managed without a model', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your name').fill('Connection Tester');
  await page.getByLabel('Email address').fill(`connection-${Date.now()}@relay.test`);
  await page.getByLabel('Password').fill('Connection-password-2026');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Model connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByLabel('Connection name').fill('Project API credential');
  await page.getByLabel('Provider adapter').selectOption('credential');
  await expect(page.getByLabel('Model identifier')).toHaveCount(0);
  await page.getByLabel('API key or Bearer token').fill('synthetic-browser-credential');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('heading', { name: 'Project API credential' })).toBeVisible();
  await expect(page.locator('.connection-card')).not.toContainText('synthetic-browser-credential');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('API key or Bearer token')).toHaveValue('');
});
test('connection test shows a useful error when the API returns an empty proxy response', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Your name').fill('Connection Error Tester');
  await page.getByLabel('Email address').fill(`connection-error-${Date.now()}@relay.test`);
  await page.getByLabel('Password').fill('Connection-password-2026');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Model connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByLabel('Connection name').fill('Error fixture');
  await page.getByLabel('Model identifier').fill('fixture');
  await page.getByLabel('API key', { exact: true }).fill('synthetic-error-credential');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('heading', { name: 'Error fixture' })).toBeVisible();
  await page.route('**/connections/*/test', (route) => route.fulfill({ status: 502, body: '' }));
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    "Relay's API server is unavailable (HTTP 502)",
  );
  await expect(page.getByRole('button', { name: 'Test connection', exact: true })).toBeEnabled();
});

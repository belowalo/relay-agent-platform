import { test, expect } from '@playwright/test';
test('local semantic search retrieves a paraphrase that keyword search misses', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Your name').fill('Semantic Tester');
  await page.getByLabel('Email address').fill(`semantic-${Date.now()}@relay.test`);
  await page.getByLabel('Password', { exact: true }).fill('Semantic-password-2026');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'New collection', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Collection name').fill('Medical evidence');
  await dialog.getByLabel('Retrieval method').selectOption('semantic');
  await dialog.getByRole('button', { name: 'Create collection', exact: true }).click();
  for (const [name, content] of [
    ['medical.txt', 'A physician treats patients with illness.'],
    ['mechanical.txt', 'A mechanic repairs a broken car engine.'],
  ])
    await page
      .locator('input[type=file]')
      .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
  await expect(page.locator('.source-list .badge.ready')).toHaveCount(2, { timeout: 30000 });
  await page.getByPlaceholder('Ask something about your sources…').fill('doctors heal sickness');
  await page.getByRole('button', { name: 'Retrieve', exact: true }).click();
  await expect(page.locator('.retrieval-result').first()).toContainText('physician');
  await expect(page.locator('.retrieval-result').first()).toContainText('medical.txt');
  await page.getByLabel('Retrieval method').selectOption('lexical');
  await expect(page.getByRole('status')).toContainText('Retrieval method updated');
  await expect(page.locator('.source-list .badge.ready')).toHaveCount(2);
  await page.getByRole('button', { name: 'Retrieve', exact: true }).click();
  await expect(page.locator('.retrieval-result')).toHaveCount(0);
  await page.getByLabel('Retrieval method').selectOption('hybrid');
  await expect(page.getByRole('status')).toContainText('Retrieval method updated');
  await expect(page.locator('.source-list .badge.ready')).toHaveCount(2);
  await page.getByRole('button', { name: 'Retrieve', exact: true }).click();
  await expect(page.locator('.retrieval-result').first()).toContainText('physician');
  await page.screenshot({ path: 'test-results/semantic-retrieval.png', fullPage: true });
});

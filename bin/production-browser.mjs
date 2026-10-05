import { chromium, expect } from '@playwright/test';
import path from 'node:path';
export async function verifyProductionBrowser({ results }) {
  const browser = await chromium.launch({
    args: ['--host-resolver-rules=MAP relay.example.com 127.0.0.1', '--no-proxy-server'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', () => errors.push('Uncaught browser exception'));
  try {
    await page.goto('https://relay.example.com/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('[name=email]').fill('deploy@relay.test');
    await page.locator('[name=password]').fill('Disposable-password-2026');
    await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible({
      timeout: 20000,
    });
    await page.goto('https://relay.example.com/#page=knowledge');
    await expect(page.getByText('Deployment documents', { exact: true })).toBeVisible();
    await page.getByText('Deployment documents', { exact: true }).click();
    await expect(page.getByText('travel.md', { exact: true })).toBeVisible();
    await page.goto('https://relay.example.com/#page=applications');
    await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
    await expect(
      page.getByText('This deployment supports private API publications.', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open hosted chat' })).toHaveCount(0);
    await page.screenshot({ path: path.join(results, 'production-browser.png'), fullPage: true });
    expect(errors).toEqual([]);
    return {
      passed: true,
      journeys: [
        'HTTPS password login',
        'knowledge collection and parsed source visibility',
        'publication capability boundaries',
      ],
      scope:
        'Chromium through the actual production proxy and session/API. Full five-business-example journeys remain separate.',
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

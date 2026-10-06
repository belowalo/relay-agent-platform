import { chromium, expect } from '@playwright/test';
import path from 'node:path';
export async function verifyProductionBrowser({ results, workflowId }) {
  const browser = await chromium.launch({
    args: ['--host-resolver-rules=MAP relay.example.com 127.0.0.1', '--no-proxy-server'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage(),
    errors = [];
  let authenticated = false,
    expectedAnonymousMeDenials = 0;
  page.on('pageerror', () => errors.push('Uncaught browser exception'));
  page.on('response', (r) => {
    const pathname = new URL(r.url()).pathname;
    if (!authenticated && pathname === '/api/me' && r.status() === 401) {
      expectedAnonymousMeDenials++;
      return;
    }
    if (pathname.startsWith('/api/') && r.status() >= 400)
      errors.push(`API ${r.status()} ${pathname}`);
  });
  try {
    await page.goto('https://relay.example.com/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('[name=email]').fill('deploy@relay.test');
    await page.locator('[name=password]').fill('Disposable-password-2026');
    await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Welcome back,/ })).toBeVisible({
      timeout: 20000,
    });
    authenticated = true;
    await page.goto(`https://relay.example.com/#page=builder&id=${workflowId}`);
    await expect(page.getByLabel('Workflow name')).toBeVisible();
    await page.locator('.canvas-node').filter({ hasText: 'work' }).click();
    await page
      .getByLabel('Instructions', { exact: true })
      .fill('Production browser persistence check.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Saved · v/)).toBeVisible();
    await page.reload();
    await page.locator('.canvas-node').filter({ hasText: 'work' }).click();
    await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
      'Production browser persistence check.',
    );
    await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
    await page.getByLabel('Task or input').fill('Production browser preview');
    await page.getByLabel('Execution mode').selectOption('preview');
    await page.getByRole('button', { name: 'Start run', exact: true }).click();
    await expect(page.locator('.run-bar')).toContainText('completed', { timeout: 30000 });
    await page.locator('.run-bar').click();
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download', exact: true }).click();
    await (await download).saveAs(path.join(results, 'browser-run-export.json'));
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.goto('https://relay.example.com/#page=knowledge');
    const collection = page.getByRole('button', { name: /^Deployment documents sources/ });
    await expect(collection).toBeVisible();
    await collection.click();
    await expect(page.getByText('travel.md', { exact: true })).toBeVisible();
    await page.goto('https://relay.example.com/#page=applications');
    await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
    await expect(
      page.getByText('This deployment supports private API publications.', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open hosted chat' })).toHaveCount(0);
    for (const [pageId, title] of [
      ['projects', 'Projects'],
      ['workflows', 'Workflows'],
      ['connections', 'Credentials & model connections'],
      ['history', 'Run history'],
      ['operations', 'Operations'],
      ['settings', 'Settings'],
    ]) {
      await page.goto('https://relay.example.com/#page=' + pageId);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(results, 'production-browser.png'), fullPage: true });
    expect(errors).toEqual([]);
    return {
      passed: true,
      expectedAnonymousMeDenials,
      journeys: [
        'HTTPS password login',
        'canvas edit, save, reload, preview, run inspection and JSON export',
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

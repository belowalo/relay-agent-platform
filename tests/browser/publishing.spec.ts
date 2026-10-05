import { test, expect } from '@playwright/test';
import http from 'node:http';
test('public hosted chat, authenticated API and an embedded widget on another origin', async ({
  page,
  request,
}) => {
  const email = `publisher-${Date.now()}@relay.test`;
  const account = await request.post('/api/auth/register', {
    data: { name: 'Publisher', email, password: 'Publisher-password-2026' },
  });
  expect(account.status()).toBe(201);
  const { workspaceId } = await account.json();
  const workflows = await (await request.get(`/api/w/${workspaceId}/workflows`)).json();
  const publish = await request.post(`/api/w/${workspaceId}/applications`, {
    data: {
      name: 'Embedded team',
      workflowId: workflows[0].id,
      settings: {
        public: true,
        mode: 'preview',
        welcome: 'Give our team a task',
        accent: '#b3f576',
      },
    },
  });
  expect(publish.status()).toBe(201);
  const application = await publish.json();
  const invoke = await request.post(`/api/apps/${application.id}/invoke`, {
    headers: { Authorization: `Bearer ${application.token}` },
    data: { input: 'API verification' },
  });
  expect(invoke.status()).toBe(202);
  const run = await invoke.json();
  await expect
    .poll(
      async () => {
        const result = await request.get(`/api/apps/${application.id}/runs/${run.id}`, {
          headers: { Authorization: `Bearer ${application.token}` },
        });
        return (await result.json()).status;
      },
      { timeout: 20000 },
    )
    .toBe('completed');
  await page.goto(`/apps/${application.id}`);
  await page.getByLabel('Message').fill('Hosted chat verification');
  await page.getByRole('button').last().click();
  await expect(page.locator('.chat-message.assistant')).toContainText('Development preview', {
    timeout: 15000,
  });
  const fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<html><body><h1>Widget host fixture</h1><script src="${new URL(page.url()).origin}/widget.js" data-app="${application.id}"></script></body></html>`,
    );
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  try {
    const address = fixture.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: 'Chat with our team' }).click();
    const widget = page.frameLocator('iframe[title="Agent chat"]');
    await expect(widget.getByRole('heading', { name: 'Embedded team' })).toBeVisible();
    await widget.getByLabel('Message').fill('Embedded widget verification');
    await widget.getByRole('button').last().click();
    await expect(widget.locator('.chat-message.assistant')).toContainText('Development preview', {
      timeout: 15000,
    });
    await page.screenshot({ path: 'test-results/widget.png' });
  } finally {
    fixture.closeAllConnections();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});

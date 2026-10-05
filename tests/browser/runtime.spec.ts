import { test, expect } from '@playwright/test';
const node = (id: string, kind: string, config = {}, x = 0) => ({
  id,
  type: 'relay',
  position: { x, y: 180 },
  data: { kind, label: id, config },
});
test('guardrail component testing and tool approval are usable from the canvas', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Your name').fill('Runtime Browser');
  await page.getByLabel('Email address').fill(`runtime-browser-${Date.now()}@relay.test`);
  await page.getByLabel('Password', { exact: true }).fill('Runtime-browser-password');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open your workflow' })).toBeVisible();
  const me = await (await page.request.get('/api/me')).json();
  const wid = me.workspaces[0].id,
    base = `/api/w/${wid}`;
  const graph = {
    nodes: [
      node('input', 'input'),
      node('policy', 'guardrail', { redactEmails: true, blockedTerms: ['restricted'] }, 330),
      node('output', 'output', {}, 660),
    ],
    edges: [
      { id: 'in-policy', source: 'input', target: 'policy' },
      { id: 'policy-out', source: 'policy', target: 'output' },
    ],
  };
  const response = await page.request.post(base + '/workflows', {
    data: { name: 'Guarded workflow', graph },
  });
  expect(response.status()).toBe(201);
  const workflow = await response.json();
  await page.goto(`/#page=builder&id=${workflow.id}`);
  await page.getByLabel('Workflow name').fill('Saved on navigation');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect
    .poll(
      async () => (await (await page.request.get(base + '/workflows/' + workflow.id)).json()).name,
    )
    .toBe('Saved on navigation');
  await page.goBack();
  await page.locator('.canvas-node').filter({ hasText: 'policy' }).click();
  await expect(page.getByLabel('Redact email addresses')).toBeChecked();
  await page.getByRole('button', { name: 'Test component', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Test this component' })).toBeVisible();
  await page.getByLabel('Task or input').fill('Contact person@example.test');
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await expect(page.locator('.run-bar')).toContainText('completed', { timeout: 15000 });
  await page.getByRole('button', { name: 'Open execution details' }).click();
  await page.locator('.timeline-step').filter({ hasText: 'policy' }).click();
  await expect(page.locator('.run-detail')).toContainText('Contact [email redacted]');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  await page.getByRole('button', { name: 'Test component', exact: true }).click();
  await page.getByLabel('Task or input').fill('restricted request');
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await expect(page.locator('.run-bar')).toContainText('failed', { timeout: 15000 });
  const tool = await (
    await page.request.post(base + '/tools', {
      data: {
        name: 'Reviewed artifact',
        kind: 'file',
        config: { operation: 'write', name: 'reviewed.txt', requireApproval: true },
      },
    })
  ).json();
  const approvedGraph = {
    nodes: [
      node('input', 'input'),
      node('write', 'tool', { toolId: tool.id }, 330),
      node('output', 'output', {}, 660),
    ],
    edges: [
      { id: 'in-write', source: 'input', target: 'write' },
      { id: 'write-out', source: 'write', target: 'output' },
    ],
  };
  const write = await (
    await page.request.post(base + '/workflows', {
      data: { name: 'Reviewed action', graph: approvedGraph },
    })
  ).json();
  await page.goto(`/#page=builder&id=${write.id}`);
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await page.getByLabel('Task or input').fill('Reviewed document content');
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await expect(page.locator('.run-bar')).toContainText('waiting', { timeout: 15000 });
  await page.getByRole('button', { name: 'Open execution details' }).click();
  await expect(page.locator('.approval-panel')).toContainText('Reviewed artifact');
  await expect(page.locator('.approval-panel')).toContainText('Reviewed document content');
  await page.getByRole('button', { name: 'Approve & continue', exact: true }).click();
  await expect(page.locator('.run-detail .run-meta')).toContainText('completed', {
    timeout: 15000,
  });
  await page.screenshot({ path: 'test-results/runtime-approval.png', fullPage: true });
  await page.getByRole('button', { name: 'Operations', exact: true }).click();
  await page.getByRole('button', { name: 'Schedule workflow', exact: true }).click();
  await page.getByLabel('Schedule name').fill('Weekday review');
  await page.getByLabel('Scheduling method').selectOption('cron');
  await page.getByLabel('Cron expression').fill('0 9 * * 1-5');
  await page.getByLabel('Timezone').fill('America/Toronto');
  await page.getByLabel('Task input').fill('Calendar task');
  await page.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(page.locator('.quality-row').filter({ hasText: 'Weekday review' })).toContainText(
    'America/Toronto',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Completed run history retention (days)').fill('30');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Workspace updated');
  const saved = await (await page.request.get('/api/me')).json();
  expect(saved.workspaces[0].settings.historyRetentionDays).toBe(30);
  expect(errors).toEqual([]);
});

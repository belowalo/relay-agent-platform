import assert from 'node:assert/strict';
import { businessExamples } from '../examples/business/workflows.mjs';
export async function verifyProductionBusiness({
  request,
  base,
  collectionId,
  connectionId,
  applicationRequest,
  until,
}) {
  async function ok(path, body, method) {
    const v = await request(path, body, method);
    assert.ok(v.r.status < 300, `Business API HTTP ${v.r.status}: ${JSON.stringify(v.data)}`);
    return v.data;
  }
  const research = await ok(base + '/tools', {
    name: 'Business external evidence',
    kind: 'http',
    config: { url: 'http://qualification-model:4320/research', method: 'GET' },
  });
  const action = await ok(base + '/tools', {
    name: 'Business reviewed write',
    kind: 'http',
    config: { url: 'http://qualification-model:4320/action', method: 'POST' },
  });
  const examples = businessExamples({
      collectionId,
      connectionId,
      researchToolId: research.id,
      approvedToolId: action.id,
    }),
    checks = [];
  for (const example of examples) {
    const workflow = await ok(base + '/workflows', { name: example.name, graph: example.graph });
    const input =
      example.id === 'scheduled'
        ? { period: 'October', summary: 'Pilot ready for review' }
        : example.id === 'published-api'
          ? { name: 'Ada' }
          : 'approved travel limit';
    let runId, publication, schedule;
    if (example.id === 'published-api') {
      publication = await ok(base + '/applications', {
        name: example.name,
        workflowId: workflow.id,
        settings: { mode: 'live', public: false },
      });
      const invoked = await applicationRequest(
        `/api/apps/${publication.id}/invoke`,
        { input },
        publication.token,
      );
      assert.equal(invoked.r.status, 202, JSON.stringify(invoked.data));
      runId = invoked.data.id;
    } else if (example.id === 'scheduled') {
      schedule = await ok(base + '/schedules', {
        name: 'Qualification durable brief',
        workflowId: workflow.id,
        input,
        intervalMinutes: 1,
        mode: 'live',
      });
      runId = await until(async () => {
        const s = (await ok(base + '/schedules')).find((v) => v.id === schedule.id);
        return s.lastRunId || s.last_run_id;
      }, 90000);
      await ok(base + '/schedules/' + schedule.id + '/disable', {});
    } else
      runId = (await ok(base + '/workflows/' + workflow.id + '/runs', { input, mode: 'live' })).id;
    if (example.id === 'approved-action') {
      const pending = await until(async () => {
        const r = await ok(base + '/runs/' + runId);
        return r.status === 'waiting' && r.approvals[0];
      });
      await ok(base + '/approvals/' + pending.id + '/decision', {
        approved: true,
        argumentHash: pending.argumentHash || pending.argument_hash,
      });
    }
    const run = await until(async () => {
      const v = await ok(base + '/runs/' + runId);
      return ['completed', 'failed'].includes(v.status) && v;
    });
    assert.equal(run.status, 'completed', `${example.id}: ${run.error}`);
    if (example.id === 'internal-knowledge') {
      assert.match(JSON.stringify(run.output), /180 CAD/);
      const answer = run.steps.find((s) => s.node_id === 'assistant').output;
      assert.ok(answer.citations.length);
      assert.equal(answer.citations[0].sourceVersion, 1);
      assert.equal(run.usage.tokens, 28);
    }
    if (example.id === 'research') {
      assert.match(
        JSON.stringify(run.steps.find((s) => s.node_id === 'internal').output),
        /180 CAD/,
      );
      assert.match(
        JSON.stringify(run.steps.find((s) => s.node_id === 'report').input),
        /Synthetic public product evidence/,
      );
      assert.equal(run.usage.tokens, 28);
    }
    if (example.id === 'approved-action') {
      const ledger = await ok(base + '/runs/' + runId + '/actions');
      assert.equal(ledger.filter((a) => a.status === 'succeeded').length, 1);
    }
    if (example.id === 'scheduled')
      assert.equal(run.output, 'Operations brief for October: Pilot ready for review');
    if (example.id === 'published-api') {
      const read = await applicationRequest(
        `/api/apps/${publication.id}/runs/${runId}`,
        undefined,
        publication.token,
      );
      assert.equal(read.r.status, 200);
      assert.equal(read.data.output, 'Hello Ada');
      await ok(base + '/applications/' + publication.id + '/revoke', {});
      assert.equal(
        (
          await applicationRequest(
            `/api/apps/${publication.id}/invoke`,
            { input },
            publication.token,
          )
        ).r.status,
        401,
      );
    }
    checks.push({
      id: example.id,
      workflowId: workflow.id,
      runId,
      status: 'passed',
      reportedTokens: run.usage.tokens,
    });
  }
  return {
    checks,
    scope:
      'Actual deployed application, persisted schedules/actions/citations/private tokens; synthetic provider and external action endpoints. This is integration evidence, not live-vendor or company-document quality.',
  };
}

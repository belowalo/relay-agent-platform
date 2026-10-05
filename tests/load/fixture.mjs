import fs from 'node:fs/promises';
import { providerFixture } from '../acceptance/support.mjs';
const fixture = await providerFixture();
process.stdout.write(`Synthetic protocol fixture: ${fixture.url}\n`);
async function stop() {
  await fixture.close();
  if (process.env.FIXTURE_TIMING_FILE)
    await fs.writeFile(process.env.FIXTURE_TIMING_FILE, JSON.stringify(fixture.calls, null, 2));
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

#!/usr/bin/env node
import fs from 'node:fs/promises';
import { RelayClient } from '../sdk/javascript/relay.mjs';
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
if (!args.length || args.includes('--help')) {
  console.log(
    'relay invoke --input \'{"question":"Hello"}\' [--wait]\nrelay invoke --file input.json [--wait]\nrelay status RUN_ID\nrelay events RUN_ID\n\nSet RELAY_BASE_URL, RELAY_APP_ID and RELAY_APP_TOKEN. --input accepts JSON.',
  );
} else {
  try {
    const client = new RelayClient({
      baseUrl: process.env.RELAY_BASE_URL || 'http://127.0.0.1:4311',
      applicationId: process.env.RELAY_APP_ID,
      token: process.env.RELAY_APP_TOKEN,
    });
    let result;
    if (args[0] === 'invoke') {
      const input = option('--file')
        ? JSON.parse(await fs.readFile(option('--file'), 'utf8'))
        : JSON.parse(option('--input') || 'null');
      const queued = await client.invoke(input);
      result = args.includes('--wait') ? await client.waitRun(queued.id) : queued;
    } else if (args[0] === 'status' && args[1]) result = await client.getRun(args[1]);
    else if (args[0] === 'events' && args[1]) {
      for await (const event of client.events(args[1])) console.log(JSON.stringify(event));
    } else throw new Error('Use invoke, status, or events; run --help for usage');
    if (result) {
      console.log(JSON.stringify(result, null, 2));
      if (['failed', 'cancelled'].includes(result.status)) process.exitCode = 1;
    }
  } catch (error) {
    const token = process.env.RELAY_APP_TOKEN;
    console.error(token ? String(error.message).replaceAll(token, '[redacted]') : error.message);
    process.exitCode = 1;
  }
}

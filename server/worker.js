import 'dotenv/config';
import { startEngine } from './engine.js';
import { maintenance } from './maintenance.js';
const stop = startEngine({ maintenance });
console.log(`Relay execution worker started (${process.pid})`);
const keepAlive = setInterval(() => {}, 60000);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stop();
    clearInterval(keepAlive);
    process.exit(0);
  });

import 'dotenv/config';
process.env.ENGINE_ROLE = 'worker';
if (process.env.RELAY_PROFILE === 'production') await import('../bin/runtime.mjs');
else await import('./local-worker.js');

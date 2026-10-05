import 'dotenv/config';
if (process.env.RELAY_PROFILE === 'production') await import('../bin/runtime.mjs');
else await import('./local-index.js');

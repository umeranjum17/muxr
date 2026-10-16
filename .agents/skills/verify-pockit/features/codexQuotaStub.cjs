#!/usr/bin/env node
// Lab stand-in for `codex app-server`: answers identity and the rate-limit read
// with the figures from the bug report (5h 100% left, 7d 0% left, Month 11% left).
const rl = require('readline').createInterface({ input: process.stdin });
const now = Math.floor(Date.now() / 1000);
rl.on('line', (line) => {
  const m = JSON.parse(line);
  let result = {};
  if (m.method === 'account/read') result = { account: { type: 'chatgpt', email: 'umer@example.com', planType: 'pro' } };
  if (m.method === 'account/rateLimits/read') result = { rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: now + 3600 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: now + 86400 } },
    monthly: { limitName: 'Monthly', primary: { usedPercent: 89, windowDurationMins: 43200, resetsAt: now + 864000 } },
    ...(process.env.QUOTA_STRESS ? {
      m2: { limitName: 'Monthly', primary: { usedPercent: 89, resetsAt: now + 864000 } },
      spark: { limitName: 'GPT-5.3-Codex-Spark', primary: { usedPercent: 65, windowDurationMins: 300 }, secondary: { usedPercent: 20, windowDurationMins: 10080 } },
      mini: { limitName: 'codex-mini', primary: { usedPercent: 76, windowDurationMins: 10080 } },
    } : {}),
  } };
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\n');
});

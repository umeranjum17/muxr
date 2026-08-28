#!/usr/bin/env node
/**
 * Core purity guard: the OSS core must never reference hosted/cloud concerns.
 * Fails the suite if any core source mentions Mongo, Stripe, Resend, commerce,
 * entitlements, or the hosted control plane. One-way rule: cloud -> core only.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CORE_DIRS = ['apps/relay/src', 'apps/host/src', 'packages/contract/src', 'packages/crypto/src'];
const FORBIDDEN = /\b(mongodb|MongoControlRepository|MemoryControlRepository|ControlPlane|CommerceService|StripeGateway|betaCodeAdmin|stripeSecret|MUXR_STRIPE_|MUXR_MONGODB|MUXR_OTP_PEPPER|entitlementAllowsHosted|elevenUserId|subscription_required|voice_hard_limit_reached|limitSeconds|conversationLimit)\b/;
// Public docs may state that hosted services are separate. They may not publish
// private billing/control-plane implementation or roadmap instructions.
const FORBIDDEN_DOCS = /\b(Stripe entitlement|muxr-cloud already owns|muxr-cloud-owned|muxr-cloud vendors|existing `?VmProvider|see npm checklist in muxr-cloud)\b/i;
// Compiled cloud modules must never survive in the core build output.
const FORBIDDEN_DIST = /^(controlPlane|controlRepository|commerce|website|betaCodeAdmin|migrate|controlPlane\.integration\.test)\.(js|d\.ts|js\.map|d\.ts\.map)$/;

const failures = [];
const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.') || entry === 'dist' || entry === 'node_modules') continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            walk(path);
        } else if (/\.(ts|tsx|mjs)$/.test(entry)) {
            const text = readFileSync(path, 'utf8');
            const lines = text.split('\n');
            lines.forEach((line, i) => {
                if (FORBIDDEN.test(line)) failures.push(`${path}:${i + 1}: ${line.trim().slice(0, 100)}`);
            });
        }
    }
};
for (const dir of CORE_DIRS) walk(join(ROOT, dir));

const walkDocs = (dir) => {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walkDocs(path);
        else if (/\.md$/.test(entry)) {
            readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
                if (FORBIDDEN_DOCS.test(line)) failures.push(`${path}:${i + 1}: private implementation detail in public docs`);
            });
        }
    }
};
walkDocs(join(ROOT, 'docs'));

const relayDist = join(ROOT, 'apps/relay/dist');
try {
    for (const entry of readdirSync(relayDist)) {
        if (FORBIDDEN_DIST.test(entry)) failures.push(`${relayDist}/${entry}: stale cloud build output in core dist`);
    }
} catch { /* dist may not exist pre-build */ }

if (failures.length > 0) {
    console.error(`core purity violated:\n${failures.join('\n')}`);
    process.exit(1);
}
console.log(`core purity: no commercial core schema or private implementation roadmap in ${CORE_DIRS.length} source trees + docs`);

import { promoteLatest } from '../application/promoteLatest.mjs';

const option = (key) => {
    const index = process.argv.indexOf(`--${key}`);
    if (index < 0) return undefined;
    return process.argv[index + 1];
};
const version = option('version');
if (!version) throw new Error('usage: promoteLatest.mjs --version <stable version> [--receipts <ref>] [--check-only]');
const result = await promoteLatest({ version, receiptsRef: option('receipts') ?? 'origin/main', checkOnly: process.argv.includes('--check-only') });
const state = result.moved ? 'is now' : process.argv.includes('--check-only') ? 'may become' : 'already was';
process.stdout.write(`${version} ${state} npm latest; its release journey receipt is ${result.proof}\n`);

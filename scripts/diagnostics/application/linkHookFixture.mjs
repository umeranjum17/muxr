// Test hook for the link integration flow: installed into spawned relay, host
// and pairing-CLI processes via `--import` (see
// linkUpgrade.integration.test.ts). Configured entirely through the
// LINK_TEST_HOOK environment variable (JSON) so no test values are ever
// built into source text.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const cfg = JSON.parse(process.env.LINK_TEST_HOOK ?? '{}');

if (cfg.hook === 'recordCloses') {
    const { Host } = await import('@byokit/link');
    const connection = Host.prototype.connection;
    Host.prototype.connection = function (conn, ...args) {
        const close = conn.close;
        conn.close = (code, reason) => {
            appendFileSync(cfg.to, JSON.stringify({ code, reason }) + '\n');
            return close(code, reason);
        };
        return connection.call(this, conn, ...args);
    };
}

if (cfg.hook === 'holdEnrol') {
    const { Host } = await import('@byokit/link');
    const enrol = Host.prototype.enrol;
    Host.prototype.enrol = async function (...args) {
        writeFileSync(cfg.entered, 'entered');
        while (!existsSync(cfg.release)) await new Promise((resolve) => setTimeout(resolve, 20));
        return enrol.apply(this, args);
    };
}

if (cfg.hook === 'holdRequest') {
    const fetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
        if (String(args[0]).endsWith(cfg.suffix)) {
            while (!existsSync(cfg.release)) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return fetch(...args);
    };
}

if (cfg.hook === 'failPost') {
    const fetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
        if (String(args[1]?.method).toUpperCase() === 'POST' && String(args[0]).endsWith(cfg.suffix)) {
            return new Response(JSON.stringify({ error: 'publish failed' }), { status: 500 });
        }
        return fetch(...args);
    };
}

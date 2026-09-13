import { planToArgs, validateSetupPlan } from '../infrastructure/operatorConfig.mjs';
import { configDefaults } from '../infrastructure/configSchema.mjs';

/**
 * Occupied or disabled Tailscale Serve falls back to direct tailnet
 * networking: browser hosting cannot work there, so web turns off and any
 * browser pairing becomes native. Pure mapping — ownership probing and
 * acceptance stay in the wizard.
 */
export function continueWithDirectTailscale(plan) {
    const browserPair = plan.pairing === 'browser' || plan.pairing === 'browser-view' || plan.pairing === 'both';
    return {
        mode: 'tailscale-direct',
        port: plan.port,
        endpoint: plan.endpoint,
        web: false,
        pairing: browserPair ? 'phone' : plan.pairing,
    };
}

function advertiseUrlForPlan({ mode, port, endpoint, found }) {
    if (mode === 'lan') return `ws://${found.lan}:${port}`;
    if (mode === 'private') return endpoint ?? `ws://${found.private.address}:${port}`;
    if (mode === 'external') return endpoint;
    return undefined;
}

function intentValues({ mode, port, web, endpoint, found, notifyEmail }) {
    const advertiseUrl = advertiseUrlForPlan({ mode, port, endpoint, found });
    return {
        connection: mode,
        relayPort: port,
        web,
        ...(advertiseUrl === undefined ? {} : { advertiseUrl }),
        tunnel: mode === 'cloudflare',
        tailscaleDirect: mode === 'tailscale-direct',
        ...(notifyEmail === undefined ? {} : { notifyEmail }),
    };
}

/**
 * One final normalized operator plan from the wizard's working plan.
 * Review, recovery, application, and serialization all derive from this
 * single construction, so config.env can never describe a plan that was
 * not applied. Supported operator fields (notification address,
 * integrations choice) survive recovery unchanged; pairing stays a
 * per-invocation action, not plan intent.
 */
export function finalizeSetupPlan({ plan, found, syncIntegrations, notifyEmail, operator = {} }) {
    // Schema defaults underneath, the operator's resolved intent (role,
    // service mode, pairing default, plugins, voice) over them, the wizard's
    // decisions on top: one complete desired state.
    const values = {
        ...configDefaults(),
        ...operator,
        ...intentValues({ mode: plan.mode, port: plan.port, web: plan.web, endpoint: plan.endpoint, found, notifyEmail }),
        integrationsSync: syncIntegrations ? 'on' : 'off',
    };
    validateSetupPlan(values);
    return values;
}

/**
 * Canonical apply argv for a working plan: the same normalized intent,
 * plus per-invocation pairing flags. Apply therefore consumes exactly what
 * Review showed — never re-derived intent — including the notification
 * address, which the wizard applies before config.env exists. Only the
 * integrations choice rides config.env into the apply instead of argv.
 */
export function selfhostArgsFromSetupPlan({ mode, port, web, pairing, found, endpoint, notifyEmail }) {
    const planValues = intentValues({ mode, port, web, endpoint, found, notifyEmail });
    validateSetupPlan(planValues);
    const selfhostArgs = [...planToArgs(planValues), ...(web ? ['--yes'] : [])];
    if (pairing === 'browser') selfhostArgs.push('--pair-browser');
    if (pairing === 'browser-view') selfhostArgs.push('--pair-browser-view');
    if (pairing === 'none') selfhostArgs.push('--no-pair');
    return selfhostArgs;
}

/**
 * What forgetting a machine means for this browser's web-push endpoint.
 *
 * The endpoint is account-scoped but each server record is bound to the
 * device grant that created it, so the decision depends on whether the
 * forgotten machine is the current one and whether pairings remain:
 * forgetting a background machine touches nothing; forgetting the last
 * machine takes the server endpoint with it; forgetting the current
 * machine of several keeps the endpoint and rebinds it under the
 * surviving grant (otherwise delivery-time authorization prunes it as a
 * dead grant and the survivor's push silently stops).
 */
export type ForgetPushAction = 'delete-endpoint' | 'rebind-endpoint' | 'none';

export function resolveForgetPushAction(isCurrentMachine: boolean, remainingPairings: number): ForgetPushAction {
    if (!isCurrentMachine) return 'none';
    return remainingPairings === 0 ? 'delete-endpoint' : 'rebind-endpoint';
}

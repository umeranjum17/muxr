export async function iosConnectionProof(ui, labels) {
    const nodes = await ui.ui();
    const values = nodes.map((node) => String(node.AXLabel ?? '').trim());
    const disconnected = values.some((value) => /^(disconnected|reconnecting|connecting)$/i.test(value));
    const connected = !disconnected && values.some((value) => /^connected$/i.test(value));
    const fixture = labels.find((label) => values.some((value) => value === label));
    return { connected, fixture, nodes };
}

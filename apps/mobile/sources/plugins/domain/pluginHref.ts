/** Generic content mount for any plugin navigation destination. */
export function pluginHref(pluginId: string, contentId: string, params?: Record<string, string>): string {
    const query = new URLSearchParams({ pluginId, contentId });
    if (params !== undefined) query.set('params', JSON.stringify(params));
    return `/plugin?${query.toString()}`;
}

import type { DisplayText } from '@trymuxr/contract';

export const MAX_CHART_SERIES = 8;
export const MAX_CHART_LABEL_BYTES = 24;

export interface ScreenChartNode {
    type: 'chart';
    /**
     * bar ranks categories, column reads a series over time left to right,
     * gauge carries one value against its ceiling, ring splits a whole.
     */
    variant: 'bar' | 'column' | 'gauge' | 'ring';
    /** Runtime path to bounded `{ label, value, valueLabel?, detail?, tone? }` entries. */
    path: string;
    title?: DisplayText;
    emptyText?: DisplayText;
}

export interface ScreenLimitsNode {
    type: 'limits';
    /** Runtime path to a bounded Usage limits payload. */
    path: string;
    /** Section label; the plan name renders beside it from the payload. */
    title?: DisplayText;
    /** Shown as one quiet line when the payload has no windows and no message. */
    emptyText?: DisplayText;
}

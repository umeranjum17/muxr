import { describe, expect, it } from 'vitest';
import { stripLeadingTaskNotificationWrappers } from './controlMessages.js';

const notification = `<task-notification>
<task-id>agent-123</task-id>
<status>completed</status>
<summary>Background agent completed</summary>
<result>Useful but already-rendered result</result>
<usage><subagent_tokens>29207</subagent_tokens><tool_uses>14</tool_uses></usage>
</task-notification>`;

describe('stripLeadingTaskNotificationWrappers', () => {
    it('removes a control-only task notification and preserves following text', () => {
        expect(stripLeadingTaskNotificationWrappers(notification)).toBe('');
        expect(stripLeadingTaskNotificationWrappers(`${notification}\n${notification}\nContinue with the fix`))
            .toBe('Continue with the fix');
        const nested = `<task-notification>outer ${notification}</task-notification>\nVisible`;
        expect(stripLeadingTaskNotificationWrappers(nested)).toBe('Visible');
        const malformed = '<task-notification>unfinished';
        const inline = 'Explain <task-notification> wrappers';
        expect(stripLeadingTaskNotificationWrappers(malformed)).toBe(malformed);
        expect(stripLeadingTaskNotificationWrappers(inline)).toBe(inline);
    });
});

/**
 * Turn a hidden text field's before/after into the keystrokes the remote
 * page needs. The remote caret sits at the end of what we typed, so an edit
 * anywhere is "delete back to the common prefix, then retype the tail" --
 * corrections work instead of being appended as if new.
 */
export function textEdits(previous: string, next: string): { deletions: number; inserted: string } {
    let prefix = 0;
    const limit = Math.min(previous.length, next.length);
    while (prefix < limit && previous[prefix] === next[prefix]) prefix += 1;
    return { deletions: previous.length - prefix, inserted: next.slice(prefix) };
}

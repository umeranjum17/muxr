/** Only explicit consecutive one-key numbered menus can be answered without typing. */
export function noticeChoices(question: string | undefined): Array<{ id: string; label: string }> {
    if (question === undefined || question.endsWith('…')) return [];
    const choices = question.split('\n').flatMap((line) => {
        const match = /^(?:[>❯›]\s*)?([1-9])[.)]\s+(.+)$/.exec(line.trim());
        return match === null ? [] : [{ id: match[1]!, label: match[2]! }];
    });
    // iOS shows at most four actions; leave larger or ambiguous menus to typed Answer.
    if (choices.length < 2 || choices.length > 3 || choices.some((choice, index) => choice.id !== String(index + 1))) return [];
    return choices;
}

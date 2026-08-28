type ComposerInputMaxHeightInput = {
    // Height of the flex slot the composer sits in — i.e. the space actually
    // left over under the config card. 0 before the first layout pass.
    slotHeight: number;
    // Whole composer box, and the row holding just the text field. The
    // difference is chrome (attachment strip, action buttons, box padding),
    // which changes at runtime and so has to be measured rather than assumed.
    composerHeight: number;
    fieldHeight: number;
    fieldVerticalPadding: number;
    lineHeight: number;
    hardCap: number;
    fallback: number;
};

// Nothing under the composer shrinks, so the input has to stop growing at the
// bottom of its slot or the action buttons walk off the screen.
export function getComposerInputMaxHeight(input: ComposerInputMaxHeightInput) {
    if (input.slotHeight <= 0 || input.fieldHeight <= 0) {
        return input.fallback;
    }
    const chrome = input.composerHeight - input.fieldHeight + input.fieldVerticalPadding * 2;
    return Math.max(
        input.lineHeight * 3,
        Math.min(input.hardCap, input.slotHeight - chrome),
    );
}

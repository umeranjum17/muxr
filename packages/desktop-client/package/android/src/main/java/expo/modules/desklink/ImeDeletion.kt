package expo.modules.desklink

internal fun remoteDeletionCounts(
  beforeLength: Int,
  afterLength: Int,
  selectionStart: Int,
  selectionEnd: Int,
  composingStart: Int,
  composingEnd: Int,
): Pair<Int, Int> {
  fun committed(length: Int, from: Long, to: Long): Int {
    val local = if (composingStart >= 0 && composingEnd > composingStart) {
      (minOf(to, composingEnd.toLong()) - maxOf(from, composingStart.toLong())).coerceAtLeast(0)
    } else 0L
    return (length.toLong() - local).coerceIn(0, 64).toInt()
  }

  return committed(beforeLength, selectionStart.toLong() - beforeLength, selectionStart.toLong()) to
    committed(afterLength, selectionEnd.toLong(), selectionEnd.toLong() + afterLength)
}

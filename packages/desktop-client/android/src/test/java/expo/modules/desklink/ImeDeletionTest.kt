package expo.modules.desklink

import org.junit.Assert.assertEquals
import org.junit.Test

class ImeDeletionTest {
  @Test fun composingEditsStayLocalWhileCommittedTextDeletesRemotely() {
    assertEquals(0 to 0, remoteDeletionCounts(1, 0, 3, 3, 2, 5))
    assertEquals(0 to 0, remoteDeletionCounts(0, 1, 3, 3, 2, 5))
    assertEquals(2 to 0, remoteDeletionCounts(3, 0, 3, 3, 2, 5))
    assertEquals(0 to 1, remoteDeletionCounts(0, 2, 4, 4, 2, 5))
    assertEquals(1 to 0, remoteDeletionCounts(1, 0, 3, 3, -1, -1))
  }
}

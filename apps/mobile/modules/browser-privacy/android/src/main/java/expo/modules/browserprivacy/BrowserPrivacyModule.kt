package expo.modules.browserprivacy

import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * FLAG_SECURE while the agent browser is private: no app-switcher thumbnail,
 * no screenshot, no screen recording of the sign-in. Cleared on hand back.
 * Picture-in-picture is never entered: the activity does not declare it and
 * the private view never requests it.
 */
class BrowserPrivacyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BrowserPrivacy")

    Function("setPrivate") { active: Boolean ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread {
        if (active) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      true
    }

    OnDestroy {
      appContext.currentActivity?.let { activity ->
        activity.runOnUiThread { activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
      }
    }
  }
}

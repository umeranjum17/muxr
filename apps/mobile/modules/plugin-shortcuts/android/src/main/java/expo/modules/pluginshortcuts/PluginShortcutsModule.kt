package expo.modules.pluginshortcuts

import android.content.Intent
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Generic Android launcher projection of the current approved plugin catalog. */
class PluginShortcutsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PluginShortcuts")

    Function("setShortcuts") { shortcuts: List<Map<String, Any?>>, bakedIds: List<String> ->
      val context = appContext.reactContext ?: return@Function false
      runCatching {
        val activeIds = shortcuts.mapNotNull { it["id"] as? String }.toSet()
        val baked = bakedIds.distinct()
        val enabledBaked = ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_MANIFEST)
          .filter { it.id in activeIds }
        val disabledBaked = baked.filterNot(activeIds::contains)
        if (enabledBaked.isNotEmpty()) runCatching { ShortcutManagerCompat.enableShortcuts(context, enabledBaked) }
        if (disabledBaked.isNotEmpty()) runCatching { ShortcutManagerCompat.disableShortcuts(context, disabledBaked, "Plugin disabled") }

        val capacity = (ShortcutManagerCompat.getMaxShortcutCountPerActivity(context) - baked.size).coerceAtLeast(0)
        val icon = IconCompat.createWithResource(context, context.applicationInfo.icon)
        val activity = context.packageManager.getLaunchIntentForPackage(context.packageName)?.component
          ?: error("Main activity unavailable")
        val schemeResource = context.resources.getIdentifier("muxr_link_scheme", "string", context.packageName)
        val scheme = if (schemeResource != 0) context.getString(schemeResource) else "muxr"
        val dynamic = shortcuts.asSequence()
          .mapNotNull { shortcut ->
            val id = shortcut["id"] as? String ?: return@mapNotNull null
            if (id in baked) return@mapNotNull null
            val label = shortcut["label"] as? String ?: return@mapNotNull null
            val longLabel = shortcut["longLabel"] as? String ?: label
            ShortcutInfoCompat.Builder(context, id)
              .setShortLabel(label)
              .setLongLabel(longLabel)
              .setIcon(icon)
              .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse("$scheme://shortcut/$id")).setComponent(activity))
              .build()
          }
          .take(capacity)
          .toList()
        ShortcutManagerCompat.setDynamicShortcuts(context, dynamic)
      }.getOrDefault(false)
    }
  }
}

package expo.modules.artifactopen

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Opens a downloaded artifact with whatever the system offers for its type. */
class ArtifactOpenModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ArtifactOpen")

    // The package installer for an APK, a viewer for the rest. false: nothing
    // on the device handles the type, so the caller falls back to sharing.
    Function("open") { contentUri: String, mimeType: String ->
      val activity = appContext.currentActivity ?: return@Function false
      // A store build does not declare the install permission, and the
      // installer refuses a source app that lacks it: share the APK instead.
      if (mimeType == APK && !declaresInstallPermission(activity.packageManager, activity.packageName)) return@Function false
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(Uri.parse(contentUri), mimeType)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      runCatching { activity.startActivity(intent) }.isSuccess
    }
  }

  private fun declaresInstallPermission(packages: PackageManager, name: String): Boolean =
    packages.getPackageInfo(name, PackageManager.GET_PERMISSIONS).requestedPermissions
      ?.contains(Manifest.permission.REQUEST_INSTALL_PACKAGES) == true

  private companion object {
    const val APK = "application/vnd.android.package-archive"
  }
}

package expo.modules.tailnetaddress

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Whether Tailscale is on and signed in on this phone: its VPN is a tun
 * interface holding an address in 100.64.0.0/10, and it has none while off or
 * signed out. The name filter keeps a carrier's CGNAT address on mobile data
 * from counting.
 */
class TailnetAddressModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TailnetAddress")

    Function("present") {
      NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().any { nic ->
        nic.name.startsWith("tun") && nic.isUp && nic.inetAddresses.toList().any { address ->
          address is Inet4Address && address.address[0] == 100.toByte() && (address.address[1].toInt() and 0xC0) == 64
        }
      }
    }

    // Opens the installed Tailscale app; false when it is not installed.
    Function("openApp") {
      val activity = appContext.currentActivity ?: return@Function false
      val intent = activity.packageManager.getLaunchIntentForPackage("com.tailscale.ipn") ?: return@Function false
      runCatching { activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
    }
  }
}

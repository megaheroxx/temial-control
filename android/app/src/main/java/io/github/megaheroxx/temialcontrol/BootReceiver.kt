package io.github.megaheroxx.temialcontrol

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts the notification service after the phone reboots. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) syncWatchService(context)
    }
}

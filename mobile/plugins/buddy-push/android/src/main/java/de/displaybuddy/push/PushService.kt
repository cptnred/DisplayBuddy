package de.displaybuddy.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM entry points (Firebase docs „Receive messages in an Android app“):
 * - onMessageReceived: only called for notification messages while the app is in the
 *   foreground (in the background the system shows the notification itself and a tap
 *   opens the app with the data as intent extras, see PushPlugin.tapData);
 * - onNewToken: the registration token changed → the web layer registers it again.
 * Both are forwarded to the running plugin; without a running app there is nothing to do
 * (the next start fetches the current token anyway).
 */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        PushPlugin.instance?.emitMessage(message.data, message.notification?.title, message.notification?.body)
    }

    override fun onNewToken(token: String) {
        PushPlugin.instance?.emitToken(token)
    }
}

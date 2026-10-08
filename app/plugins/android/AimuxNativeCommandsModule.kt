package app.aimux.mobile

import android.content.res.Configuration
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference

/// The Android half of the bridge `app/lib/native-app-commands.ts` talks to,
/// mirroring `plugins/ios/AimuxNativeCommands.swift`. The send-key rule lives
/// here rather than in the patched MainActivity so one file holds it. This file
/// is COPIED into `android/` at prebuild; edit it here, not there.
class AimuxNativeCommandsModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

  init {
    sharedEmitter = WeakReference(this)
    // A new instance means a new JS context, which has no focused composer yet.
    // The flag is process-scoped and a JS fatal or reload runs no cleanup, so a
    // stale `true` would make Enter consumed and dead app-wide.
    isChatComposerFocused = false
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun getHardwareKeyboardConnected(promise: Promise) {
    // The activity's configuration, matching what `onConfigurationChanged`
    // reports; the application's carries no per-display override.
    val configuration =
      reactContext.currentActivity?.resources?.configuration
        ?: reactContext.resources.configuration
    promise.resolve(isHardwareKeyboardConnected(configuration))
  }

  @ReactMethod
  fun setChatComposerFocused(focused: Boolean) {
    isChatComposerFocused = focused
  }

  /// `NativeEventEmitter` warns unless the module it is handed carries both of
  /// these; Android delivers the events through `RCTDeviceEventEmitter`
  /// regardless, so they have nothing to do.
  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Double) = Unit

  companion object {
    const val NAME = "AimuxNativeCommands"

    private var sharedEmitter: WeakReference<AimuxNativeCommandsModule>? = null

    @Volatile
    var isChatComposerFocused: Boolean = false
      private set

    @Volatile
    private var lastHardwareKeyboardConnected: Boolean? = null

    /// False when nobody could be told, so the caller can let the key through
    /// rather than swallow it: a consumed `chatSend` that never arrives is a
    /// keystroke that produced neither a send nor a newline.
    fun emit(command: String): Boolean {
      val module = sharedEmitter?.get()
      val context = module?.reactContext
      if (context == null || !context.hasActiveReactInstance()) {
        Log.w(NAME, "dropped $command: no active react instance")
        return false
      }
      val payload = Arguments.createMap().apply { putString("command", command) }
      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT, payload)
      return true
    }

    /// Android can be asked, unlike the web. `hardKeyboardHidden` is the usable
    /// half -- a keyboard can be attached and folded away -- and QWERTY rather
    /// than any keyboard, to agree with `KEYBOARD_TYPE_ALPHABETIC` below.
    fun isHardwareKeyboardConnected(configuration: Configuration): Boolean =
      configuration.keyboard == Configuration.KEYBOARD_QWERTY &&
        configuration.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO

    /// The mirror of `GCKeyboardDidConnect`: the manifest's `configChanges`
    /// includes `keyboard|keyboardHidden`, so the activity is told rather than
    /// recreated. Only an actual change is worth saying -- a rotation is not.
    fun emitHardwareKeyboardChanged(configuration: Configuration) {
      val connected = isHardwareKeyboardConnected(configuration)
      if (lastHardwareKeyboardConnected == connected) return
      // Recorded only once told, so a dropped notice is not consumed.
      if (emit(COMMAND_HARDWARE_KEYBOARD_CHANGED)) {
        lastHardwareKeyboardConnected = connected
      }
    }

    /// The mirror of Swift's `command(for:)`: the whole decision, including the
    /// composer-focus check, so no caller can make half of it. Null means the
    /// key is not ours and must fall through to the text view.
    fun commandForKeyEvent(event: KeyEvent): String? =
      if (isChatComposerFocused && isSendKeyEvent(event)) COMMAND_CHAT_SEND else null

    /// The mirror of Swift's `isSendReturnKey`. `hasNoModifiers()` is the same
    /// predicate AOSP's `TextView.doKeyDown` uses to raise the editor action,
    /// so Shift+Enter falls through as a newline here and there alike -- and
    /// caps lock is outside `META_MODIFIER_MASK`, so it still sends.
    fun isSendKeyEvent(event: KeyEvent): Boolean =
      event.action == KeyEvent.ACTION_DOWN &&
        // Android auto-repeats a held key as more ACTION_DOWNs; iOS fires once
        // on `.began`. Without this, holding Enter sends once per repeat.
        event.repeatCount == 0 &&
        isReturnKeyCode(event.keyCode) &&
        event.hasNoModifiers() &&
        isHardwareKeyboardEvent(event)

    private fun isReturnKeyCode(keyCode: Int): Boolean =
      keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER

    /// Identity, not spelling. `isVirtual` is `id < 0`, which is what every
    /// injected event carries -- an IME, `Instrumentation`, adb -- so a soft
    /// keyboard cannot pass, and letter keys are then required.
    private fun isHardwareKeyboardEvent(event: KeyEvent): Boolean {
      val device = event.device ?: return false
      return !device.isVirtual &&
        (event.source and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD &&
        device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
    }

    private const val EVENT = "AimuxNativeCommand"

    /// Must stay in `NATIVE_APP_COMMANDS` in `lib/native-app-commands.ts`,
    /// which is an allowlist: a command missing from it is dropped in silence.
    private const val COMMAND_CHAT_SEND = "chatSend"
    private const val COMMAND_HARDWARE_KEYBOARD_CHANGED = "hardwareKeyboardChanged"
  }
}

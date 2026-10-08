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
  }

  override fun getName(): String = NAME

  /// Android can be asked, unlike the web. `hardKeyboardHidden` is the usable
  /// half: a keyboard can be attached and folded away, and then its keys
  /// cannot be pressed.
  @ReactMethod
  fun getHardwareKeyboardConnected(promise: Promise) {
    val config: Configuration = reactContext.resources.configuration
    promise.resolve(
      config.keyboard != Configuration.KEYBOARD_NOKEYS &&
        config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
    )
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

    fun emit(command: String) {
      val module = sharedEmitter?.get()
      val context = module?.reactContext
      if (context == null || !context.hasActiveReactInstance()) {
        // Not an error: JS asks for the current answer when it mounts, so a
        // notice with nobody to hear it is only worth saying out loud.
        Log.i(NAME, "dropped $command: no active react instance")
        return
      }
      val payload = Arguments.createMap().apply { putString("command", command) }
      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT, payload)
    }

    /// A keyboard attached after launch changes the answer, and the manifest's
    /// `configChanges` includes `keyboard|keyboardHidden`, so the activity is
    /// told instead of recreated. The mirror of `GCKeyboardDidConnect`.
    fun emitHardwareKeyboardChanged() = emit(HARDWARE_KEYBOARD_CHANGED)

    /// The mirror of Swift's `command(for:)`: the whole decision, including the
    /// composer-focus check, so no caller can make half of it. Null means the
    /// key is not ours and must fall through to the text view.
    fun commandForKeyEvent(event: KeyEvent): String? =
      if (isChatComposerFocused && isSendKeyEvent(event)) CHAT_SEND else null

    /// The mirror of Swift's `isSendReturnKey`. `hasNoModifiers()` is the same
    /// predicate AOSP's `TextView.doKeyDown` uses to raise the editor action,
    /// so Shift+Enter falls through as a newline here and there alike -- and
    /// caps lock is outside `META_MODIFIER_MASK`, so it still sends.
    fun isSendKeyEvent(event: KeyEvent): Boolean =
      event.action == KeyEvent.ACTION_DOWN &&
        isReturnKeyCode(event.keyCode) &&
        event.hasNoModifiers() &&
        isHardwareKeyboardEvent(event)

    private fun isReturnKeyCode(keyCode: Int): Boolean =
      keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER

    /// Identity, not spelling. An IME injects events as
    /// `KeyCharacterMap.VIRTUAL_KEYBOARD` (-1) and the built-in keypad is 0, so
    /// only a real attached keyboard with letter keys gets past this.
    private fun isHardwareKeyboardEvent(event: KeyEvent): Boolean =
      event.deviceId > 0 &&
        (event.source and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD &&
        event.device?.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC

    private const val EVENT = "AimuxNativeCommand"

    /// Must stay in `NATIVE_APP_COMMANDS` in `lib/native-app-commands.ts`,
    /// which is an allowlist: a command missing from it is dropped in silence.
    private const val CHAT_SEND = "chatSend"
    private const val HARDWARE_KEYBOARD_CHANGED = "hardwareKeyboardChanged"
  }
}

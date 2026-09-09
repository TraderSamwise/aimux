#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(AimuxNativeCommands, RCTEventEmitter)
RCT_EXTERN_METHOD(setChatComposerFocused:(BOOL)focused)
RCT_EXTERN_METHOD(getHardwareKeyboardConnected:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end

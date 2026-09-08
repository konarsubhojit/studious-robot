#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(AttachmentOpener, NSObject)

RCT_EXTERN_METHOD(open:(NSString *)path
                  mimeType:(NSString *)mimeType
                  name:(NSString *)name
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end

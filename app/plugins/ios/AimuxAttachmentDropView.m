#import <React/RCTComponent.h>
#import <React/RCTView.h>
#import <React/RCTViewManager.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <UIKit/UIKit.h>

@interface AimuxAttachmentDropView : RCTView <UIDropInteractionDelegate>
@property (nonatomic, copy) RCTBubblingEventBlock onDropImages;
@end

@implementation AimuxAttachmentDropView

- (instancetype)initWithFrame:(CGRect)frame
{
  if ((self = [super initWithFrame:frame])) {
    UIDropInteraction *interaction = [[UIDropInteraction alloc] initWithDelegate:self];
    [self addInteraction:interaction];
  }
  return self;
}

- (BOOL)dropInteraction:(UIDropInteraction *)interaction canHandleSession:(id<UIDropSession>)session
{
  return [session hasItemsConformingToTypeIdentifiers:@[ UTTypeImage.identifier ]];
}

- (UIDropProposal *)dropInteraction:(UIDropInteraction *)interaction
                 sessionDidUpdate:(id<UIDropSession>)session
{
  return [[UIDropProposal alloc] initWithDropOperation:UIDropOperationCopy];
}

- (void)dropInteraction:(UIDropInteraction *)interaction performDrop:(id<UIDropSession>)session
{
  NSMutableArray<UIDragItem *> *imageItems = [NSMutableArray new];
  for (UIDragItem *item in session.items) {
    if ([item.itemProvider hasItemConformingToTypeIdentifier:UTTypeImage.identifier]) {
      [imageItems addObject:item];
    }
  }
  if (imageItems.count == 0 || self.onDropImages == nil) {
    return;
  }

  dispatch_group_t group = dispatch_group_create();
  NSMutableArray<NSDictionary *> *images = [NSMutableArray new];
  NSObject *lock = [NSObject new];

  for (UIDragItem *item in imageItems) {
    NSItemProvider *provider = item.itemProvider;
    NSString *typeIdentifier = [self preferredImageTypeIdentifierForProvider:provider];
    if (typeIdentifier == nil) {
      continue;
    }

    dispatch_group_enter(group);
    [provider loadDataRepresentationForTypeIdentifier:typeIdentifier
                                    completionHandler:^(NSData *_Nullable data, NSError *_Nullable error) {
                                      if (data != nil && error == nil) {
                                        NSString *mimeType = [self mimeTypeForTypeIdentifier:typeIdentifier];
                                        NSString *filename = [self filenameForProvider:provider mimeType:mimeType];
                                        NSDictionary *image = @{
                                          @"filename" : filename,
                                          @"mimeType" : mimeType,
                                          @"dataBase64" : [data base64EncodedStringWithOptions:0],
                                          @"sizeBytes" : @(data.length)
                                        };
                                        @synchronized(lock) {
                                          [images addObject:image];
                                        }
                                      }
                                      dispatch_group_leave(group);
                                    }];
  }

  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    if (images.count > 0 && self.onDropImages != nil) {
      self.onDropImages(@{@"images" : images});
    }
  });
}

- (NSString *)preferredImageTypeIdentifierForProvider:(NSItemProvider *)provider
{
  NSMutableArray<UTType *> *preferredTypes = [NSMutableArray arrayWithObjects:UTTypePNG, UTTypeJPEG, UTTypeGIF, nil];
  UTType *webPType = [UTType typeWithIdentifier:@"org.webmproject.webp"];
  if (webPType != nil) {
    [preferredTypes addObject:webPType];
  }
  [preferredTypes addObject:UTTypeImage];

  for (UTType *type in preferredTypes) {
    if ([provider hasItemConformingToTypeIdentifier:type.identifier]) {
      return type.identifier;
    }
  }
  return nil;
}

- (NSString *)mimeTypeForTypeIdentifier:(NSString *)typeIdentifier
{
  UTType *type = [UTType typeWithIdentifier:typeIdentifier];
  NSString *mimeType = type.preferredMIMEType;
  return mimeType ?: @"image/png";
}

- (NSString *)filenameForProvider:(NSItemProvider *)provider mimeType:(NSString *)mimeType
{
  NSString *suggestedName = provider.suggestedName;
  if (suggestedName.length > 0 && [suggestedName containsString:@"."]) {
    return suggestedName;
  }
  NSString *extension = @"png";
  if ([mimeType isEqualToString:@"image/jpeg"]) {
    extension = @"jpg";
  } else if ([mimeType isEqualToString:@"image/gif"]) {
    extension = @"gif";
  } else if ([mimeType isEqualToString:@"image/webp"]) {
    extension = @"webp";
  }
  return [NSString stringWithFormat:@"%@.%@", suggestedName.length > 0 ? suggestedName : @"image", extension];
}

@end

@interface AimuxAttachmentDropViewManager : RCTViewManager
@end

@implementation AimuxAttachmentDropViewManager

RCT_EXPORT_MODULE(AimuxAttachmentDropView)
RCT_EXPORT_VIEW_PROPERTY(onDropImages, RCTBubblingEventBlock)

- (UIView *)view
{
  return [AimuxAttachmentDropView new];
}

@end

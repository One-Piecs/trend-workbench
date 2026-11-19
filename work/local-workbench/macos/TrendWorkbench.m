#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

static NSString *const productName = @"趋势判断工作台";
static NSString *const origin = @"http://127.0.0.1:43127";

@interface WorkbenchDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate>
@property(strong) NSWindow *window;
@property(strong) WKWebView *view;
@property(strong) NSTextField *starting;
@property(strong) NSTask *service;
@property(strong) NSMapTable<WKDownload *, NSURL *> *downloads;
@property BOOL ready;
@property BOOL closing;
@end

@implementation WorkbenchDelegate

- (void)showError:(NSString *)message {
    NSAlert *alert = [NSAlert new];
    alert.messageText = productName;
    alert.informativeText = message;
    [alert addButtonWithTitle:@"确定"];
    [alert runModal];
}

- (void)stopWithError:(NSString *)message {
    if (self.closing) return;
    self.closing = YES;
    [self showError:message];
    [NSApp terminate:nil];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.downloads = [NSMapTable strongToStrongObjectsMapTable];
    NSMenu *menu = [NSMenu new];
    NSMenuItem *appItem = [NSMenuItem new];
    [menu addItem:appItem];
    NSMenu *appMenu = [NSMenu new];
    [appMenu addItemWithTitle:@"退出趋势判断工作台" action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = appMenu;
    NSMenuItem *fileItem = [NSMenuItem new];
    [menu addItem:fileItem];
    NSMenu *fileMenu = [[NSMenu alloc] initWithTitle:@"文件"];
    [fileMenu addItemWithTitle:@"关闭窗口" action:@selector(performClose:) keyEquivalent:@"w"];
    fileItem.submenu = fileMenu;
    NSMenuItem *editItem = [NSMenuItem new];
    [menu addItem:editItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"编辑"];
    [editMenu addItemWithTitle:@"剪切" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"拷贝" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"粘贴" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"全选" action:@selector(selectAll:) keyEquivalent:@"a"];
    editItem.submenu = editMenu;
    NSApp.mainMenu = menu;
    NSRect screen = NSScreen.mainScreen.visibleFrame;
    NSRect frame = NSMakeRect(0, 0, MIN(1440, NSWidth(screen) * 0.94), MIN(930, NSHeight(screen) * 0.90));
    self.window = [[NSWindow alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = productName;
    self.window.releasedWhenClosed = NO;
    self.window.minSize = NSMakeSize(420, 350);
    self.starting = [NSTextField labelWithString:@"正在打开工作台…"];
    self.starting.alignment = NSTextAlignmentCenter;
    self.window.contentView = self.starting;
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    NSURL *bundle = NSBundle.mainBundle.bundleURL;
    NSURL *resources = NSBundle.mainBundle.resourceURL;
    self.service = [NSTask new];
    self.service.executableURL = [bundle URLByAppendingPathComponent:@"Contents/Helpers/node"];
    self.service.arguments = @[[resources URLByAppendingPathComponent:@"server.mjs"].path, @"--port", @"43127", @"--announce-ready"];
    self.service.currentDirectoryURL = resources;
    NSPipe *pipe = [NSPipe pipe];
    self.service.standardOutput = pipe;
    self.service.standardError = NSFileHandle.fileHandleWithNullDevice;
    __weak WorkbenchDelegate *owner = self;
    self.service.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{
            WorkbenchDelegate *controller = owner;
            [controller stopWithError:controller.ready ? @"本机行情服务已退出，请重新打开工作台。" :
                @"无法启动本机行情服务。请确认应用已完整解压，并检查本机端口 43127 是否被其他程序占用。"];
        });
    };
    NSError *error = nil;
    if (![self.service launchAndReturnError:&error]) {
        [self stopWithError:error.localizedDescription];
        return;
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @autoreleasepool {
            NSMutableData *pending = [NSMutableData data];
            while (pending.length < 8192) {
                NSData *chunk = pipe.fileHandleForReading.availableData;
                if (!chunk.length) return;
                [pending appendData:chunk];
                NSString *message = [[NSString alloc] initWithData:pending encoding:NSUTF8StringEncoding];
                if (![message containsString:@"TREND_WORKBENCH_READY 43127\n"]) continue;
                dispatch_async(dispatch_get_main_queue(), ^{ [self openWorkbench]; });
                return;
            }
        }
    });
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (!self.ready) [self stopWithError:@"本机行情服务未能及时启动，请重新打开工作台。"];
    });
}

- (void)openWorkbench {
    if (self.ready || self.closing) return;
    self.ready = YES;
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    configuration.websiteDataStore = WKWebsiteDataStore.defaultDataStore;
    self.view = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:configuration];
    self.view.navigationDelegate = self;
    self.view.UIDelegate = self;
    self.window.contentView = self.view;
    [self.window makeFirstResponder:self.view];
    [self.view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:[origin stringByAppendingString:@"/"]]]];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decision {
    NSURL *url = action.request.URL;
    BOOL local = [url.scheme isEqualToString:@"http"] && [url.host isEqualToString:@"127.0.0.1"]
        && [url.port isEqualToNumber:@43127] && !url.user && !url.password;
    if (action.shouldPerformDownload && (local || [url.absoluteString hasPrefix:[@"blob:" stringByAppendingFormat:@"%@/", origin]])) {
        decision(WKNavigationActionPolicyDownload);
    } else if (local && action.targetFrame) {
        decision(WKNavigationActionPolicyAllow);
    } else {
        decision(WKNavigationActionPolicyCancel);
        if (action.navigationType == WKNavigationTypeLinkActivated &&
            ([url.absoluteString isEqualToString:@"https://x.com/bi_9527zx"] ||
             [url.absoluteString isEqualToString:@"https://t.me/jujishou9527"])) {
            [NSWorkspace.sharedWorkspace openURL:url];
        }
    }
}

- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
 initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))completion {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        completion(result == NSModalResponseOK ? panel.URLs : nil);
    }];
}

- (void)webView:(WKWebView *)webView navigationAction:(WKNavigationAction *)action didBecomeDownload:(WKDownload *)download {
    download.delegate = self;
}

// Download to a private file first. A failed or cancelled export must preserve the chosen destination.
- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
    suggestedFilename:(NSString *)suggestedFilename completionHandler:(void (^)(NSURL *))completion {
    NSURL *directory = [[NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES]
        URLByAppendingPathComponent:NSUUID.UUID.UUIDString isDirectory:YES];
    NSError *error = nil;
    if (![NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:NO attributes:nil error:&error]) {
        completion(nil);
        [self showError:error.localizedDescription];
        return;
    }
    NSString *name = suggestedFilename.lastPathComponent;
    if ([name isEqualToString:@"."] || [name isEqualToString:@".."] || !name.length) name = @"TrendWorkbench-export";
    NSURL *file = [directory URLByAppendingPathComponent:name];
    [self.downloads setObject:file forKey:download];
    completion(file);
}

- (void)downloadDidFinish:(WKDownload *)download {
    NSURL *file = [self.downloads objectForKey:download];
    if (!file) return;
    [self.downloads removeObjectForKey:download];
    NSSavePanel *save = [NSSavePanel savePanel];
    save.nameFieldStringValue = file.lastPathComponent;
    [save beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        if (result == NSModalResponseOK) {
            NSError *error = nil;
            NSData *bytes = [NSData dataWithContentsOfURL:file options:NSDataReadingMappedIfSafe error:&error];
            if (!bytes || ![bytes writeToURL:save.URL options:NSDataWritingAtomic error:&error]) [self showError:error.localizedDescription];
        }
        [NSFileManager.defaultManager removeItemAtURL:file.URLByDeletingLastPathComponent error:nil];
    }];
}

- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)data {
    NSURL *file = [self.downloads objectForKey:download];
    if (file) [NSFileManager.defaultManager removeItemAtURL:file.URLByDeletingLastPathComponent error:nil];
    [self.downloads removeObjectForKey:download];
    if (!self.closing && error.code != NSURLErrorCancelled) [self showError:error.localizedDescription];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }
- (void)applicationWillTerminate:(NSNotification *)notification {
    self.closing = YES;
    if (self.service.running) [self.service terminate];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        WorkbenchDelegate * __attribute__((objc_precise_lifetime)) delegate = [WorkbenchDelegate new];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}

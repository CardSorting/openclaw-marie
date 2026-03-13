import SwiftUI
import WebKit
import OpenClawKit
import OpenClawIPC

struct CanvasWebView: NSViewRepresentable {
    let urlString: String?
    
    func makeNSView(context: Context) -> WKWebView {
        let root = FileManager().urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("OpenClaw/canvas", isDirectory: true)
        let schemeHandler = CanvasSchemeHandler(root: root)
        
        let config = WKWebViewConfiguration()
        config.userContentController = WKUserContentController()
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        
        for scheme in CanvasScheme.allSchemes {
            config.setURLSchemeHandler(schemeHandler, forURLScheme: scheme)
        }
        
        // Inject A2UI bridge script
        let deepLinkKey = DeepLinkHandler.currentCanvasKey()
        let bridgeScript = """
        (() => {
          try {
            const allowedSchemes = \(String(describing: CanvasScheme.allSchemes));
            const protocol = location.protocol.replace(':', '');
            if (!allowedSchemes.includes(protocol)) return;
            if (globalThis.__openclawA2UIBridgeInstalled) return;
            globalThis.__openclawA2UIBridgeInstalled = true;

            const deepLinkKey = "\(deepLinkKey)";
            const sessionKey = "main"; // Default to main for integrated view
            const machineName = "\(InstanceIdentity.displayName)";
            const instanceId = "\(InstanceIdentity.instanceId)";

            globalThis.addEventListener('a2uiaction', (evt) => {
              try {
                const payload = evt?.detail ?? evt?.payload ?? null;
                if (!payload || payload.eventType !== 'a2ui.action') return;

                const action = payload.action ?? null;
                const name = action?.name ?? '';
                if (!name) return;

                const context = Array.isArray(action?.context) ? action.context : [];
                const userAction = {
                  id: (globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
                  name,
                  surfaceId: payload.surfaceId ?? 'main',
                  sourceComponentId: payload.sourceComponentId ?? '',
                  dataContextPath: payload.dataContextPath ?? '',
                  timestamp: new Date().toISOString(),
                  ...(context.length ? { context } : {}),
                };

                const handler = globalThis.webkit?.messageHandlers?.openclawCanvasA2UIAction;
                if (handler?.postMessage) {
                  handler.postMessage({ userAction });
                  return;
                }

                const ctx = userAction.context ? (' ctx=' + JSON.stringify(userAction.context)) : '';
                const message =
                  'CANVAS_A2UI action=' + userAction.name +
                  ' session=' + sessionKey +
                  ' surface=' + userAction.surfaceId +
                  ' component=' + (userAction.sourceComponentId || '-') +
                  ' host=' + machineName.replace(/\\s+/g, '_') +
                  ' instance=' + instanceId +
                  ctx +
                  ' default=update_canvas';
                const params = new URLSearchParams();
                params.set('message', message);
                params.set('sessionKey', sessionKey);
                params.set('thinking', 'low');
                params.set('deliver', 'false');
                params.set('channel', 'last');
                params.set('key', deepLinkKey);
                location.href = 'openclaw://agent?' + params.toString();
              } catch {}
            }, true);
          } catch {}
        })();
        """
        config.userContentController.addUserScript(
            WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        return webView
    }
    
    func updateNSView(_ nsView: WKWebView, context: Context) {
        guard let urlString = urlString, let url = URL(string: urlString) else { return }
        
        if nsView.url?.absoluteString != urlString {
            if url.scheme == "file" {
                nsView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            } else {
                nsView.load(URLRequest(url: url))
            }
        }
    }
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, WKNavigationDelegate {
        var parent: CanvasWebView
        
        init(_ parent: CanvasWebView) {
            self.parent = parent
        }
    }
}

import SwiftUI
import WebKit
import OpenClawKit

struct ControlCenterView: View {
    @State private var webView = WKWebView()
    @State private var canvasManager = CanvasManager.shared
    
    var body: some View {
        HSplitView {
            // Left Pane: Chat Content
            ControlCenterWebView(webView: webView)
                .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
            
            // Right Pane: Visual Preview
            VStack(spacing: 0) {
                if let url = canvasManager.currentUrl {
                    CanvasWebView(urlString: url)
                        .transition(.opacity)
                } else {
                    ContentUnavailableView(
                        "No Preview Available",
                        systemImage: "eye.slash",
                        description: Text("Interact with the agent to see a visual preview of the task.")
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.windowBackgroundColor))
                }
            }
            .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
        }
        .edgesIgnoringSafeArea(.all)
        .frame(minWidth: 1000, minHeight: 700)
    }
}

struct ControlCenterWebView: NSViewRepresentable {
    let webView: WKWebView
    
    func makeNSView(context: Context) -> WKWebView {
        let port = GatewayEnvironment.gatewayPort()
        // Use standalone chat mode for the integrated view
        let url = URL(string: "http://localhost:\(port)/chat?standalone=1")!
        
        let config = webView.configuration
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        
        // Pass the control UI base path if needed
        let script = "window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = '/';"
        let userScript = WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(userScript)
        
        webView.load(URLRequest(url: url))
        return webView
    }
    
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

#Preview {
    ControlCenterView()
}

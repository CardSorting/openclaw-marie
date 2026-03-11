import SwiftUI
import WebKit
import OpenClawKit

struct ControlCenterView: View {
    @State private var webView = WKWebView()
    
    var body: some View {
        ControlCenterWebView(webView: webView)
            .edgesIgnoringSafeArea(.all)
            .frame(minWidth: 800, minHeight: 600)
    }
}

struct ControlCenterWebView: NSViewRepresentable {
    let webView: WKWebView
    
    func makeNSView(context: Context) -> WKWebView {
        let port = GatewayEnvironment.gatewayPort()
        let url = URL(string: "http://localhost:\(port)")!
        
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

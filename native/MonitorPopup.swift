import AppKit
import WebKit

final class PopupPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { close() }
}
final class PopupApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var panel: PopupPanel!
    var web: WKWebView!
    var ready = false
    var latest: [String: Any]?
    var input = Data()
    var capture: String?
    var rendering = false
    var revision = 0
    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        guard args.count >= 2 else { NSApp.terminate(nil); return }
        if let i = args.firstIndex(of: "--capture"), i + 1 < args.count { capture = args[i + 1] }
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "close")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 460, height: 580), configuration: config)
        web.navigationDelegate = self
        panel = PopupPanel(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        panel.delegate = self
        panel.contentView = web
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        let url = URL(fileURLWithPath: args[1])
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                guard let self = self else { return }
                if data.isEmpty { NSApp.terminate(nil); return }
                self.input.append(data)
                while let end = self.input.firstIndex(of: 10) {
                    let line = self.input.subdata(in: 0..<end)
                    self.input.removeSubrange(0...end)
                    if let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { self.receive(value) }
                }
            }
        }
    }
    func receive(_ message: [String: Any]) {
        if let data = message["data"] as? [String: Any] { latest = data; revision += 1 }
        if message["type"] as? String == "show" {
            let point = NSEvent.mouseLocation
            let screen = NSScreen.screens.first(where: { $0.frame.contains(point) }) ?? NSScreen.main
            let frame = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let width = min(460, frame.width - 24), height = min(580, frame.height - 24)
            let x = max(frame.minX + 12, min(point.x - width * 0.6, frame.maxX - width - 12))
            let y = max(frame.minY + 12, min(point.y + 12, frame.maxY - height - 12))
            panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: false)
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
        render()
    }
    func render() {
        guard ready, !rendering, let value = latest, let json = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: json, encoding: .utf8) else { return }
        rendering = true
        let sentRevision = revision
        web.evaluateJavaScript("window.render(" + text + ")") { [weak self] _, error in
            guard let self = self else { return }
            self.rendering = false
            if self.revision != sentRevision { self.render() }
            guard error == nil, let path = self.capture else { return }
            self.capture = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                self.web.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                       let png = bitmap.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: path))
                    }
                    NSApp.terminate(nil)
                }
            }
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true; render() }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { panel.close() }
    func windowDidResignKey(_ notification: Notification) { if capture == nil { panel.close() } }
    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = PopupApp()
app.delegate = delegate
app.run()

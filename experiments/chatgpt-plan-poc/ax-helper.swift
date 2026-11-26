// Screen Spirit 輔助使用讀取工具：讀出指定 App 視窗裡的文字，用來把 AI 的回覆帶回小精靈對話框。
// 用法：ax-helper texts <bundle-id>   → {"ok":true,"texts":[{"t":文字,"p":段落代號}],"stop":是否有停止鈕}
//       ax-helper dump  <bundle-id>   → 視窗的輔助使用結構（除錯用，文字截短）
//       ax-helper frame <bundle-id>   → 目前視窗的位置與大小
//       ax-helper move  <bundle-id> x y 寬 高 → 移動並縮放視窗（座標與 Electron 相同：主螢幕左上角為原點）
//       ax-helper selected-text <pid>   → 該程式目前反白的文字（讀不到時回傳空字串）
//       ax-helper mods                   → 使用者是否還按著 ⌘⇧⌥⌃
//       ax-helper watch-front            → 常駐：每次切換前景程式就輸出一行 {"pid":…,"bundleId":…}（抽屜模式用）
//       ax-helper send-state <bundle-id> → 送出按鈕找不找得到、能不能按（等圖片上傳完成用）
//       ax-helper slide <id> 起點x 終點x y 毫秒 [曲線] → 在同一個行程內依時間逐格移動視窗（抽屜滑出／收起）
//                                         曲線：expo-out（預設，快出慢停）、expo-in、expo-in-out
//       ax-helper idle                   → 距離上次按鍵盤、動滑鼠各幾秒（判斷使用者是不是還在操作）
//       ax-helper snap <id> <輸出.png>    → 用 ScreenCaptureKit 擷取該 App 最大的視窗（被遮住也截得到；macOS 14+）
//       ax-helper ocr <圖片.png>          → 用 macOS Vision 在本機辨識圖片中的文字（給不能看圖的模型用）
//       ax-helper hide-app|show-app <id>      → 隱藏／顯示整個 App（右邊還有螢幕、不能滑出去時的退路）
// <bundle-id> 也可以直接給行程編號（pid），用來移動圈選來源的程式視窗。
// 第一次使用時由小精靈以 `xcrun swiftc` 自動編譯；需要「輔助使用」權限。
import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit
import Vision

func emit(_ object: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: []),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"ok\":false,\"error\":\"json\"}")
    }
}

func copyAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return result == .success ? value : nil
}

func asElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = copyAttribute(element, name) else { return nil }
    return value as? String
}

func childElements(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = copyAttribute(element, "AXChildren"), let array = value as? [AXUIElement] else { return [] }
    return array
}

func findWindow(_ app: AXUIElement) -> AXUIElement? {
    if let window = asElement(copyAttribute(app, "AXFocusedWindow")) { return window }
    if let window = asElement(copyAttribute(app, "AXMainWindow")) { return window }
    if let value = copyAttribute(app, "AXWindows"), let windows = value as? [AXUIElement], let first = windows.first { return first }
    return nil
}

let arguments = CommandLine.arguments
if arguments.count >= 2 && arguments[1] == "watch-front" {
    // 事件驅動、不輪詢：系統通知「前景程式換了」才輸出；父行程（小精靈）結束時自己也結束
    setvbuf(stdout, nil, _IOLBF, 0)
    func report(_ app: NSRunningApplication?) {
        guard let app = app else { return }
        emit(["pid": Int(app.processIdentifier), "bundleId": app.bundleIdentifier ?? ""])
        fflush(stdout)
    }
    report(NSWorkspace.shared.frontmostApplication)
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
        report(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
    }
    let parent = getppid()
    Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
        if getppid() != parent { exit(0) }
    }
    RunLoop.main.run()
}
if arguments.count >= 2 && arguments[1] == "ocr" {
    guard arguments.count >= 3, let image = NSImage(contentsOfFile: arguments[2]),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        emit(["ok": false, "error": "cannot-read-image"])
        exit(2)
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let wanted = ["zh-Hant", "zh-Hans", "en-US", "ja-JP"]
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    let languages = wanted.filter { supported.contains($0) }
    if !languages.isEmpty { request.recognitionLanguages = languages }
    do {
        try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
        // 依畫面由上到下、由左到右排列（Vision 的座標原點在左下）
        let observations = (request.results ?? []).sorted {
            abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.01 ? $0.boundingBox.midY > $1.boundingBox.midY : $0.boundingBox.minX < $1.boundingBox.minX
        }
        let lines = observations.compactMap { $0.topCandidates(1).first?.string }
        emit(["ok": true, "text": lines.joined(separator: "\n"), "lines": lines.count, "languages": languages])
    } catch {
        emit(["ok": false, "error": String(describing: error)])
    }
    exit(0)
}
if arguments.count >= 2 && arguments[1] == "idle" {
    let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
    // 滑鼠：移動、點擊、捲動，取最近的一次（工作流要等使用者停手才操作其他 App）
    let mouseTypes: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .leftMouseDragged, .scrollWheel]
    let mouseSeconds = mouseTypes.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 999
    emit(["ok": true, "keySeconds": seconds, "mouseSeconds": mouseSeconds])
    exit(0)
}
if arguments.count >= 2 && arguments[1] == "mods" {
    let flags = NSEvent.modifierFlags.intersection([.command, .shift, .option, .control])
    emit(["ok": true, "down": !flags.isEmpty])
    exit(0)
}
guard arguments.count >= 3 else {
    emit(["ok": false, "error": "usage: ax-helper texts|dump <bundle-id>"])
    exit(2)
}
let command = arguments[1]
let bundleId = arguments[2]

guard AXIsProcessTrusted() else {
    emit(["ok": false, "error": "not-trusted"])
    exit(3)
}
let runningApp: NSRunningApplication?
if let pid = Int32(bundleId), pid > 0 {
    runningApp = NSRunningApplication(processIdentifier: pid)
} else {
    runningApp = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
}
guard let running = runningApp else {
    emit(["ok": false, "error": "not-running"])
    exit(4)
}

let appElement = AXUIElementCreateApplication(running.processIdentifier)
AXUIElementSetMessagingTimeout(appElement, 3.0)
var switches: [String: Any] = [:]
if command == "texts" || command == "dump" || command == "send-state" {
    // Electron／Chromium 的 App 預設不建立網頁內容的輔助使用樹，要先打開：
    // AXManualAccessibility 是 Electron 的開關，AXEnhancedUserInterface 是 Chromium／VoiceOver 用的開關，兩個都設。
    let manualResult = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let enhancedResult = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    switches = ["manual": Int(manualResult.rawValue), "enhanced": Int(enhancedResult.rawValue)]
}

func readFrame(_ window: AXUIElement) -> [String: Double]? {
    guard let positionRef = copyAttribute(window, "AXPosition"), let sizeRef = copyAttribute(window, "AXSize"),
          CFGetTypeID(positionRef) == AXValueGetTypeID(), CFGetTypeID(sizeRef) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(positionRef as! AXValue, .cgPoint, &point)
    AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
    return ["x": Double(point.x), "y": Double(point.y), "width": Double(size.width), "height": Double(size.height)]
}

func writeFrame(_ window: AXUIElement, _ rect: CGRect) -> Int {
    var point = rect.origin
    var size = rect.size
    guard let pointValue = AXValueCreate(.cgPoint, &point), let sizeValue = AXValueCreate(.cgSize, &size) else { return -1 }
    // 先縮放再移動、最後再縮放一次：避免視窗被螢幕邊緣擋住而大小不對
    _ = AXUIElementSetAttributeValue(window, "AXSize" as CFString, sizeValue)
    let positionResult = AXUIElementSetAttributeValue(window, "AXPosition" as CFString, pointValue)
    _ = AXUIElementSetAttributeValue(window, "AXSize" as CFString, sizeValue)
    return Int(positionResult.rawValue)
}

// ── snap：抽屜「替身動畫」用的視窗截圖 ──
final class SnapResult: @unchecked Sendable { var value: [String: Any] = ["ok": false, "error": "timeout"] }

@available(macOS 14.0, *)
func snapWindow(pid: pid_t, outPath: String, into box: SnapResult) async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let candidates = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 100 && $0.frame.height > 100 }
        guard let target = candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            box.value = ["ok": false, "error": "no-window"]
            return
        }
        let configuration = SCStreamConfiguration()
        let scale = NSScreen.screens.map { $0.backingScaleFactor }.max() ?? 2
        configuration.width = Int(target.frame.width * scale)
        configuration.height = Int(target.frame.height * scale)
        configuration.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: target), configuration: configuration)
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            box.value = ["ok": false, "error": "encode"]
            return
        }
        try data.write(to: URL(fileURLWithPath: outPath), options: .atomic)
        box.value = ["ok": true, "width": image.width, "height": image.height]
    } catch {
        box.value = ["ok": false, "error": String(describing: error)]
    }
}

if command == "snap" {
    guard arguments.count >= 4 else {
        emit(["ok": false, "error": "usage: ax-helper snap <id> <out.png>"])
        exit(2)
    }
    guard #available(macOS 14.0, *) else {
        emit(["ok": false, "error": "needs-macos-14"])
        exit(7)
    }
    let box = SnapResult()
    let semaphore = DispatchSemaphore(value: 0)
    let pid = running.processIdentifier
    let outPath = arguments[3]
    Task.detached(priority: .userInitiated) {
        await snapWindow(pid: pid, outPath: outPath, into: box)
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 4)
    emit(box.value)
    exit(0)
}

if command == "hide-app" || command == "show-app" {
    let done = command == "hide-app" ? running.hide() : running.unhide()
    emit(["ok": done])
    exit(0)
}

guard let window = findWindow(appElement) else {
    emit(["ok": false, "error": "no-window"])
    exit(5)
}

var visited = 0
let maxNodes = 40000

if command == "texts" {
    var texts: [[String: Any]] = []
    var hasStop = false

    func walk(_ element: AXUIElement, parentKey: String, insideControl: Bool, depth: Int) {
        if visited >= maxNodes || depth > 300 { return }
        visited += 1
        let role = stringAttribute(element, "AXRole") ?? ""
        if role == "AXStaticText" {
            if !insideControl, let value = stringAttribute(element, "AXValue"), !value.isEmpty {
                texts.append(["t": value, "p": parentKey])
            }
            return
        }
        if role == "AXButton" {
            let label = ((stringAttribute(element, "AXDescription") ?? "") + " " + (stringAttribute(element, "AXTitle") ?? "")).lowercased()
            if label.contains("stop") || label.contains("停止") { hasStop = true }
        }
        // 輸入框（尚未送出的文字）與按鈕、選單裡的文字不算回覆內容
        if role == "AXTextArea" || role == "AXTextField" || role == "AXComboBox" { return }
        let control = insideControl || role == "AXButton" || role == "AXPopUpButton" || role == "AXMenuButton" || role == "AXMenu" || role == "AXMenuBar"
        let key = String(CFHash(element))
        for child in childElements(element) {
            walk(child, parentKey: key, insideControl: control, depth: depth + 1)
        }
    }

    // 剛打開開關時，網頁內容的結構要一點時間才會建立；節點太少就稍等再讀
    var attempts = 0
    repeat {
        if attempts > 0 { Thread.sleep(forTimeInterval: 0.5) }
        texts = []
        hasStop = false
        visited = 0
        walk(window, parentKey: "root", insideControl: false, depth: 0)
        attempts += 1
    } while visited < 60 && attempts < 6
    emit(["ok": true, "texts": texts, "stop": hasStop, "nodes": visited, "attempts": attempts, "switches": switches])
} else if command == "dump" {
    func shorten(_ text: String?) -> String {
        guard let text = text else { return "" }
        return text.count > 40 ? String(text.prefix(40)) + "…" : text
    }
    func node(_ element: AXUIElement, depth: Int) -> [String: Any] {
        visited += 1
        var result: [String: Any] = ["role": stringAttribute(element, "AXRole") ?? ""]
        let subrole = stringAttribute(element, "AXSubrole") ?? ""
        if !subrole.isEmpty { result["subrole"] = subrole }
        let title = shorten(stringAttribute(element, "AXTitle"))
        if !title.isEmpty { result["title"] = title }
        let description = shorten(stringAttribute(element, "AXDescription"))
        if !description.isEmpty { result["desc"] = description }
        let value = shorten(stringAttribute(element, "AXValue"))
        if !value.isEmpty { result["value"] = value }
        if depth < 80 && visited < 6000 {
            let children = childElements(element).map { node($0, depth: depth + 1) }
            if !children.isEmpty { result["children"] = children }
        }
        return result
    }
    var tree: [String: Any] = [:]
    var attempts = 0
    repeat {
        if attempts > 0 { Thread.sleep(forTimeInterval: 0.5) }
        visited = 0
        tree = node(window, depth: 0)
        attempts += 1
    } while visited < 60 && attempts < 6
    emit(["ok": true, "tree": tree, "nodes": visited, "attempts": attempts, "switches": switches])
} else if command == "send-state" {
    // 送出按鈕現在能不能按：網頁版 ChatGPT 等圖片上傳完成前，送出按鈕是灰的（AXEnabled = false）
    let strongWords = ["send prompt", "send message", "傳送提示", "傳送訊息", "发送提示", "发送消息", "プロンプトを送信"]
    let words = ["send", "傳送", "送出", "发送", "送信", "submit", "提交"]
    var bestScore = 0
    var enabled = false
    var label = ""
    var busy = 0
    func walk(_ element: AXUIElement, depth: Int) {
        if visited >= maxNodes || depth > 300 { return }
        visited += 1
        let role = stringAttribute(element, "AXRole") ?? ""
        if role == "AXProgressIndicator" || role == "AXBusyIndicator" { busy += 1 }
        if role == "AXButton" {
            let raw = [stringAttribute(element, "AXDescription"), stringAttribute(element, "AXTitle"), stringAttribute(element, "AXHelp")]
                .compactMap { $0 }.joined(separator: " ")
            let text = raw.lowercased().trimmingCharacters(in: .whitespaces)
            if !text.isEmpty && !text.contains("stop") && !text.contains("停止") && !text.contains("feedback") && !text.contains("意見") {
                var score = 0
                if strongWords.contains(where: { (word: String) -> Bool in text.contains(word) }) {
                    score = 3
                } else if words.contains(text) {
                    score = 2
                } else if words.contains(where: { (word: String) -> Bool in text.contains(word) }) {
                    score = 1
                }
                // 同分取後面的（輸入框通常在畫面最下面）
                if score > 0 && score >= bestScore {
                    bestScore = score
                    enabled = (copyAttribute(element, "AXEnabled") as? Bool) ?? true
                    label = String(raw.prefix(40))
                }
            }
            return
        }
        for child in childElements(element) { walk(child, depth: depth + 1) }
    }
    var attempts = 0
    repeat {
        if attempts > 0 { Thread.sleep(forTimeInterval: 0.4) }
        visited = 0
        bestScore = 0
        busy = 0
        walk(window, depth: 0)
        attempts += 1
    } while visited < 60 && attempts < 4
    emit(["ok": true, "found": bestScore > 0, "enabled": enabled, "label": label, "busy": busy, "nodes": visited])
} else if command == "selected-text" {
    // Electron 的 App 要打開 AXManualAccessibility；Chrome 系要暫時打開 AXEnhancedUserInterface，讀完放回原狀
    _ = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let enhancedBefore = (copyAttribute(appElement, "AXEnhancedUserInterface") as? Bool) == true
    if !enhancedBefore { _ = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) }
    var selected = ""
    var attempts = 0
    repeat {
        if attempts > 0 { Thread.sleep(forTimeInterval: 0.15) }
        if let focused = asElement(copyAttribute(appElement, "AXFocusedUIElement")) {
            selected = stringAttribute(focused, "AXSelectedText") ?? ""
        }
        attempts += 1
    } while selected.isEmpty && attempts < 3
    if !enhancedBefore { _ = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse) }
    emit(["ok": true, "text": selected, "attempts": attempts])
} else if command == "slide" {
    guard arguments.count >= 7, let fromX = Double(arguments[3]), let toX = Double(arguments[4]),
          let y = Double(arguments[5]), let duration = Double(arguments[6]), duration >= 0, duration <= 2000 else {
        emit(["ok": false, "error": "usage: ax-helper slide <id> fromX toX y milliseconds"])
        exit(2)
    }
    let enhancedValue = copyAttribute(appElement, "AXEnhancedUserInterface")
    let wasEnhanced = (enhancedValue as? Bool) == true
    if wasEnhanced { _ = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse) }
    let curve = arguments.count >= 8 ? arguments[7] : "expo-out"
    // 指數曲線：expo-out 一開始很快、接近終點時柔和停下；expo-in-out 起步柔和、中段加速、最後收住
    func ease(_ t: Double) -> Double {
        if t <= 0 { return 0 }
        if t >= 1 { return 1 }
        switch curve {
        case "expo-in": return pow(2, 10 * t - 10)
        case "expo-in-out": return t < 0.5 ? pow(2, 20 * t - 10) / 2 : (2 - pow(2, -20 * t + 10)) / 2
        default: return 1 - pow(2, -10 * t)
        }
    }
    // 依「實際經過的時間」算每一格的位置：就算某一格移動得比較慢，整段動畫的節奏也不會亂
    let start = Date()
    var progress = 0.0
    repeat {
        progress = duration <= 0 ? 1 : min(1, Date().timeIntervalSince(start) * 1000 / duration)
        var point = CGPoint(x: (fromX + (toX - fromX) * ease(progress)).rounded(), y: y)
        if let value = AXValueCreate(.cgPoint, &point) {
            _ = AXUIElementSetAttributeValue(window, "AXPosition" as CFString, value)
        }
        if progress < 1 { Thread.sleep(forTimeInterval: 1.0 / 120.0) }
    } while progress < 1
    if wasEnhanced { _ = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) }
    emit(["ok": true, "frame": readFrame(window) ?? [:], "ms": Int(Date().timeIntervalSince(start) * 1000)])
} else if command == "frame" {
    guard let frame = readFrame(window) else {
        emit(["ok": false, "error": "no-frame"])
        exit(6)
    }
    emit(["ok": true, "frame": frame])
} else if command == "move" {
    guard arguments.count >= 7, let x = Double(arguments[3]), let y = Double(arguments[4]),
          let width = Double(arguments[5]), let height = Double(arguments[6]), width > 50, height > 50 else {
        emit(["ok": false, "error": "usage: ax-helper move <bundle-id> x y width height"])
        exit(2)
    }
    // Chromium 開著 AXEnhancedUserInterface 時，移動視窗會有動畫或位置錯亂；移動時暫時關掉，之後還原
    let enhancedValue = copyAttribute(appElement, "AXEnhancedUserInterface")
    let wasEnhanced = (enhancedValue as? Bool) == true
    if wasEnhanced { _ = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse) }
    let result = writeFrame(window, CGRect(x: x, y: y, width: width, height: height))
    if wasEnhanced { _ = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) }
    emit(["ok": result == 0, "result": result, "frame": readFrame(window) ?? [:]])
} else {
    emit(["ok": false, "error": "unknown command"])
    exit(2)
}

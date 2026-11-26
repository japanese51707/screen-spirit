import AppKit
import CoreGraphics
import Foundation

struct Rect: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var area: Double { max(0, width) * max(0, height) }

    func intersection(_ other: Rect) -> Rect? {
        let left = max(x, other.x)
        let top = max(y, other.y)
        let right = min(x + width, other.x + other.width)
        let bottom = min(y + height, other.y + other.height)
        guard right > left, bottom > top else { return nil }
        return Rect(x: left, y: top, width: right - left, height: bottom - top)
    }

    func subtracting(_ cover: Rect) -> [Rect] {
        guard let overlap = intersection(cover) else { return [self] }
        var pieces: [Rect] = []
        if overlap.y > y {
            pieces.append(Rect(x: x, y: y, width: width, height: overlap.y - y))
        }
        if overlap.y + overlap.height < y + height {
            pieces.append(Rect(x: x, y: overlap.y + overlap.height, width: width,
                               height: y + height - overlap.y - overlap.height))
        }
        if overlap.x > x {
            pieces.append(Rect(x: x, y: overlap.y, width: overlap.x - x, height: overlap.height))
        }
        if overlap.x + overlap.width < x + width {
            pieces.append(Rect(x: overlap.x + overlap.width, y: overlap.y,
                               width: x + width - overlap.x - overlap.width, height: overlap.height))
        }
        return pieces
    }
}

struct WindowRecord {
    let owner: String
    let pid: Int
    let bounds: Rect
    let alpha: Double
}

// Input order is front-to-back. Fully opaque windows cover the visible area
// of windows behind them; translucent-window compositing is left for later.
func visibleAreas(in selection: Rect, windowsFrontToBack: [WindowRecord]) -> [String: Double] {
    var opaqueCovers: [Rect] = []
    var totals: [String: Double] = [:]

    for window in windowsFrontToBack {
        guard window.alpha > 0, let clipped = window.bounds.intersection(selection) else { continue }
        var visiblePieces = [clipped]
        for cover in opaqueCovers {
            visiblePieces = visiblePieces.flatMap { $0.subtracting(cover) }
        }
        totals[window.owner, default: 0] += visiblePieces.reduce(0) { $0 + $1.area }
        if window.alpha >= 0.99 {
            opaqueCovers.append(clipped)
        }
    }
    return totals
}

func runGeometryChecks() {
    let selection = Rect(x: 0, y: 0, width: 100, height: 100)
    let windows = [
        WindowRecord(owner: "FrontApp", pid: 1, bounds: Rect(x: 0, y: 0, width: 60, height: 100), alpha: 1),
        WindowRecord(owner: "BackApp", pid: 2, bounds: Rect(x: 40, y: 0, width: 60, height: 100), alpha: 1),
    ]
    let areas = visibleAreas(in: selection, windowsFrontToBack: windows)
    precondition(areas["FrontApp"] == 6000)
    precondition(areas["BackApp"] == 4000)
    precondition(areas.values.reduce(0, +) == selection.area)

    let tied = [
        WindowRecord(owner: "LeftApp", pid: 3, bounds: Rect(x: 0, y: 0, width: 50, height: 100), alpha: 1),
        WindowRecord(owner: "RightApp", pid: 4, bounds: Rect(x: 50, y: 0, width: 50, height: 100), alpha: 1),
    ]
    let tiedAreas = visibleAreas(in: selection, windowsFrontToBack: tied)
    precondition(tiedAreas["LeftApp"] == 5000 && tiedAreas["RightApp"] == 5000)
    print("overlap_geometry_checks=passed; dominant=60/40; tie=50/50")
}

func queryWindowMetadata() {
    guard let raw = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
        print("onscreen_window_query=unavailable")
        return
    }

    var ownerCount = 0
    var pidCount = 0
    var boundsCount = 0
    var completeCount = 0
    var windows: [WindowRecord] = []
    for info in raw {
        let owner = info[kCGWindowOwnerName as String] as? String
        let pid = info[kCGWindowOwnerPID as String] as? Int
        let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary
        let bounds = boundsDictionary.flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
        let alpha = info[kCGWindowAlpha as String] as? Double ?? 1
        if owner != nil { ownerCount += 1 }
        if pid != nil { pidCount += 1 }
        if bounds != nil { boundsCount += 1 }
        if owner != nil && pid != nil && bounds != nil { completeCount += 1 }
        if let owner, let pid, let bounds {
            windows.append(WindowRecord(
                owner: owner,
                pid: pid,
                bounds: Rect(x: bounds.minX, y: bounds.minY,
                             width: bounds.width, height: bounds.height),
                alpha: alpha
            ))
        }
    }

    // Deliberately avoid logging app names, titles, or screen contents.
    print("onscreen_windows=\(raw.count)")
    print("windows_with_owner_name=\(ownerCount)")
    print("windows_with_owner_pid=\(pidCount)")
    print("windows_with_bounds=\(boundsCount)")
    print("windows_with_complete_context=\(completeCount)")

    let display = CGDisplayBounds(CGMainDisplayID())
    let selection = Rect(x: display.minX + display.width * 0.15,
                         y: display.minY + display.height * 0.15,
                         width: display.width * 0.7,
                         height: display.height * 0.7)
    let areas = visibleAreas(in: selection, windowsFrontToBack: windows)
    let positiveAreas = areas.values.filter { $0 > 0 }
    let accountedArea = positiveAreas.reduce(0, +)
    let largestArea = positiveAreas.max() ?? 0
    print("sample_region_area_accounted_percent=\(Int((accountedArea / selection.area * 100).rounded()))")
    print("sample_region_visible_owners=\(positiveAreas.count)")
    print("sample_region_largest_owner_percent=\(accountedArea > 0 ? Int((largestArea / accountedArea * 100).rounded()) : 0)")
}

runGeometryChecks()
if CommandLine.arguments.contains("--query") {
    queryWindowMetadata()
}

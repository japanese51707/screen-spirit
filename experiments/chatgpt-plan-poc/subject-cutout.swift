// 本機去背：用 macOS 內建的「主體擷取」（Vision，macOS 14 以上；和照片 App 長按拉出主體是同一個功能）。
// 用法：subject-cutout <輸入圖片> <輸出 PNG>
// 輸出一行 JSON：{"ok":true,"instances":1} 或 {"ok":false,"error":"..."}
import CoreImage
import Foundation
import Vision

func emit(_ value: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: value)
  print(String(data: data, encoding: .utf8)!)
}

@available(macOS 14.0, *)
func cutout(input: URL, output: URL) {
  guard let image = CIImage(contentsOf: input) else {
    emit(["ok": false, "error": "read-failed"])
    return
  }
  let handler = VNImageRequestHandler(ciImage: image)
  let request = VNGenerateForegroundInstanceMaskRequest()
  do {
    try handler.perform([request])
    guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
      emit(["ok": false, "error": "no-subject"])
      return
    }
    let buffer = try observation.generateMaskedImage(ofInstances: observation.allInstances, from: handler, croppedToInstancesExtent: false)
    let masked = CIImage(cvPixelBuffer: buffer)
    try CIContext().writePNGRepresentation(of: masked, to: output, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    emit(["ok": true, "instances": observation.allInstances.count])
  } catch {
    emit(["ok": false, "error": "\(error)"])
  }
}

let arguments = CommandLine.arguments
if arguments.count < 3 {
  emit(["ok": false, "error": "usage: subject-cutout <input> <output.png>"])
} else if #available(macOS 14.0, *) {
  cutout(input: URL(fileURLWithPath: arguments[1]), output: URL(fileURLWithPath: arguments[2]))
} else {
  emit(["ok": false, "error": "needs-macos-14"])
}

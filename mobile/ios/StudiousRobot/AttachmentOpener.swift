import React
import UIKit

@objc(AttachmentOpener)
class AttachmentOpener: NSObject {
  @objc(open:mimeType:name:resolver:rejecter:)
  func open(
    _ path: String?,
    mimeType: String?,
    name: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let path, !path.isEmpty else {
      reject("MISSING_PATH", "Attachment path is missing", nil)
      return
    }

    DispatchQueue.main.async {
      guard let presenter = RCTPresentedViewController() else {
        reject("OPEN_FAILED", "No active view controller can present the attachment", nil)
        return
      }

      let url = URL(fileURLWithPath: path)
      let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      if let popover = sheet.popoverPresentationController {
        popover.sourceView = presenter.view
        popover.sourceRect = CGRect(
          x: presenter.view.bounds.midX,
          y: presenter.view.bounds.midY,
          width: 0,
          height: 0
        )
        popover.permittedArrowDirections = []
      }

      presenter.present(sheet, animated: true) {
        resolve(nil)
      }
    }
  }
}

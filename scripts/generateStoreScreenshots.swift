#!/usr/bin/env swift

import AppKit
import Foundation

struct StoreShot {
    let name: String
    let headline: String
}

let iphoneShots = [
    StoreShot(name: "01-new-agent", headline: "One agent.\nOr a whole squad."),
    StoreShot(name: "02-files", headline: "Browse every file.\nFrom anywhere."),
    StoreShot(name: "03-terminal", headline: "Approve the work.\nNot the laptop."),
    StoreShot(name: "04-runbook", headline: "Your commands.\nOne tap away."),
    StoreShot(name: "05-settings", headline: "Everything connected.\nEverything under control."),
    StoreShot(name: "06-appearance", headline: "Make it yours.\nEverywhere."),
]

let ipadShots = [
    StoreShot(name: "01-new-agent", headline: "One agent.\nOr a whole squad."),
    StoreShot(name: "02-files", headline: "Browse every file.\nFrom anywhere."),
    StoreShot(name: "03-terminal", headline: "Live terminals.\nRoom to work."),
    StoreShot(name: "04-runbook", headline: "Your agents.\nAll in one place."),
    StoreShot(name: "05-settings", headline: "Everything connected.\nEverything under control."),
    StoreShot(name: "06-appearance", headline: "Speak naturally.\nStay in the flow."),
]

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let base = root.appendingPathComponent("screenshots/app-store")

func font(_ size: CGFloat, weight: NSFont.Weight, monospaced: Bool = false) -> NSFont {
    if monospaced {
        return NSFont.monospacedSystemFont(ofSize: size, weight: weight)
    }
    return NSFont.systemFont(ofSize: size, weight: weight)
}

func render(
    shot: StoreShot,
    rawDirectory: URL,
    outputDirectory: URL,
    width: Int,
    height: Int,
    screenshotWidth: CGFloat,
    screenshotBottom: CGFloat
) throws {
    let input = rawDirectory.appendingPathComponent("\(shot.name).png")
    guard let image = NSImage(contentsOf: input) else {
        throw NSError(domain: "StoreScreenshots", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing input \(input.path)"])
    }

    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 32
    ) else {
        throw NSError(domain: "StoreScreenshots", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not allocate output bitmap"])
    }

    guard let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "StoreScreenshots", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not create graphics context"])
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    let canvas = NSRect(x: 0, y: 0, width: width, height: height)
    NSColor(calibratedWhite: 0.025, alpha: 1).setFill()
    canvas.fill()

    NSGradient(colors: [
        NSColor(calibratedRed: 0.03, green: 0.17, blue: 0.15, alpha: 1),
        NSColor(calibratedWhite: 0.025, alpha: 1),
        NSColor(calibratedWhite: 0.01, alpha: 1),
    ])?.draw(in: canvas, angle: 90)

    let horizontalMargin = CGFloat(width) * 0.065
    let logoAttributes: [NSAttributedString.Key: Any] = [
        .font: font(CGFloat(width) * 0.045, weight: .medium, monospaced: true),
        .foregroundColor: NSColor(calibratedWhite: 0.82, alpha: 1),
        .kern: CGFloat(width) * 0.008,
    ]
    NSString(string: "muxr").draw(
        in: NSRect(x: horizontalMargin, y: CGFloat(height) - CGFloat(width) * 0.14, width: CGFloat(width) * 0.5, height: CGFloat(width) * 0.08),
        withAttributes: logoAttributes
    )

    let headlineSize = CGFloat(width) * (width > 1600 ? 0.061 : 0.073)
    let headlineAttributes: [NSAttributedString.Key: Any] = [
        .font: font(headlineSize, weight: .bold),
        .foregroundColor: NSColor.white,
    ]
    NSString(string: shot.headline).draw(
        with: NSRect(
            x: horizontalMargin,
            y: CGFloat(height) - CGFloat(width) * (width > 1600 ? 0.405 : 0.48),
            width: CGFloat(width) - horizontalMargin * 2,
            height: CGFloat(width) * 0.28
        ),
        options: [.usesLineFragmentOrigin, .usesFontLeading],
        attributes: headlineAttributes
    )

    let imageAspect = image.size.width / image.size.height
    let screenshotHeight = screenshotWidth / imageAspect
    let screenshotRect = NSRect(
        x: (CGFloat(width) - screenshotWidth) / 2,
        y: screenshotBottom,
        width: screenshotWidth,
        height: screenshotHeight
    )
    let cornerRadius = CGFloat(width) * (width > 1600 ? 0.025 : 0.055)
    let rounded = NSBezierPath(roundedRect: screenshotRect, xRadius: cornerRadius, yRadius: cornerRadius)

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.8)
    shadow.shadowBlurRadius = CGFloat(width) * 0.035
    shadow.shadowOffset = NSSize(width: 0, height: CGFloat(width) * 0.012)
    shadow.set()
    NSColor.black.setFill()
    rounded.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSGraphicsContext.saveGraphicsState()
    rounded.addClip()
    image.draw(in: screenshotRect, from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()

    NSColor(calibratedWhite: 0.32, alpha: 1).setStroke()
    rounded.lineWidth = max(2, CGFloat(width) * 0.002)
    rounded.stroke()

    graphics.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
    guard let data = bitmap.representation(
        using: NSBitmapImageRep.FileType.jpeg,
        properties: [.compressionFactor: 0.98]
    ) else {
        throw NSError(domain: "StoreScreenshots", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not encode output JPEG"])
    }
    try data.write(to: outputDirectory.appendingPathComponent("\(shot.name).jpg"))
}

for shot in iphoneShots {
    try render(
        shot: shot,
        rawDirectory: base.appendingPathComponent("raw/iphone-6.9"),
        outputDirectory: base.appendingPathComponent("en-US/iphone-6.9"),
        width: 1320,
        height: 2868,
        screenshotWidth: 1010,
        screenshotBottom: -30
    )
}

for shot in ipadShots {
    try render(
        shot: shot,
        rawDirectory: base.appendingPathComponent("raw/ipad-13"),
        outputDirectory: base.appendingPathComponent("en-US/ipad-13"),
        width: 2064,
        height: 2752,
        screenshotWidth: 1720,
        screenshotBottom: -290
    )
}

print("Generated \(iphoneShots.count + ipadShots.count) App Store screenshots in \(base.appendingPathComponent("en-US").path)")

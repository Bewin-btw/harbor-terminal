import AppKit
let target = CommandLine.arguments[1]
let sizes = [(16,1),(16,2),(32,1),(32,2),(128,1),(128,2),(256,1),(256,2),(512,1),(512,2)]
try FileManager.default.createDirectory(atPath: target, withIntermediateDirectories: true)
for (size, scale) in sizes {
    let px = size * scale
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let f = CGFloat(px) / 1024
    let rect = NSRect(x: 65*f, y: 65*f, width: 894*f, height: 894*f)
    NSColor(calibratedRed: 0.105, green: 0.14, blue: 0.125, alpha: 1).setFill()
    NSBezierPath(roundedRect: rect, xRadius: 198*f, yRadius: 198*f).fill()
    NSColor(calibratedRed: 0.25, green: 0.37, blue: 0.31, alpha: 1).setStroke()
    let border = NSBezierPath(roundedRect: rect.insetBy(dx: 5*f, dy: 5*f), xRadius: 193*f, yRadius: 193*f)
    border.lineWidth = 7*f; border.stroke()
    NSColor(calibratedRed: 0.60, green: 0.85, blue: 0.72, alpha: 1).setStroke()
    let chevron = NSBezierPath()
    chevron.move(to: NSPoint(x: 290*f, y: 640*f)); chevron.line(to: NSPoint(x: 435*f, y: 505*f)); chevron.line(to: NSPoint(x: 290*f, y: 370*f))
    chevron.lineWidth = 60*f; chevron.lineCapStyle = .round; chevron.lineJoinStyle = .round; chevron.stroke()
    let cursor = NSBezierPath(); cursor.move(to: NSPoint(x: 540*f, y: 370*f)); cursor.line(to: NSPoint(x: 750*f, y: 370*f)); cursor.lineWidth = 57*f; cursor.lineCapStyle = .round; cursor.stroke()
    NSColor(calibratedRed: 0.60, green: 0.85, blue: 0.72, alpha: 1).setFill()
    NSBezierPath(ovalIn: NSRect(x: 729*f, y: 716*f, width: 52*f, height: 52*f)).fill()
    NSGraphicsContext.restoreGraphicsState()
    let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: target).appendingPathComponent(name))
}

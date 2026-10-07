/**
 * Overlay Renderer
 *
 * Stateless drawing helpers for visualizing AprilTag detections on a 2D
 * canvas: bounding box, corner markers, center crosshair, and text labels.
 * No pose estimation or 3D projection - a detection's 4 corner points in
 * image space are all that's needed for this.
 *
 * Every detection object passed in is expected to have the shape produced
 * by AprilTagDetector.detect() (js/apriltag-wasm-wrapper.js):
 *   { id, family, familyId, center: {x,y}, corners: [{x,y} x4],
 *     decisionMargin, hamming, rotation }
 *
 * Detections are computed on a (possibly downscaled) processing canvas but
 * drawn on a full-resolution display canvas, so every draw* function takes
 * a scaleX/scaleY pair to map detection space -> display space.
 */

const FAMILY_COLORS = {
    tag36h11:         '#00e676',
    tag25h9:           '#2979ff',
    tag16h5:           '#ff9100',
    tagCircle21h7:     '#e040fb',
    tagCircle49h12:    '#ffea00',
    tagCustom48h12:    '#ff1744',
    tagStandard41h12:  '#00e5ff',
    tagStandard52h13:  '#76ff03',
};

function colorForFamily(family) {
    return FAMILY_COLORS[family] || '#ffffff';
}

function scaleCorners(corners, scaleX, scaleY) {
    return corners.map(c => ({ x: c.x * scaleX, y: c.y * scaleY }));
}

/**
 * Draw the closed polygon through a tag's 4 corners.
 */
function drawBoundingBox(ctx, detection, scaleX, scaleY, opts = {}) {
    const corners = scaleCorners(detection.corners, scaleX, scaleY);
    const color = opts.color || colorForFamily(detection.family);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = opts.lineWidth || 3;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) {
        ctx.lineTo(corners[i].x, corners[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
}

/**
 * Draw a dot at each corner. Corner 0 is drawn larger/distinct so tag
 * orientation is visible at a glance (corner order comes straight from
 * the detector and is rotation-sensitive).
 */
function drawCornerMarkers(ctx, detection, scaleX, scaleY, opts = {}) {
    const corners = scaleCorners(detection.corners, scaleX, scaleY);
    const color = opts.color || colorForFamily(detection.family);

    ctx.save();
    ctx.fillStyle = color;
    corners.forEach((c, i) => {
        const r = i === 0 ? (opts.firstCornerRadius || 6) : (opts.radius || 3);
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
}

/**
 * Draw a small crosshair at the tag center.
 */
function drawCenterCrosshair(ctx, detection, scaleX, scaleY, opts = {}) {
    const cx = detection.center.x * scaleX;
    const cy = detection.center.y * scaleY;
    const size = opts.size || 8;
    const color = opts.color || colorForFamily(detection.family);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - size, cy);
    ctx.lineTo(cx + size, cy);
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx, cy + size);
    ctx.stroke();
    ctx.restore();
}

/**
 * Draw an ID / family / metrics label near the tag.
 */
function drawLabel(ctx, detection, scaleX, scaleY, opts = {}) {
    const cx = detection.center.x * scaleX;
    const cy = detection.center.y * scaleY;
    const color = opts.color || colorForFamily(detection.family);
    const fontSize = opts.fontSize || 14;

    const lines = [`ID ${detection.id}`, detection.family];
    if (opts.showMetrics) {
        lines.push(`margin ${detection.decisionMargin.toFixed(1)}  hamming ${detection.hamming}`);
    }

    ctx.save();
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lineHeight = fontSize * 1.3;
    const startY = cy - ((lines.length - 1) * lineHeight) / 2;

    lines.forEach((line, i) => {
        const y = startY + i * lineHeight;
        const width = ctx.measureText(line).width;
        // Readable label background regardless of what's behind it.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(cx - width / 2 - 4, y - fontSize / 2 - 2, width + 8, fontSize + 4);
        ctx.fillStyle = color;
        ctx.fillText(line, cx, y);
    });
    ctx.restore();
}

/**
 * Draw the full overlay (box + corners + crosshair + label) for one
 * detection, honoring the toggles in opts.
 */
function drawDetection(ctx, detection, scaleX, scaleY, opts = {}) {
    if (opts.box !== false) drawBoundingBox(ctx, detection, scaleX, scaleY, opts);
    if (opts.corners !== false) drawCornerMarkers(ctx, detection, scaleX, scaleY, opts);
    if (opts.crosshair !== false) drawCenterCrosshair(ctx, detection, scaleX, scaleY, opts);
    if (opts.label !== false) drawLabel(ctx, detection, scaleX, scaleY, opts);
}

/**
 * Draw the overlay for every detection in a frame.
 * @param {CanvasRenderingContext2D} ctx - target context (already sized to the display canvas)
 * @param {Array} detections - detector output
 * @param {number} scaleX - detection-space -> display-space X scale
 * @param {number} scaleY - detection-space -> display-space Y scale
 * @param {Object} opts - toggles: box, corners, crosshair, label, showMetrics
 */
function drawDetections(ctx, detections, scaleX, scaleY, opts = {}) {
    for (const detection of detections) {
        drawDetection(ctx, detection, scaleX, scaleY, opts);
    }
}

/**
 * Coordinate helpers: deskew / rotate bboxes between original and deskewed page spaces.
 */

function rotatePoint(x, y, angleDeg, width, height) {
  const rad = (angleDeg * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;
  const dx = x - cx;
  const dy = y - cy;
  return {
    x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

/**
 * Rotate an axis-aligned bbox by angleDeg around page center.
 * Returns a new AABB covering the rotated corners.
 */
function rotateBBox(bbox, angleDeg, width, height) {
  if (!bbox || !Number.isFinite(angleDeg) || Math.abs(angleDeg) < 0.01) {
    return bbox
      ? {
          x0: Math.round(bbox.x0),
          y0: Math.round(bbox.y0),
          x1: Math.round(bbox.x1),
          y1: Math.round(bbox.y1),
        }
      : bbox;
  }
  const corners = [
    [bbox.x0, bbox.y0],
    [bbox.x1, bbox.y0],
    [bbox.x0, bbox.y1],
    [bbox.x1, bbox.y1],
  ].map(([x, y]) => rotatePoint(x, y, angleDeg, width, height));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return {
    x0: Math.round(Math.min(...xs)),
    y0: Math.round(Math.min(...ys)),
    x1: Math.round(Math.max(...xs)),
    y1: Math.round(Math.max(...ys)),
  };
}

/** Map original-page bbox → deskewed-page bbox (deskew rotates image by -angle). */
function originalToDeskew(bbox, deskewAngle, origW, origH) {
  return rotateBBox(bbox, -deskewAngle, origW, origH);
}

module.exports = {
  rotatePoint,
  rotateBBox,
  originalToDeskew,
};

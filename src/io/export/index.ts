/** Non-SVG vector exporters (DXF/EPS/PDF) over structured trace geometry. */

export { traceGeometry, type TraceGeometry, type GeometryPath } from './geometry.js';
export { DXF_UNITS, type DxfUnit, toDxf, type DxfOptions } from './dxf.js';
export { toEps, type EpsOptions } from './eps.js';
export { toPdf, type PdfOptions } from './pdf.js';
export { toGcode, type GcodeOptions } from './gcode.js';

import React, { createContext, useContext, useLayoutEffect, useRef } from 'react';

export const GuidedGeometry = createContext(false);
// Layout boxes touch. The same 26 x 6 shoulder cuts the receiving socket and
// extends the preceding tab outside its layout box (including C/E inner joins).
export const guidedJoint = (x, reverse = false) => reverse
  ? `H${x + 48} l-5 6 h-16 l-5 -6`
  : `H${x + 22} l5 6 h16 l5 -6`;

export function guidedBlockPath(shape, width, height, headWidth = width, mouths = []) {
  if (shape === 'predicate') return `M12 0 H${width - 12} L${width} ${height / 2} L${width - 12} ${height} H12 L0 ${height / 2} Z`;
  if (shape === 'reporter') {
    const r = Math.min(height / 2, width / 2);
    return `M${r} 0 H${width-r} Q${width} 0 ${width} ${r} V${height-r} Q${width} ${height} ${width-r} ${height} H${r} Q0 ${height} 0 ${height-r} V${r} Q0 0 ${r} 0 Z`;
  }
  const w = headWidth;
  let d = shape === 'hat' ? `M0 12 Q38 -12 76 12 H${w} ` : `M0 0 ${guidedJoint(0)} H${w} `;
  for (const mouth of mouths) {
    d += `V${mouth.top} ${guidedJoint(12, true)} H12 V${mouth.bottom} ${guidedJoint(12)} H${w} `;
  }
  d += `V${height} ${shape === 'cap' ? '' : guidedJoint(0, true)} H0 Z`;
  return d;
}

export function GuidedShape({ shape }) {
  return useContext(GuidedGeometry) ? <MeasuredShape shape={shape} /> : null;
}
function MeasuredShape({ shape }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const svg = ref.current, block = svg.parentElement;
    const paint = () => {
      const rect = block.getBoundingClientRect();
      if (!rect.width || !block.offsetWidth) return;
      // Use one scale for all rects; CSS zoom/board transforms must not distort
      // paths. Fractional wrapped row sizes remain precise (offsetHeight rounds).
      const scale = rect.width / block.offsetWidth;
      const h = rect.height / scale, w = rect.width / scale;
      const header = block.querySelector(':scope > .se-block-row');
      const mouths = [...block.querySelectorAll(':scope > .se-mouth')].map(el => {
        const r = el.getBoundingClientRect();
        return { top: (r.top - rect.top) / scale, bottom: (r.bottom - rect.top) / scale };
      });
      svg.setAttribute('viewBox', `0 0 ${w} ${h + 6}`);
      svg.firstElementChild.setAttribute('d', guidedBlockPath(shape, w, h,
        mouths.length && header ? header.getBoundingClientRect().width / scale : w, mouths));
    };
    const observer = new ResizeObserver(paint);
    observer.observe(block);
    for (const child of block.children) if (child !== svg) observer.observe(child);
    paint();
    return () => observer.disconnect();
  });
  return <svg ref={ref} className="se-guided-shape" aria-hidden="true" focusable="false"><path /></svg>;
}

export function GuidedFoot() {
  return useContext(GuidedGeometry) ? <div className="se-guided-foot" aria-hidden="true">↶</div> : null;
}

// スキャン推移グラフのSVGパス計算（DOMに依存しない）

const INSET = 4;

/**
 * @param {number[]} values
 * @param {{ maxValue: number, width: number, height: number }} options
 * @returns {string} SVG path の d 属性
 */
export function buildSeriesPath(values, { maxValue, width, height }) {
  // 点が1つでは線にならないため、0から始まる2点にする
  const safeValues = values.length > 1 ? values : [0, values[0] || 0];
  const scale = Math.max(1, maxValue);
  const step = (width - INSET * 2) / (safeValues.length - 1);
  const points = safeValues.map((value, index) => {
    const x = INSET + index * step;
    const y = height - (value / scale) * (height - INSET * 2) - INSET;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return `M ${points.join(' L ')}`;
}

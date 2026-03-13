const FONT_STACK = `-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`;

/**
 * Estimate rendered text width in pixels using character-width heuristics.
 * This approximation is sufficient for dynamic badge sizing.
 */
function estimateTextWidth(text: string, fontSize: number, fontWeight: number): number {
  // Average character width ratio varies by weight and size
  const ratio = fontWeight >= 700 ? 0.62 : 0.56;
  return Math.ceil(text.length * fontSize * ratio);
}

/**
 * Renders an SVG badge showing a user's GitHub commits leaderboard rank.
 *
 * @param rank  - The user's rank (1-based)
 * @param theme - "light" (default) or "dark"
 * @returns SVG string
 */
export function renderRankedBadge(rank: number, theme: "light" | "dark" = "light"): string {
  const rankText = `#${rank}`;
  const labelText = `by GitHub commits · ghcommits.com`;

  const height = 28;
  const radius = 6;
  const rankFontSize = 13;
  const rankFontWeight = 700;
  const labelFontSize = 11;
  const labelFontWeight = 500;

  const chipPaddingH = 10;
  const labelPaddingH = 10;

  const rankTextWidth = estimateTextWidth(rankText, rankFontSize, rankFontWeight);
  const labelTextWidth = estimateTextWidth(labelText, labelFontSize, labelFontWeight);

  const chipWidth = rankTextWidth + chipPaddingH * 2;
  const labelWidth = labelTextWidth + labelPaddingH * 2;
  const totalWidth = chipWidth + labelWidth;

  // Theme colors
  const chipBg = theme === "dark" ? "#e6edf3" : "#1f6feb";
  const chipTextColor = theme === "dark" ? "#0d1117" : "#ffffff";
  const bodyBg = theme === "dark" ? "#161b22" : "#24292f";
  const bodyTextColor = "#e6edf3";
  const borderColor = theme === "dark" ? "#30363d" : "none";
  const hasBorder = theme === "dark";

  const ariaLabel = `Ranked ${rankText} by GitHub commits on ghcommits.com`;

  // Vertical center for text baseline
  const textY = Math.round(height / 2) + 1;

  // Border offset for stroke (stroke is centered on the path, so inset by 0.5)
  const borderInset = hasBorder ? 0.5 : 0;

  const svgParts: string[] = [];

  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `  width="${totalWidth}" height="${height}"`,
    `  viewBox="0 0 ${totalWidth} ${height}"`,
    `  role="img" aria-label="${ariaLabel}">`,
    `  <title>${ariaLabel}</title>`,
  );

  svgParts.push(`  <defs>`);
  svgParts.push(
    `    <clipPath id="badge-clip">`,
    `      <rect width="${totalWidth}" height="${height}" rx="${radius}" ry="${radius}"/>`,
    `    </clipPath>`,
  );
  svgParts.push(`  </defs>`);

  // Body background (full badge, rounded)
  svgParts.push(
    `  <rect width="${totalWidth}" height="${height}" rx="${radius}" ry="${radius}" fill="${bodyBg}"/>`,
  );

  // Chip background — full height rectangle clipped to badge shape.
  // Drawn as a rect from x=0 spanning chipWidth, clipped by the badge clip path.
  // An extra rect covers the right-side rounded corner of the chip rect so it
  // seamlessly joins the body rect.
  svgParts.push(`  <g clip-path="url(#badge-clip)">`);
  svgParts.push(
    `    <rect x="0" y="0" width="${chipWidth}" height="${height}" fill="${chipBg}"/>`,
  );
  // Cover-rect: fills the gap between chip's right edge and body (eliminates
  // any anti-aliasing gap at the join seam).
  svgParts.push(
    `    <rect x="${chipWidth - radius}" y="0" width="${radius}" height="${height}" fill="${chipBg}"/>`,
  );
  svgParts.push(`  </g>`);

  // Dark-theme border
  if (hasBorder) {
    svgParts.push(
      `  <rect x="${borderInset}" y="${borderInset}"`,
      `    width="${totalWidth - borderInset * 2}" height="${height - borderInset * 2}"`,
      `    rx="${radius - borderInset}" ry="${radius - borderInset}"`,
      `    fill="none" stroke="${borderColor}" stroke-width="1"/>`,
    );
  }

  // Rank text (chip)
  const rankTextX = Math.round(chipWidth / 2);
  svgParts.push(
    `  <text`,
    `    x="${rankTextX}" y="${textY}"`,
    `    font-family="${FONT_STACK}"`,
    `    font-size="${rankFontSize}"`,
    `    font-weight="${rankFontWeight}"`,
    `    fill="${chipTextColor}"`,
    `    text-anchor="middle"`,
    `    dominant-baseline="central"`,
    `    aria-hidden="true">`,
    `    ${rankText}`,
    `  </text>`,
  );

  // Label text (body)
  const labelTextX = chipWidth + Math.round(labelWidth / 2);
  svgParts.push(
    `  <text`,
    `    x="${labelTextX}" y="${textY}"`,
    `    font-family="${FONT_STACK}"`,
    `    font-size="${labelFontSize}"`,
    `    font-weight="${labelFontWeight}"`,
    `    fill="${bodyTextColor}"`,
    `    text-anchor="middle"`,
    `    dominant-baseline="central"`,
    `    aria-hidden="true">`,
    `    ${labelText}`,
    `  </text>`,
  );

  svgParts.push(`</svg>`);

  return svgParts.join("\n");
}

/**
 * Renders a CTA SVG badge for unregistered users.
 *
 * @param theme - "light" (default) or "dark"
 * @returns SVG string
 */
export function renderUnrankedBadge(theme: "light" | "dark" = "light"): string {
  const labelText = `Join the leaderboard · ghcommits.com`;

  const width = 304;
  const height = 28;
  const radius = 6;
  const fontSize = 11;
  const fontWeight = 500;

  // Theme colors
  const bg = theme === "dark" ? "#161b22" : "#656d76";
  const textColor = theme === "dark" ? "#848d97" : "#ffffff";
  const borderColor = theme === "dark" ? "#30363d" : "none";
  const hasBorder = theme === "dark";

  const ariaLabel = `Join the GitHub commits leaderboard at ghcommits.com`;

  const textX = Math.round(width / 2);
  const textY = Math.round(height / 2) + 1;

  const borderInset = hasBorder ? 0.5 : 0;

  const svgParts: string[] = [];

  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `  width="${width}" height="${height}"`,
    `  viewBox="0 0 ${width} ${height}"`,
    `  role="img" aria-label="${ariaLabel}">`,
    `  <title>${ariaLabel}</title>`,
  );

  // Background
  svgParts.push(
    `  <rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${bg}"/>`,
  );

  // Dark-theme border
  if (hasBorder) {
    svgParts.push(
      `  <rect x="${borderInset}" y="${borderInset}"`,
      `    width="${width - borderInset * 2}" height="${height - borderInset * 2}"`,
      `    rx="${radius - borderInset}" ry="${radius - borderInset}"`,
      `    fill="none" stroke="${borderColor}" stroke-width="1"/>`,
    );
  }

  // Centered label text
  svgParts.push(
    `  <text`,
    `    x="${textX}" y="${textY}"`,
    `    font-family="${FONT_STACK}"`,
    `    font-size="${fontSize}"`,
    `    font-weight="${fontWeight}"`,
    `    fill="${textColor}"`,
    `    text-anchor="middle"`,
    `    dominant-baseline="central"`,
    `    aria-hidden="true">`,
    `    ${labelText}`,
    `  </text>`,
  );

  svgParts.push(`</svg>`);

  return svgParts.join("\n");
}

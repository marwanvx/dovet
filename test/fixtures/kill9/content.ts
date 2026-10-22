export const fileContent = (index: number, round: number): string => `file ${index} round ${round}\n${"x".repeat(200_000)}\n`;

export const settingsText = (variant: number): string =>
  `${JSON.stringify({ variant, filler: `${variant}`.repeat(6_000_000) })}\n`;

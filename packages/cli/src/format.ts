import { styleText } from "node:util";
import type { Diagnostic } from "@ludra/core";

type Style = Parameters<typeof styleText>[0];

/** Colors only when writing to a terminal; agents reading piped output get plain text. */
export function paint(style: Style, text: string): string {
  return styleText(style, text, { stream: process.stdout });
}

export function formatDiagnostic(d: Diagnostic, file: string): string {
  const icon = d.severity === "error" ? paint("red", "✗ error") : paint("yellow", "! warning");
  const lines = [`${icon} ${d.code} ${paint("dim", `${file} → ${d.path}`)}`, `  ${d.message}`];
  if (d.fix) lines.push(`  ${paint("cyan", "fix:")} ${d.fix}`);
  return lines.join("\n");
}

export function formatDiagnostics(diagnostics: readonly Diagnostic[], file: string): string {
  return diagnostics.map((d) => formatDiagnostic(d, file)).join("\n\n");
}

export function fixed(n: number, digits = 1): string {
  return n.toFixed(digits);
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

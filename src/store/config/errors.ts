export type Problem = { file: string; line?: number | undefined; key: string; message: string };

export class SettingsError extends Error {
  readonly problems: Problem[];

  constructor(problems: Problem[]) {
    super(problems.map(describeProblem).join("\n"));
    this.name = "SettingsError";
    this.problems = problems;
  }
}

export function describeProblem(p: Problem): string {
  const where = p.line === undefined ? p.file : `${p.file}:${p.line}`;
  return p.key === "" ? `${where}: ${p.message}` : `${where}: ${p.key}: ${p.message}`;
}

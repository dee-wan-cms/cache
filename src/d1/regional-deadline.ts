let reportDeadline: ((deadline: number) => void) | undefined;

export function registerRegionalDeadlineReporter(report: (deadline: number) => void): void {
  reportDeadline = report;
}

export function limitRegionalDataUntil(deadline: number): void {
  reportDeadline?.(deadline);
}

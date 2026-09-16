export function reportError(...values: unknown[]): void {
  try {
    console.error(...values);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EPIPE') throw error;
  }
}

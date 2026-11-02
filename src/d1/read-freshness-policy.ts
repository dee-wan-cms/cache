export const isMutation = (method: string): boolean => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

export function matchesPath(pathname: string, patterns: readonly string[]): boolean {
  const actual = pathname.split('/');
  return patterns.some((pattern) => {
    const parts = pattern.split('/');
    const recursive = parts.at(-1) === '**';
    if (recursive) parts.pop();
    return (recursive ? actual.length > parts.length : parts.length === actual.length) && parts.every((part, index) => part === '*' ? !!actual[index] : !part.includes('*') && part === actual[index]);
  });
}

export function needsFreshness(method: string, pathname: string, excludedPaths: readonly string[] = []): boolean {
  return isMutation(method) && !matchesPath(pathname, excludedPaths);
}

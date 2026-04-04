export function fallbackDocFromDiff(input: {
  filePath: string;
  diff: string;
  changedLines: number;
}) {
  const adds = (input.diff.match(/^\+[^+]/gm) ?? []).length;
  const dels = (input.diff.match(/^-[-]/gm) ?? []).length;
  const summary = `Updated ${input.filePath} (${input.changedLines} lines changed).`;
  return {
    summary,
    whatChanged: [`Added ~${adds} lines`, `Removed ~${dels} lines`],
    whyItMatters: [
      'Captures intent at the moment of change (fallback mode).',
      'Configure Gemini for richer, structured explanations.'
    ],
    tags: ['fallback', 'diff', 'wip']
  };
}


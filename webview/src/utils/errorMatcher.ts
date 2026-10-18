import patternsData from '../data/errorPatterns.json';

interface DiagnosticCommandStep {
  kind: 'command';
  command: string;
}

export type DiagnosticStep = DiagnosticCommandStep;

export interface DiagnosticSolution {
  key: string;
  recommended: boolean;
  steps: DiagnosticStep[];
}

/**
 * How a matched diagnostic should be presented in the UI.
 *
 * - `card`: inline diagnostic card rendered under the offending message
 *   (can carry copyable commands / solution steps). This is the default.
 * - `bar`: no inline card; the notice is instead surfaced by the status bar
 *   above the composer (`StatusNoticeBar`), which can be dismissed.
 */
export type DiagnosticPresentation = 'card' | 'bar';

export interface DiagnosticPattern {
  code: string;
  /** Normalised at compile time: raw patterns without the field become `card`. */
  presentation: DiagnosticPresentation;
  /** Optional fallback URL for the pattern's call-to-action, used when the
   *  server did not push one at runtime. */
  actionLink?: string;
  solutions: DiagnosticSolution[];
}

interface RawPattern {
  code: string;
  presentation?: DiagnosticPresentation;
  actionLink?: string;
  match: {
    regex: string;
    keywordsAll?: string[];
  };
  solutions: DiagnosticSolution[];
}

interface RawPatternsFile {
  patterns: RawPattern[];
}

interface CompiledPattern {
  pattern: DiagnosticPattern;
  regex: RegExp;
  keywords: string[];
}

const compiledPatterns: CompiledPattern[] = (patternsData as RawPatternsFile).patterns
  .map((raw): CompiledPattern | null => {
    try {
      return {
        pattern: {
          code: raw.code,
          presentation: raw.presentation === 'bar' ? 'bar' : 'card',
          actionLink: raw.actionLink,
          solutions: raw.solutions,
        },
        regex: new RegExp(raw.match.regex, 'i'),
        keywords: raw.match.keywordsAll ?? [],
      };
    } catch (err) {
      console.error(`Invalid error pattern "${raw.code}":`, err);
      return null;
    }
  })
  .filter((entry): entry is CompiledPattern => entry !== null);

/**
 * Match an error message against known diagnostic patterns.
 *
 * A pattern matches when both conditions are satisfied:
 * 1. The compiled regex (case-insensitive) tests true against `errorText`.
 * 2. Every keyword in `keywordsAll` appears in `errorText` (case-sensitive
 *    substring check). Patterns without keywords only require the regex match.
 *
 * Patterns are scanned in declaration order and the first match wins.
 *
 * @param errorText Raw error message text to inspect.
 * @returns The matching {@link DiagnosticPattern}, or `null` when no pattern fits.
 */
export function matchErrorPattern(errorText: string): DiagnosticPattern | null {
  if (!errorText) return null;

  for (const { pattern, regex, keywords } of compiledPatterns) {
    if (!regex.test(errorText)) continue;
    const allKeywordsMatched = keywords.every((kw) => errorText.includes(kw));
    if (!allKeywordsMatched) continue;
    return pattern;
  }

  return null;
}

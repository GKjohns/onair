export interface CaptionWord { text: string; startMs: number; endMs: number }
export interface CaptionPhrase { words: CaptionWord[]; startMs: number; untilMs: number; baseline?: number; text?: string }
export interface CaptionState { phrase: number; active: number; startMs: number; endMs: number }
export type StyleId = 'pop' | 'plate' | 'clean'
export const BALL: string
export const CADENCE: { maxWords: number; maxSpanMs: number; gapBreakMs: number; holdMs: number }
export const STYLES: Record<StyleId, { label: string; karaoke: boolean; maxWords: number }>
export const DEFAULT_BASELINE: number
export function baselineOf(p: CaptionPhrase): number
export function retext(p: CaptionPhrase, text: string): CaptionPhrase
export function captionStates(phrases: CaptionPhrase[], karaoke?: boolean): CaptionState[]
export function drawCard(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  phrase: CaptionPhrase, active: number, style: string,
  viewport: { width: number; height: number }, baselineFrac: number,
): void

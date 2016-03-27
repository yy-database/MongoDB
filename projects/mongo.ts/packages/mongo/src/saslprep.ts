// RFC 4013 SASLprep, applied to passwords when `createUser` stores credentials.
//
// Node ships no stringprep implementation, so the mapping and prohibition tables
// from RFC 3454 are encoded here. NFKC comes from ICU through
// `String.prototype.normalize`, which is the same normalization `mongod`'s
// saslprep applies.
//
// Order follows RFC 4013: map (B.1 to nothing, C.1.2 to space), normalize NFKC,
// prohibit, then the bidirectional check from RFC 3454 section 6.

export class SaslprepError extends Error {
    /** Which RFC 3454 check failed, so the caller can name the ICU error. */
    readonly kind: 'prohibited' | 'bidi'

    constructor(kind: 'prohibited' | 'bidi') {
        super(kind === 'bidi' ? 'bidirectional check failed' : 'prohibited code point')
        this.name = 'SaslprepError'
        this.kind = kind
    }
}

type Range = readonly [number, number]

/** RFC 3454 table B.1: commonly mapped to nothing. */
const MAPPED_TO_NOTHING: Range[] = [
    [0x00ad, 0x00ad],
    [0x034f, 0x034f],
    [0x1806, 0x1806],
    [0x180b, 0x180d],
    [0x200b, 0x200d],
    [0x2060, 0x2060],
    [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff]
]

/** RFC 3454 table C.1.2: non-ASCII spaces, mapped to U+0020. */
const MAPPED_TO_SPACE: Range[] = [
    [0x00a0, 0x00a0],
    [0x1680, 0x1680],
    [0x2000, 0x200a],
    [0x202f, 0x202f],
    [0x205f, 0x205f],
    [0x3000, 0x3000]
]

/** RFC 3454 tables C.2.1 through C.9: prohibited output. */
const PROHIBITED: Range[] = [
    [0x0000, 0x001f],
    [0x007f, 0x009f],
    [0x06dd, 0x06dd],
    [0x070f, 0x070f],
    [0x180e, 0x180e],
    [0x200c, 0x200d],
    [0x2028, 0x2029],
    [0x2060, 0x2063],
    [0x206a, 0x206f],
    [0xfeff, 0xfeff],
    [0xfff9, 0xfffd],
    [0x1d173, 0x1d17a],
    // Private use areas.
    [0xe000, 0xf8ff],
    [0xf0000, 0xffffd],
    [0x100000, 0x10fffd],
    // Non-character code points.
    [0xfdd0, 0xfdef],
    [0xfffe, 0xffff],
    [0x1fffe, 0x1ffff],
    [0x2fffe, 0x2ffff],
    [0x3fffe, 0x3ffff],
    [0x4fffe, 0x4ffff],
    [0x5fffe, 0x5ffff],
    [0x6fffe, 0x6ffff],
    [0x7fffe, 0x7ffff],
    [0x8fffe, 0x8ffff],
    [0x9fffe, 0x9ffff],
    [0xafffe, 0xaffff],
    [0xbfffe, 0xbffff],
    [0xcfffe, 0xcffff],
    [0xdfffe, 0xdffff],
    [0xefffe, 0xeffff],
    [0xffffe, 0xfffff],
    [0x10fffe, 0x10ffff],
    // Surrogates, inappropriate for canonical representation, display-deprecated.
    [0xd800, 0xdfff],
    [0x2ff0, 0x2ffb],
    [0x0340, 0x0341],
    [0x200e, 0x200f],
    [0x202a, 0x202e],
    // Tagging characters.
    [0xe0001, 0xe0001],
    [0xe0020, 0xe007f]
]

function inRanges(code: number, ranges: Range[]): boolean {
    for (const [low, high] of ranges) {
        if (code >= low && code <= high) return true
    }
    return false
}

const RANDAL = /[\p{Script=Hebrew}\p{Script=Arabic}]/u
const STRONG_L = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u

/** RFC 4013 preparation; throws `SaslprepError` for a prohibited code point. */
export function saslprep(input: string): string {
    let mapped = ''
    for (const character of input) {
        // `for...of` iterates code points, so surrogate pairs stay whole.
        const code = character.codePointAt(0) ?? 0
        if (inRanges(code, MAPPED_TO_NOTHING)) continue
        if (inRanges(code, MAPPED_TO_SPACE)) {
            mapped += ' '
            continue
        }
        mapped += character
    }
    const normalized = mapped.normalize('NFKC')
    for (const character of normalized) {
        const code = character.codePointAt(0) ?? 0
        if (inRanges(code, PROHIBITED)) throw new SaslprepError('prohibited')
    }
    // RFC 3454 section 6: with a RandALCat character the string may hold no
    // LCat character, and its first and last characters must be RandALCat.
    if (RANDAL.test(normalized)) {
        const characters = Array.from(normalized)
        if (STRONG_L.test(normalized) || !RANDAL.test(characters[0]) || !RANDAL.test(characters[characters.length - 1])) {
            throw new SaslprepError('bidi')
        }
    }
    return normalized
}

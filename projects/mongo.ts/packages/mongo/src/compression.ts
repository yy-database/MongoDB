// Wire compression codecs for `OP_COMPRESSED` (opcode 2012).
//
// Compressor ids follow the MongoDB wire specification: 1 = snappy,
// 2 = zlib, 3 = zstd. zlib and zstd come from `node:zlib`; snappy has no
// built-in, so this module carries its own encoder and decoder. The encoder
// emits literals only, which is a valid snappy stream (ratio 1.0); the decoder
// understands every tag the real drivers emit, including copies.
import zlib from 'node:zlib'

export const COMPRESSOR_SNAPPY = 1
export const COMPRESSOR_ZLIB = 2
export const COMPRESSOR_ZSTD = 3

export const COMPRESSOR_IDS: Record<string, number> = {
    snappy: COMPRESSOR_SNAPPY,
    zlib: COMPRESSOR_ZLIB,
    zstd: COMPRESSOR_ZSTD
}

export const COMPRESSOR_NAMES: Record<number, string> = {
    [COMPRESSOR_SNAPPY]: 'snappy',
    [COMPRESSOR_ZLIB]: 'zlib',
    [COMPRESSOR_ZSTD]: 'zstd'
}

export class CompressionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CompressionError'
    }
}

/** Length of the uncompressed stream, used for the frame's `uncompressedSize` field. */
export function compress(id: number, input: Buffer): Buffer {
    switch (id) {
        case COMPRESSOR_SNAPPY:
            return snappyCompress(input)
        case COMPRESSOR_ZLIB:
            return zlib.deflateSync(input)
        case COMPRESSOR_ZSTD:
            return zlib.zstdCompressSync(input)
        default:
            throw new CompressionError(`unsupported compressor id ${id}`)
    }
}

/** Decompresses a frame body and rejects any result that misses the announced size. */
export function decompress(id: number, input: Buffer, expectedSize: number): Buffer {
    let output: Buffer
    switch (id) {
        case COMPRESSOR_SNAPPY:
            output = snappyDecompress(input, expectedSize)
            break
        case COMPRESSOR_ZLIB:
            try {
                // Cap the output at the announced size so a forged frame cannot
                // materialise a stream far larger than the bytes it declared.
                output = zlib.inflateSync(input, { maxOutputLength: Math.max(expectedSize, 1) })
            } catch (error) {
                throw decompressionError('zlib', error, expectedSize)
            }
            break
        case COMPRESSOR_ZSTD:
            try {
                output = zlib.zstdDecompressSync(input, { maxOutputLength: Math.max(expectedSize, 1) })
            } catch (error) {
                throw decompressionError('zstd', error, expectedSize)
            }
            break
        default:
            throw new CompressionError(`unsupported compressor id ${id}`)
    }
    if (output.length !== expectedSize) {
        throw new CompressionError(`decompressed ${output.length} bytes, frame announced ${expectedSize}`)
    }
    return output
}

function decompressionError(codec: string, error: unknown, expectedSize: number): CompressionError {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        return new CompressionError(`${codec} stream decompresses past the announced ${expectedSize} bytes`)
    }
    return new CompressionError(`${codec} decompression failed: ${(error as Error).message}`)
}

// ---------------------------------------------------------------------------
// snappy
// ---------------------------------------------------------------------------

class Varint {
    private offset = 0
    private readonly bytes: Buffer

    constructor(bytes: Buffer) {
        this.bytes = bytes
    }

    read(): number {
        let result = 0
        let shift = 0
        while (true) {
            if (this.offset >= this.bytes.length) throw new CompressionError('snappy stream ended inside the length varint')
            const byte = this.bytes[this.offset]
            this.offset += 1
            if (shift >= 32) throw new CompressionError('snappy length varint is out of range')
            result += (byte & 0x7f) * 2 ** shift
            if ((byte & 0x80) === 0) return result
            shift += 7
        }
    }

    position(): number {
        return this.offset
    }

    rest(): Buffer {
        return this.bytes.subarray(this.offset)
    }

    atEnd(): boolean {
        return this.offset >= this.bytes.length
    }

    advance(count: number): void {
        if (this.offset + count > this.bytes.length) throw new CompressionError('snappy stream ended inside an instruction')
        this.offset += count
    }

    byte(): number {
        if (this.offset >= this.bytes.length) throw new CompressionError('snappy stream ended inside an instruction')
        return this.bytes[this.offset++]
    }
}

function writeVarint(value: number): Buffer {
    const bytes: number[] = []
    let remaining = value
    while (remaining >= 0x80) {
        bytes.push((remaining & 0x7f) | 0x80)
        remaining >>>= 7
    }
    bytes.push(remaining)
    return Buffer.from(bytes)
}

/**
 * Encodes a literal-only snappy stream. Literal-only encoding is legal snappy
 * and is what the wire specification accepts, so the server never has to
 * reproduce libsnappy's matching heuristics.
 */
export function snappyCompress(input: Buffer): Buffer {
    const parts: Buffer[] = [writeVarint(input.length)]
    let index = 0
    while (index < input.length) {
        const length = Math.min(input.length - index, 0x1000000)
        const chunk = input.subarray(index, index + length)
        parts.push(literalTag(length), chunk)
        index += length
    }
    return Buffer.concat(parts)
}

function literalTag(length: number): Buffer {
    if (length <= 60) return Buffer.from([(length - 1) << 2])
    if (length <= 0xff) {
        const tag = Buffer.from([60 << 2, 0])
        tag[1] = length
        return tag
    }
    if (length <= 0xffff) {
        const tag = Buffer.alloc(3)
        tag[0] = 61 << 2
        tag.writeUInt16LE(length, 1)
        return tag
    }
    if (length <= 0xffffff) {
        const tag = Buffer.alloc(4)
        tag[0] = 62 << 2
        tag.writeUIntLE(length, 1, 3)
        return tag
    }
    const tag = Buffer.alloc(5)
    tag[0] = 63 << 2
    tag.writeUInt32LE(length, 1)
    return tag
}

/** Decodes a snappy stream; `expectedSize` comes from the frame header. */
export function snappyDecompress(input: Buffer, expectedSize?: number): Buffer {
    const varint = new Varint(input)
    const announced = varint.read()
    if (expectedSize !== undefined && announced !== expectedSize) {
        throw new CompressionError(`snappy stream announces ${announced} bytes, frame announced ${expectedSize}`)
    }
    if (announced > 0x10000000) throw new CompressionError(`snappy stream announces an oversized ${announced} bytes`)

    const output = Buffer.alloc(announced)
    varint.advance(0)
    let written = 0
    const stream = varint.rest()
    let cursor = 0

    while (cursor < stream.length) {
        const tag = stream[cursor]
        cursor += 1
        const kind = tag & 0x03
        if (kind === 0) {
            let length = (tag >> 2) + 1
            if (length > 60) {
                const extra = length - 60
                if (cursor + extra > stream.length) throw new CompressionError('snappy literal length is truncated')
                let value = 0
                for (let index = 0; index < extra; index += 1) value += stream[cursor + index] * 2 ** (8 * index)
                cursor += extra
                length = value
            }
            if (cursor + length > stream.length) throw new CompressionError('snappy literal payload is truncated')
            if (written + length > announced) throw new CompressionError('snappy literal overruns the announced size')
            stream.copy(output, written, cursor, cursor + length)
            cursor += length
            written += length
            continue
        }

        let length: number
        let offset: number
        if (kind === 1) {
            if (cursor >= stream.length) throw new CompressionError('snappy copy offset is truncated')
            length = ((tag >> 2) & 0x07) + 4
            offset = ((tag >> 5) & 0x07) * 256 + stream[cursor]
            cursor += 1
        } else if (kind === 2) {
            if (cursor + 2 > stream.length) throw new CompressionError('snappy copy offset is truncated')
            length = (tag >> 2) + 1
            offset = stream.readUInt16LE(cursor)
            cursor += 2
        } else {
            if (cursor + 4 > stream.length) throw new CompressionError('snappy copy offset is truncated')
            length = (tag >> 2) + 1
            offset = stream.readUInt32LE(cursor)
            cursor += 4
        }
        if (offset === 0 || offset > written) throw new CompressionError('snappy copy points outside the decoded prefix')
        if (written + length > announced) throw new CompressionError('snappy copy overruns the announced size')
        for (let index = 0; index < length; index += 1) {
            output[written] = output[written - offset]
            written += 1
        }
    }

    if (written !== announced) {
        throw new CompressionError(`snappy stream decoded ${written} bytes, announced ${announced}`)
    }
    return output
}

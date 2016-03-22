// Wire framing for the server side of the MongoDB protocol.
//
// The command payloads themselves are decoded by the Rust primitives
// (`decodeOpMsg` / `decodeOpQuery`); this module only owns the 16 byte header,
// the `OP_COMPRESSED` envelope and the legacy `OP_REPLY` reply shape.
import { COMPRESSOR_NAMES, decompress } from './compression.ts'

export const OP_REPLY = 1
export const OP_QUERY = 2004
export const OP_COMPRESSED = 2012
export const OP_MSG = 2013

export const DEFAULT_MAX_FRAME_SIZE = 48_000_000

export class WireError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'WireError'
    }
}

export interface FrameHeader {
    totalLength: number
    requestId: number
    responseTo: number
    opcode: number
}

export interface CompressionEnvelope {
    compressorId: number
    originalOpcode: number
    uncompressedSize: number
}

export interface InboundFrame {
    header: FrameHeader
    /** Opcode the server has to answer, after unwrapping `OP_COMPRESSED`. */
    opcode: number
    /** Uncompressed payload; for `OP_MSG` this is flags plus sections. */
    payload: Buffer
    envelope: CompressionEnvelope | null
    compressorName: string | null
}

export function peekHeader(frame: Buffer): FrameHeader | null {
    if (frame.length < 16) return null
    return {
        totalLength: frame.readInt32LE(0),
        requestId: frame.readInt32LE(4),
        responseTo: frame.readInt32LE(8),
        opcode: frame.readInt32LE(12)
    }
}

/**
 * Unwraps one complete frame. `OP_COMPRESSED` bodies are decompressed here and
 * the announced `uncompressedSize` is enforced before the payload reaches the
 * command decoder, so a lying frame errors instead of continuing.
 */
export function decodeFrame(frame: Buffer, maxFrameSize = DEFAULT_MAX_FRAME_SIZE): InboundFrame {
    const header = peekHeader(frame)
    if (!header) throw new WireError('frame shorter than its header')
    if (header.totalLength !== frame.length) throw new WireError('frame length does not match its header')
    if (header.opcode === OP_MSG || header.opcode === OP_QUERY) {
        return { header, opcode: header.opcode, payload: frame.subarray(16), envelope: null, compressorName: null }
    }
    if (header.opcode !== OP_COMPRESSED) throw new WireError(`unsupported opcode ${header.opcode}`)

    const payload = frame.subarray(16)
    if (payload.length < 9) throw new WireError('OP_COMPRESSED frame is missing its 9 byte envelope')
    const originalOpcode = payload.readInt32LE(0)
    const uncompressedSize = payload.readInt32LE(4)
    const compressorId = payload.readUInt8(8)
    if (originalOpcode !== OP_MSG) {
        throw new WireError(`OP_COMPRESSED must wrap OP_MSG, got ${originalOpcode}`)
    }
    if (uncompressedSize < 0 || uncompressedSize > maxFrameSize) {
        throw new WireError(`OP_COMPRESSED announced an out of range size ${uncompressedSize}`)
    }
    const compressorName = COMPRESSOR_NAMES[compressorId]
    if (compressorName === undefined) throw new WireError(`unknown compressor id ${compressorId}`)
    let body: Buffer
    try {
        body = decompress(compressorId, payload.subarray(9), uncompressedSize)
    } catch (error) {
        throw new WireError((error as Error).message)
    }
    return {
        header,
        opcode: OP_MSG,
        payload: body,
        envelope: { compressorId, originalOpcode, uncompressedSize },
        compressorName
    }
}

export function encodeMsgFrame(requestId: number, responseTo: number, body: Buffer): Buffer {
    return frame(requestId, responseTo, OP_MSG, body)
}

export function encodeCompressedFrame(
    requestId: number,
    responseTo: number,
    compressorId: number,
    uncompressedSize: number,
    compressed: Buffer
): Buffer {
    const meta = Buffer.alloc(9)
    meta.writeInt32LE(OP_MSG, 0)
    meta.writeInt32LE(uncompressedSize, 4)
    meta.writeUInt8(compressorId, 8)
    return frame(requestId, responseTo, OP_COMPRESSED, Buffer.concat([meta, compressed]))
}

/** Legacy reply shape used for `OP_QUERY` handshakes. */
export function encodeReplyFrame(requestId: number, responseTo: number, document: Buffer): Buffer {
    const fields = Buffer.alloc(20)
    fields.writeInt32LE(0, 0)
    fields.writeBigInt64LE(0n, 4)
    fields.writeInt32LE(0, 12)
    fields.writeInt32LE(1, 16)
    return frame(requestId, responseTo, OP_REPLY, Buffer.concat([fields, document]))
}

function frame(requestId: number, responseTo: number, opcode: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(16)
    header.writeInt32LE(16 + payload.length, 0)
    header.writeInt32LE(requestId, 4)
    header.writeInt32LE(responseTo, 8)
    header.writeInt32LE(opcode, 12)
    return Buffer.concat([header, payload])
}

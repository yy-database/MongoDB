// Wire framing for the MongoDB protocol.
//
// The header, the `OP_COMPRESSED` envelope, the codec dispatch and every frame
// layout are owned by the Rust `protocol.mongo` core; this module only maps
// those primitives to the shapes the server and client consume. zlib inflates
// through `node:zlib`, which is the host codec the core deliberately delegates.
import zlib from 'node:zlib'
import { binding } from './binding.ts'

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

const COMPRESSOR_NAMES: Record<number, string> = { 1: 'snappy', 2: 'zlib', 3: 'zstd' }

export function peekHeader(frame: Buffer): FrameHeader | null {
    const header = binding.wirePeekHeader(frame)
    if (!header) return null
    return {
        totalLength: header.totalLength,
        requestId: header.requestId,
        responseTo: header.responseTo,
        opcode: header.opcode
    }
}

/**
 * Unwraps one complete frame. The Rust core enforces the announced length,
 * rejects unknown opcodes and compressors, and decompresses snappy and zstd
 * through `boost.data.compression`; zlib arrives via the host callback below,
 * with the envelope's `uncompressedSize` as the inflate budget.
 */
export function decodeFrame(frame: Buffer, maxFrameSize = DEFAULT_MAX_FRAME_SIZE): InboundFrame {
    let inbound
    try {
        inbound = binding.wireDecodeFrame(frame, maxFrameSize, (data: Buffer, maxOutputLength: number) =>
            zlib.inflateSync(data, { maxOutputLength }))
    } catch (error) {
        throw new WireError((error as Error).message)
    }
    const header: FrameHeader = {
        totalLength: inbound.totalLength,
        requestId: inbound.requestId,
        responseTo: inbound.responseTo,
        opcode: inbound.opcode
    }
    if (inbound.compressorId === null || inbound.compressorId === undefined) {
        return { header, opcode: inbound.opcode, payload: inbound.payload, envelope: null, compressorName: null }
    }
    return {
        header,
        opcode: inbound.opcode,
        payload: inbound.payload,
        envelope: {
            compressorId: inbound.compressorId,
            originalOpcode: inbound.originalOpcode as number,
            uncompressedSize: inbound.uncompressedSize as number
        },
        compressorName: COMPRESSOR_NAMES[inbound.compressorId] ?? null
    }
}

export function encodeMsgFrame(requestId: number, responseTo: number, body: Buffer): Buffer {
    return binding.wireEncodeMsgFrame(requestId, responseTo, body)
}

export function encodeCompressedFrame(
    requestId: number,
    responseTo: number,
    compressorId: number,
    uncompressedSize: number,
    compressed: Buffer
): Buffer {
    return binding.wireEncodeCompressedFrame(requestId, responseTo, compressorId, uncompressedSize, compressed)
}

/** Legacy reply shape used for `OP_QUERY` handshakes. */
export function encodeReplyFrame(requestId: number, responseTo: number, document: Buffer): Buffer {
    return binding.wireEncodeReplyFrame(requestId, responseTo, document)
}

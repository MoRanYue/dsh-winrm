/**
 * Raw WSMan `Send` for the streaming upload path.
 *
 * The bundled `winrm-client` can only put text on the WinRS stdin stream: its
 * `doSendInput` base64-encodes the input *again* on top of whatever the caller
 * already encoded, and it has no way to close the stream. Both are fatal for a
 * bulk transfer — double base64 costs 1.78x the bytes on the wire, and a
 * stdin stream that never ends cannot tell the remote receiver "that is all".
 *
 * This module therefore builds the `Send` envelope itself and posts it through
 * the library's own `sendHttp`, which keeps Basic/NTLM/SPNEGO and the HTTPS
 * options exactly as the rest of the transport uses them. The stream carries
 * raw file bytes, so the wire cost is 1.0x plus the envelope.
 *
 * The library is reached through `createRequire` rather than a static import
 * because `dist/src/utils/http.js` is an internal CommonJS path with no
 * `exports` map behind it. `loadSendHttp` returns null when that path is gone
 * (a future `winrm-client` layout change), which lets the caller fall back to
 * the old chunked path instead of failing the transfer.
 */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

/** Connection parameters for one target (mirrors `WinRMParams` in client.ts). */
export interface WsmanTarget {
  host: string
  port: number
  path: string
  username: string
  password: string
  authMethod: 'basic' | 'ntlm'
  useHttps?: boolean
  rejectUnauthorized?: boolean
}

/** `sendHttp` as the bundled library declares it. */
type SendHttp = (
  data: string,
  host: string,
  port: number,
  path: string,
  username: string,
  password: string,
  authMethod: 'basic' | 'ntlm',
  timeout?: number,
  useHttps?: boolean,
  rejectUnauthorized?: boolean,
) => Promise<unknown>

/**
 * Envelope ceiling declared on every Send, in bytes.
 *
 * This is what the *client* promises the server it will never exceed, and the
 * server enforces its own `MaxEnvelopeSizekb` on top. 512000 is the value the
 * target host reports, and it is far above the library's hardcoded 153600 —
 * raising it is what makes 256 KiB chunks legal.
 */
export const WS_MAX_ENVELOPE_BYTES = 512_000

/**
 * Bytes of XML wrapper around one base64 chunk.
 *
 * Measured against the envelope this module emits: fixed header, selector set,
 * body tags and the message id. Used to size chunks against the ceiling before
 * sending, so a normal transfer never needs a size rejection to converge.
 */
export const SEND_ENVELOPE_OVERHEAD_BYTES = 1_600

/** The largest raw slice whose base64 form still fits `WS_MAX_ENVELOPE_BYTES`. */
export const MAX_SEND_SLICE_BYTES = Math.floor(
  ((WS_MAX_ENVELOPE_BYTES - SEND_ENVELOPE_OVERHEAD_BYTES) / 4) * 3,
)

let sendHttpCache: SendHttp | null | undefined

/**
 * Resolve the library's `sendHttp`, or null when the internal path is absent.
 * @returns the send function, or null when it cannot be loaded.
 */
export function loadSendHttp(): SendHttp | null {
  if (sendHttpCache !== undefined) return sendHttpCache
  try {
    const require = createRequire(import.meta.url)
    const mod = require('winrm-client/dist/src/utils/http.js') as { sendHttp?: unknown }
    sendHttpCache = typeof mod.sendHttp === 'function' ? (mod.sendHttp as SendHttp) : null
  } catch {
    sendHttpCache = null
  }
  return sendHttpCache
}

/**
 * Build one WSMan `Send` envelope carrying `chunk` on the stdin stream.
 *
 * The header mirrors what the library emits, with three deliberate changes:
 * `MaxEnvelopeSize` is raised to `limit`, the `Send` action replaces the
 * command's, and the stream body is the caller's base64 verbatim — no second
 * encode. `Name="stdin"` and `CommandId` are what bind the bytes to the
 * running receiver's standard input.
 * @param shellId - target shell from `Shell.doCreateShell`.
 * @param commandId - target command from `Command.doExecuteCommand`.
 * @param chunk - raw bytes to place on the remote stdin stream.
 * @param limit - envelope ceiling to declare.
 * @returns the SOAP envelope as a UTF-8 string.
 */
export function buildSendEnvelope(shellId: string, commandId: string, chunk: Buffer, limit: number): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
    ' xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"' +
    ' xmlns:p="http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd"' +
    ' xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">' +
    '<s:Header>' +
    '<wsa:To>http://windows-host:5985/wsman</wsa:To>' +
    '<wsman:ResourceURI mustUnderstand="true">http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd</wsman:ResourceURI>' +
    '<wsa:ReplyTo><wsa:Address mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo>' +
    '<wsman:MaxEnvelopeSize mustUnderstand="true">' +
    String(limit) +
    '</wsman:MaxEnvelopeSize>' +
    '<wsa:MessageID>uuid:' +
    randomUUID() +
    '</wsa:MessageID>' +
    '<wsman:Locale mustUnderstand="false" xml:lang="en-US"/>' +
    '<wsman:OperationTimeout>PT60S</wsman:OperationTimeout>' +
    '<wsa:Action mustUnderstand="true">http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Send</wsa:Action>' +
    '<wsman:SelectorSet><wsman:Selector Name="ShellId">' +
    shellId +
    '</wsman:Selector></wsman:SelectorSet>' +
    '</s:Header>' +
    '<s:Body><rsp:Send><rsp:Stream CommandId="' +
    commandId +
    '" Name="stdin">' +
    chunk.toString('base64') +
    '</rsp:Stream></rsp:Send></s:Body>' +
    '</s:Envelope>'
  )
}

/**
 * Push one raw slice onto the remote stdin stream.
 *
 * A rejection here is safe to retry with a smaller slice: the server validates
 * the envelope size before dispatching it to the shell, so nothing reached the
 * receiver's stdin when the call fails on size.
 * @param target - connection parameters (auth already selected).
 * @param shellId - target shell.
 * @param commandId - target command.
 * @param chunk - raw bytes to send.
 * @param sendHttp - the resolved library function.
 * @param timeoutMs - per-request HTTP timeout.
 */
export async function sendStdinChunk(
  target: WsmanTarget,
  shellId: string,
  commandId: string,
  chunk: Buffer,
  sendHttp: SendHttp,
  timeoutMs: number,
): Promise<void> {
  const envelope = buildSendEnvelope(shellId, commandId, chunk, WS_MAX_ENVELOPE_BYTES)
  await sendHttp(
    envelope,
    target.host,
    target.port,
    target.path,
    target.username,
    target.password,
    target.authMethod,
    timeoutMs,
    target.useHttps,
    target.rejectUnauthorized,
  )
}

/**
 * Whether a failed Send was refused for exceeding the envelope ceiling.
 *
 * WSMan reports this as a SOAP fault rather than a status code, and the exact
 * wording differs between the HTTP and HTTPS stacks, so the test looks for any
 * of the size-related phrasings plus the plain 413 status. It deliberately
 * does not match a bare "size" in unrelated text.
 * @param error - the rejection to classify.
 * @returns true when retrying with a smaller slice is the right response.
 */
export function isEnvelopeTooLarge(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /\b413\b/.test(message) ||
    /envelope/i.test(message) ||
    /MaxEnvelopeSize/i.test(message) ||
    /maximum.*(size|length)/i.test(message)
  )
}

/**
 * Build one WSMan `Receive` envelope asking for stdout and stderr.
 *
 * The library's own `buildReceiveOutputRequest` cannot be reused here because
 * it hardcodes `MaxEnvelopeSize` at 153600 in its shared header. Measured
 * against this target, that ceiling is what caps each response at 128 KiB —
 * raising it to 512000 lets one `Receive` return 128 KiB per stream, which is
 * the most the server will put in a single response regardless.
 * @param shellId - target shell.
 * @param commandId - target command whose streams are wanted.
 * @param limit - envelope ceiling to declare.
 * @returns the SOAP envelope as a UTF-8 string.
 */
export function buildReceiveEnvelope(shellId: string, commandId: string, limit: number): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
    ' xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"' +
    ' xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">' +
    '<s:Header>' +
    '<wsa:To>http://windows-host:5985/wsman</wsa:To>' +
    '<wsman:ResourceURI mustUnderstand="true">http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd</wsman:ResourceURI>' +
    '<wsa:ReplyTo><wsa:Address mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo>' +
    '<wsman:MaxEnvelopeSize mustUnderstand="true">' +
    String(limit) +
    '</wsman:MaxEnvelopeSize>' +
    '<wsa:MessageID>uuid:' +
    randomUUID() +
    '</wsa:MessageID>' +
    '<wsman:Locale mustUnderstand="false" xml:lang="en-US"/>' +
    '<wsman:OperationTimeout>PT60S</wsman:OperationTimeout>' +
    '<wsa:Action mustUnderstand="true">http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive</wsa:Action>' +
    '<wsman:SelectorSet><wsman:Selector Name="ShellId">' +
    shellId +
    '</wsman:Selector></wsman:SelectorSet>' +
    '</s:Header>' +
    '<s:Body><rsp:Receive><rsp:DesiredStream CommandId="' +
    commandId +
    '">stdout stderr</rsp:DesiredStream></rsp:Receive></s:Body>' +
    '</s:Envelope>'
  )
}

/** One decoded `rsp:Stream` element from a Receive response. */
export interface ReceivedStream {
  /** `Name` attribute: `stdout` or `stderr`. */
  name: string
  /** Decoded payload bytes; empty for a stream element that carried no text. */
  data: Buffer
  /** True when the `End` attribute marks this stream closed. */
  end: boolean
}

/** A decoded Receive response: its streams plus the command's exit code once known. */
export interface ReceiveResult {
  streams: ReceivedStream[]
  /** `rsp:CommandState.rsp:ExitCode`, or undefined while the command still runs. */
  exitCode?: number
}

/**
 * Decode a base64 text node that the XML parser may have coerced to a number.
 *
 * fast-xml-parser runs with `parseTagValue` enabled, so an all-digit text node
 * comes back as a JS number: `"0123"` parses to `123`, `"0000"` to `0`, and
 * `"1e55"` to a float. A base64 payload is usually long enough to contain a
 * non-digit and stay a string, but the final short chunk of a stream is exactly
 * where a leading zero can appear, and silently reinterpreting it would corrupt
 * the file. Converting through `String()` recovers the digits for every value
 * that lost only leading zeros; a value that came back in exponent form cannot
 * be recovered and is rejected rather than guessed at.
 * @param text - the raw text node as the parser produced it.
 * @returns the base64 text, or null when it cannot be reconstructed.
 */
function coerceBase64(text: unknown): string | null {
  if (typeof text === 'string') return text.replace(/\s+/g, '')
  if (typeof text === 'number' && Number.isFinite(text) && Number.isInteger(text) && text >= 0) {
    return String(text)
  }
  return null
}

/**
 * Read the streams and exit code out of a Receive response.
 *
 * The library's `extractStreams` cannot be used for binary payloads: it decodes
 * every stream through `extractText`, which falls back to `String(obj)` for an
 * element that has attributes but no text node — turning the terminal
 * `End="true"` marker into the literal string `'[object Object]'` — and the
 * library's `doReceiveOutputNonBlocking` then `.trim()`s the decoded text,
 * which would eat whitespace bytes at either end of a real payload. This
 * reader keeps the distinction between "no text" (zero bytes) and "text" and
 * never trims.
 * @param response - the parsed XML object returned by `sendHttp`.
 * @returns the decoded streams and exit code.
 * @throws when a stream's text node cannot be decoded as base64.
 */
export function readReceiveResult(response: unknown): ReceiveResult {
  const envelope = response as Record<string, unknown> | null
  const body = (envelope?.['s:Envelope'] as Record<string, unknown> | undefined)?.['s:Body'] as
    | Record<string, unknown>
    | undefined
  const receive = body?.['rsp:ReceiveResponse'] as Record<string, unknown> | undefined
  const streams: ReceivedStream[] = []
  if (receive !== undefined) {
    const raw = receive['rsp:Stream']
    const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw]
    for (const element of list) {
      const node = element as Record<string, unknown>
      const text = node !== null && typeof node === 'object' && '_' in node ? node['_'] : ''
      const attributes = (node?.['$'] ?? {}) as Record<string, unknown>
      const name = String(attributes['@_Name'] ?? '')
      const end = String(attributes['@_End'] ?? '') === 'true'
      if (text === '' || text === null || text === undefined) {
        streams.push({ name, data: Buffer.alloc(0), end })
        continue
      }
      const base64 = coerceBase64(text)
      if (base64 === null) {
        throw new Error('receive stream returned an undecodable text node: ' + String(text))
      }
      streams.push({ name, data: base64 === '' ? Buffer.alloc(0) : Buffer.from(base64, 'base64'), end })
    }
  }
  const state = receive?.['rsp:CommandState'] as Record<string, unknown> | undefined
  const rawExit = state?.['rsp:ExitCode']
  const exitCode = rawExit === undefined || rawExit === null ? undefined : Number(rawExit)
  return { streams, exitCode: exitCode !== undefined && Number.isFinite(exitCode) ? exitCode : undefined }
}

/**
 * Fetch one Receive response for a running command.
 * @param target - connection parameters (auth already selected).
 * @param shellId - target shell.
 * @param commandId - target command.
 * @param sendHttp - the resolved library function.
 * @param timeoutMs - per-request HTTP timeout.
 * @returns the decoded streams and exit code.
 */
export async function receiveOutput(
  target: WsmanTarget,
  shellId: string,
  commandId: string,
  sendHttp: SendHttp,
  timeoutMs: number,
): Promise<ReceiveResult> {
  const response = await sendHttp(
    buildReceiveEnvelope(shellId, commandId, WS_MAX_ENVELOPE_BYTES),
    target.host,
    target.port,
    target.path,
    target.username,
    target.password,
    target.authMethod,
    timeoutMs,
    target.useHttps,
    target.rejectUnauthorized,
  )
  return readReceiveResult(response)
}

import { Transform, type Writable } from 'node:stream';

const PARSE_ERROR = `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`;
const MAX_PENDING_BYTES = 10 * 1024 * 1024;

/**
 * Answer an unparsable stdin line with a JSON-RPC parse error.
 *
 * The SDK's stdio transport skips such a line silently, so a client whose
 * request was malformed waits forever. Valid lines pass through unchanged. A
 * line longer than the SDK's buffer is passed on uninspected for the SDK to
 * refuse.
 */
export function parseErrorFilter(stdout: Writable): Transform {
  let pending = Buffer.alloc(0);
  const inspect = (line: Buffer, push: (chunk: Buffer) => void): void => {
    const text = line.toString('utf8').replace(/\r$/, '');
    if (text.trim() === '') return;
    try { JSON.parse(text); }
    catch { stdout.write(PARSE_ERROR); return; }
    push(Buffer.concat([line, Buffer.from('\n')]));
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending = Buffer.concat([pending, chunk]);
      let index: number;
      while ((index = pending.indexOf(0x0a)) >= 0) {
        inspect(pending.subarray(0, index), (line) => this.push(line));
        pending = pending.subarray(index + 1);
      }
      if (pending.length > MAX_PENDING_BYTES) { this.push(pending); pending = Buffer.alloc(0); }
      done();
    },
    flush(done) {
      if (pending.length > 0) this.push(pending);
      done();
    },
  });
}

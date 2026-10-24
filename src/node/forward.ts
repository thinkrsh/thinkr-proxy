// The Forward of the Node entry, on node:https, which keeps the trailers that fetch drops.
import { request } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';

import type { Forward } from '../lib/forward.js';

export const nodeForward: Forward = (url, init) =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = Object.fromEntries(init.headers);
    headers['content-length'] = String(init.body.byteLength);
    // HTTP/1.1 sends trailers only to a client that says it reads them.
    headers.te = 'trailers';
    const outgoing = request(
      url,
      { method: init.method, headers, signal: init.signal },
      (incoming) => {
        const trailers = new Promise<Headers>((settle) => {
          const done = (): void => {
            settle(toHeaders(incoming.trailers));
          };
          incoming.once('end', done);
          incoming.once('close', done);
        });
        resolve({
          status: incoming.statusCode ?? 0,
          headers: toHeaders(incoming.headers),
          body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          trailers,
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(Buffer.from(init.body));
  });

function toHeaders(source: IncomingHttpHeaders | NodeJS.Dict<string>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

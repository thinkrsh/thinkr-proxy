// One HTTP request whose answer streams back with its trailers. The fetch of Node drops trailers,
// and the enclave reports the usage of an answer in one, so the private lane forwards through this.
export interface ForwardInit {
  readonly method: 'POST';
  readonly headers: Headers;
  readonly body: ArrayBuffer;
  readonly signal: AbortSignal;
}

export interface ForwardResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array>;
  /** The trailers, once the body has been read to its end; empty when the answer had none. */
  readonly trailers: Promise<Headers>;
}

export type Forward = (url: URL, init: ForwardInit) => Promise<ForwardResponse>;

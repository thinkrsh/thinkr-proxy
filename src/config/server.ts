// Where the Node proxy listens, and how large a request body may be.
export const SERVER = {
  host: '127.0.0.1',
  port: 8787,
  /** Larger bodies get 413 before the proxy reads them. */
  maxBodyBytes: 1_048_576,
  /**
   * The largest sealed chat of the private lane, which carries the photos and the documents of the
   * chat (decision 142). Must stay above the limits of apps/app/src/config/attachments.ts.
   */
  maxSealedChatBytes: 16_777_216,
  /**
   * The largest chat of the open lane, which carries the photos of the chat (23 Oct 2026), as the
   * sealed chat does.
   */
  maxOpenChatBytes: 16_777_216,
  /** The largest request of an image or a video: its prompt and one photo. */
  maxMediaBodyBytes: 4_194_304,
  /** The largest sealed document sent to the document enclave, as multipart. */
  maxSealedFileBytes: 26_214_400,
  /**
   * The largest sealed recording, as multipart. Must stay above the longest recording of
   * apps/app/src/config/voice.ts.
   */
  maxSealedAudioBytes: 16_777_216,
  /**
   * The largest sealed message for the privacy filter: its limit of 4 MiB of JSON
   * (docs.tinfoil.sh/guides/privacy-filter.md, read 23 Oct 2026).
   */
  maxSealedFilterBytes: 4_194_304,
  /** Every route lives under this prefix. Production routes chat.thinkr.sh/api/* to the proxy (decision 47). */
  basePath: '/api',
  /** The routes of the private lane, under the base path. The app builds its sealed requests on it. */
  privateLanePath: '/private',
  /** The routes of the privacy filter, under the private lane; the app points its SDK here. */
  privacyFilterPath: '/filter',
  /** Bytes of the random secret that hashes the address of each visitor, new at each start. */
  visitorKeySecretBytes: 32,
} as const;

// How the proxy forwards the private lane to Tinfoil (decision 36). Read on 20 Oct 2026:
// docs.tinfoil.sh/guides/proxy-server.md and the code of the npm package tinfoil 1.2.2.
// The browser checks the attestation and seals each body (EHBP), so the proxy sees only ciphertext.
export const TINFOIL = {
  /** The attestation service that the SDK asks for the bundle of the router. */
  attestationUrl: 'https://atc.tinfoil.sh/attestation',
  /** The proxy forwards only to HTTPS enclaves on this host or a subdomain of it. */
  enclaveHost: 'tinfoil.sh',
  /** The path of a chat on the router. */
  chatCompletionsPath: '/v1/chat/completions',
  /**
   * The path of the document enclave on the router: one file in, its Markdown out (decision 142;
   * docs.tinfoil.sh/guides/document-processing.md, read 22 Oct 2026).
   */
  convertFilePath: '/v1/convert/file',
  /**
   * The paths of the audio models on the router, Premium in the app (the owner, 23 Oct 2026): a
   * recording in, its text out, and a text in, its speech out as WAV
   * (docs.tinfoil.sh/guides/processing-audio.md, read 23 Oct 2026).
   */
  transcriptionPath: '/v1/audio/transcriptions',
  speechPath: '/v1/audio/speech',
  /**
   * The privacy filter, Premium in the app: OpenAI Privacy Filter in an enclave of its own, not
   * behind the router, so the browser verifies it apart (docs.tinfoil.sh/guides/privacy-filter.md,
   * read 23 Oct 2026; the router answered 404 for its path that day).
   */
  privacyFilter: {
    enclaveUrl: 'https://pii-filter.tinfoil.sh',
    configRepo: 'tinfoilsh/confidential-pii-cpu',
    redactPath: '/redact',
  },
  headers: {
    /** The verified enclave that the SDK names on each request. */
    enclaveUrl: 'X-Tinfoil-Enclave-Url',
    /** The model; the enclave refuses a body that names another one. */
    model: 'X-Tinfoil-Model',
    /** The HPKE key of a sealed body. A request without it would carry plain text. */
    encapsulatedKey: 'Ehbp-Encapsulated-Key',
    /** The nonce that lets the browser open the sealed answer. */
    responseNonce: 'Ehbp-Response-Nonce',
    /** Asks the enclave to report the usage of the answer. */
    requestUsage: 'X-Tinfoil-Request-Usage-Metrics',
    /** The trailer of a streamed answer that carries its tokens and its cost. */
    usage: 'X-Tinfoil-Usage-Metrics',
    /**
     * Asks the router to put the progress of web search inline in the answer
     * (docs.tinfoil.sh/guides/web-search.md, read 22 Oct 2026). The app sends it with web search.
     */
    events: 'X-Tinfoil-Events',
  },
  /** The one value of the events header that the proxy passes on. */
  webSearchEvents: 'web_search',
  /**
   * What Tinfoil charges beyond tokens (`requestPrice` in api.tinfoil.sh/api/config/models, read
   * 22 Oct 2026): web search, once for each answer that searched, and one document converted. Read
   * on 23 Oct 2026: one recording at $0.01, the fee of the model of voice input before Voxtral Small
   * 24B, which costs tokens and was reported at $0 that day; one text to Voxtral TTS; and one text to
   * the privacy filter.
   */
  fees: {
    webSearchUsd: 0.05,
    documentUsd: 0.05,
    transcriptionUsd: 0.01,
    speechUsd: 0.002,
    privacyFilterUsd: 0.005,
  },
  /** Headers of the SDK that the proxy passes on to the attestation service. */
  sdkHeaders: ['Tinfoil-SDK', 'Tinfoil-SDK-Version'],
  /** The media type of an EHBP error, such as a rotated key, which the SDK reads in plain text. */
  problemMediaType: 'application/problem+json',
  /** Time allowed for the attestation bundle. */
  attestationTimeoutMs: 15_000,
  /** The largest bundle the proxy passes on. The bundle of the router was 26 KB on 20 Oct 2026. */
  maxAttestationBytes: 1_048_576,
  /** Time allowed until the enclave answers with response headers. */
  firstByteTimeoutMs: 30_000,
  /** Time allowed for one whole answer, from the request to the last byte. */
  streamTimeoutMs: 300_000,
  /**
   * Time allowed for converting one document, which answers only once the whole file is read. The
   * webapp of Tinfoil allows ten minutes (tinfoilsh/tinfoil-webapp at a0ee538, 22 Oct 2026).
   */
  convertTimeoutMs: 600_000,
  /**
   * Time allowed for one recording or one part of an answer to speak, which answer at once. On 23
   * Oct 2026 a recording of 13 s took 2 s, and 699 characters became speech in 9 s.
   */
  audioTimeoutMs: 120_000,
  /** Time allowed for the privacy filter, which reads one message. */
  privacyFilterTimeoutMs: 30_000,
} as const;

# Thinkr proxy

This server sits between the chat app of Thinkr and the providers of its models.
It runs at `chat.thinkr.sh/api`. It forwards the private lane to the enclaves of
Tinfoil and the open lane to OpenRouter. It also keeps the credit of the app and
the encrypted backups of the app.

The readers are developers and auditors who want to know what the proxy can see
and what it cannot see. The proxy holds no key that opens a chat of the private
lane, and no key that signs a voucher.

## What the proxy sees

This section states what the proxy learns in each part of the app.

- **The private lane.** The browser verifies the remote attestation of the
  enclave first. Then it encrypts each chat with HPKE (RFC 9180), in the
  Encrypted HTTP Body Protocol (EHBP) of Tinfoil. The proxy adds the API key of
  Thinkr and forwards the ciphertext. It forwards only sealed requests, and only
  to HTTPS enclaves on `tinfoil.sh`. It learns the model, the size and the time
  of each request, and the token counts that the enclave reports.
- **The open lane.** The proxy reads each chat in plaintext and sends it to
  OpenRouter. At the level ZDR, each request asks for endpoints with zero data
  retention (`zdr: true`) and refuses providers that collect data
  (`data_collection: deny`). At the level Open, each request refuses providers
  that collect data only. Images use both levels. Video uses the level Open
  only, since OpenRouter has no video endpoint with zero data retention.
- **The credit.** The proxy verifies the signature of each voucher with the
  public key of the issuer
  ([thinkr-issuer](https://github.com/thinkrsh/thinkr-issuer)). A valid voucher
  fills a balance. The app names the balance with a random secret. The proxy
  keeps the SHA-256 of each spent voucher and of each balance. It never sees a
  payment or a wallet.
- **The backups.** The proxy stores ciphertext only, under a store ID. It checks
  the shape, the write token, and the tag of each backup
  ([thinkr-sync](https://github.com/thinkrsh/thinkr-sync)).
- **The free trial.** The proxy counts the chats of each visitor by a keyed
  hash of the IP address. The hash key is new at each start, and the counts
  live in memory only.
- **The log.** The proxy writes one line for each request: the time, the
  method, the path, the status, and the duration. It also writes one line for
  each failed call to a provider, with the error message of the proxy. No line
  holds the content of a chat, an IP address, or a store ID.

## Routes

This section lists the routes of the proxy. Every route lives under `/api`.

| Route                                       | Purpose                                                    |
| ------------------------------------------- | ---------------------------------------------------------- |
| `GET /health`                               | Answers `{ "ok": true }`.                                  |
| `GET /models`                               | The catalog, as this visitor sees it.                      |
| `GET /access`                               | The chats left today, and the credit of the named balance. |
| `POST /chat`                                | One chat of the open lane, answered as server-sent events. |
| `GET /private/attestation`                  | The attestation bundle of the router, for the browser.     |
| `POST /private/attestation`                 | The attestation bundle of the privacy filter.              |
| `POST /private/v1/chat/completions`         | One sealed chat of the private lane.                       |
| `POST /private/v1/convert/file`             | One sealed document, converted to text in its enclave.     |
| `POST /private/v1/audio/transcriptions`     | One sealed recording, turned into text. A balance pays.    |
| `POST /private/v1/audio/speech`             | One sealed text, turned into speech. A balance pays.       |
| `POST /private/filter/redact`               | One sealed message for the privacy filter. A balance pays. |
| `POST /images`                              | One image of the open lane.                                |
| `POST /videos`                              | One video job of the open lane. A balance pays ahead.      |
| `GET /videos/status`, `GET /videos/content` | The state and the video of a job, named by its ticket.     |
| `GET /credit/key`                           | The public key that the app blinds its vouchers with.      |
| `POST /credit/redeem`                       | One voucher, spent into a balance.                         |
| `POST /credit/merge`                        | One balance, moved onto another of the same person.        |
| `GET`, `PUT`, `DELETE /sync/<store ID>`     | The encrypted backup of a history.                         |

`src/contract.ts` holds the shape of every request and every answer.

## Run the proxy

This section shows how to start the proxy on your own machine. You need Node.js
22.12 or later.

1. To install the dependencies, run `npm ci`.
2. To set the environment, copy the names in `.env.example` into env files of
   your own. The proxy stops at startup and names each variable that is missing.
3. To start the proxy with every model open, run `npm run dev`. To start it with
   the limits of the free trial, run `npm run dev:trial`.

The scripts of `package.json` read the API keys from `../../secret/`, the layout
of the workspace of Thinkr. On another layout, pass your own env files with
`--env-file`. The proxy listens on `127.0.0.1:8787`.

| Variable                  | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`      | The API key of OpenRouter.                                            |
| `TINFOIL_API_KEY`         | The API key of Tinfoil.                                               |
| `ACCESS_MODE`             | `full` for every model, or `trial` for the limits of the trial.       |
| `CLIENT_ADDRESS_HEADER`   | Optional. The header with the IP address, such as `CF-Connecting-IP`. |
| `VOUCHER_PUBLIC_KEY_FILE` | The public key of the vouchers (RSA, PEM) that the issuer signs.      |
| `TICKET_KEY_FILE`         | 32 random bytes in base64url, which seal the tickets of video jobs.   |
| `DATABASE_FILE`           | The SQLite file of the spent vouchers and the balances.               |

## Limits

This section lists what the proxy does not do.

- The proxy cannot prove to a user that it runs this code. The private lane does
  not depend on the proxy: the browser verifies the enclave itself.
- The open lane trusts OpenRouter and its providers. Zero data retention is a
  promise of each provider, not a property that a user can verify.
- A restart of the proxy resets the counts of the free trial.

## Development

This section lists the commands for work on the proxy.

- To run the formatter, the linter, the type checker, and the tests, run
  `npm run check`.
- To check the types of the build alone, run
  `npx tsc -p tsconfig.build.json --noEmit`. The tests declare types that the
  build does not have, so `npm run check` can pass while the build fails.
- To build the proxy into `dist/`, run `npm run build`.

## License

The Apache License 2.0. The full text is in `LICENSE`.

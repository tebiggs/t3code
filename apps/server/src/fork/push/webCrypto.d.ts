import type * as NodeCrypto from "node:crypto";

declare global {
  // infra/relay's WebCrypto service names the Workers type; Node's types declare only the value.
  interface SubtleCrypto extends NodeCrypto.webcrypto.SubtleCrypto {}
}
